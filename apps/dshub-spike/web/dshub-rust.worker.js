// dshub-rust.worker.js — the Rust hub (wasm) as a browser *SharedWorker*.
//
// One instance per (origin + SharedWorker name = appName). Every tab of the app
// connects a MessagePort and is served by the SAME hub: one wasm module, one
// upstream STOMP feed per datasource, one shared cache. Mirrors the native
// sidecar (one Hub, many Endpoints) — here each port is a session.
//
//   port control    → engine.on_control(sid, …) → post that port's replies
//   setInterval      → engine.tick()             → route each session's pushes
//   upstream STOMP   → flatten → engine.apply_message_json  (shared cache, once)
//
// Teardown: SharedWorker gives no port-close event, so the client HEARTBEATS
// ({type:'ping'}); a reaper drops sessions idle past HEARTBEAT_TIMEOUT_MS. A
// clean unmount also sends {type:'bye'} for immediate teardown.

import init, { RustHub } from '/hub-rust/pkg/dshub.js';
import { StompAdapter } from '/packages/dshub-worker/src/adapters/stomp.mjs';

const TICK_MS = 100; // delivery-conflation window (config conflation.defaultIntervalMs)
const HEARTBEAT_TIMEOUT_MS = 15000; // ~3 missed 5s pings → reap the session
let engine = null;
let positions = null;
let connection = null;

const ports = new Map(); // sessionId → { port, lastSeen }
const feeds = new Map(); // datasourceId → { adapter, live } — ONE upstream feed per datasource, shared
const snapshotCache = new Map(); // datasourceId → { revision, str, builtAt } — memoized CSRM snapshot
const SNAPSHOT_TTL_MS = 2000; // reuse a snapshot for up to 2s; each client's delta stream catches it up
let nextSid = 1;

const now = () => Date.now();

// CSRM snapshot: a COLUMN-MAJOR dump of the whole cache, built ONCE per revision
// and shared by every requesting client (the shared cache → shared artifact). Each
// client's row-delta stream is rewound to the snapshot revision, so it then receives
// exactly the changes after it — no gap, idempotent catch-up.
function handleSnapshot(sid, port, msg) {
  const ref = msg.ref || {};
  const dsId = ref.datasourceId;
  if (!dsId) { port.postMessage({ id: msg.id, type: 'snapshot', error: 'missing ref' }); return; }
  const paramsJson = JSON.stringify(ref.params || {});
  let entry = snapshotCache.get(dsId);
  const t = now();
  if (!entry || t - entry.builtAt > SNAPSHOT_TTL_MS) {
    const str = engine.snapshot_columns(dsId, paramsJson); // built once, memoized below
    const m = str.slice(0, 80).match(/"revision":(\d+)/); // read revision off the head, no full parse
    entry = { revision: m ? Number(m[1]) : 0, str, builtAt: t };
    snapshotCache.set(dsId, entry);
  }
  // Rewind the SHARED stream to the snapshot revision so this joiner has no gap;
  // existing clients re-apply current values (idempotent). One rewind covers all
  // near-simultaneous joins that shared this memoized snapshot.
  engine.rewind_shared_delta(dsId, paramsJson, BigInt(entry.revision));
  port.postMessage({ id: msg.id, type: 'snapshot', revision: entry.revision, payload: entry.str });
}

// Flatten nested objects to the 372-column schema (sep '_', maxDepth 6). Arrays
// (e.g. swapLegs) aren't positions columns, so skip them; the cache ignores any
// column outside its schema anyway.
function flattenRow(node, prefix, out, depth) {
  if (depth > 6) return out;
  for (const [k, v] of Object.entries(node)) {
    const col = prefix ? `${prefix}_${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flattenRow(v, col, out, depth + 1);
    else if (!Array.isArray(v)) out[col] = v; // scalar or explicit null
  }
  return out;
}

const booted = boot();
async function boot() {
  await init();
  engine = RustHub.new();

  const artifact = await (await fetch('/packages/dshub-spec/corpus/positions/artifact.json')).json();
  const bundle = await (await fetch('/packages/dshub-spec/examples/positions-stomp.config.json')).json();
  positions = (bundle.datasources || []).find((d) => d.id === 'positions') || {};
  connection = (bundle.connections || []).find((c) => c.id === positions.connectionRef) || {};

  const cfg = {
    id: 'positions',
    schemaRef: positions.schemaRef || 'positions@v1',
    keyColumns: artifact.keyColumns || ['positionId'],
    columns: (artifact.columns || []).map((c) => ({ name: c.column || c.name, type: c.type })),
    connection,
    snapshot: positions.snapshot,
    updates: positions.updates,
    opField: positions.opField,
  };
  engine.boot_datasource(JSON.stringify(cfg));
}

// Start ONE upstream feed per datasource, shared by every session subscribed to it.
// (Demo: one params set per datasource; a general hub would key feeds by cache key.)
function startIngestOnce(ref) {
  const dsId = ref.datasourceId;
  if (feeds.has(dsId)) return;
  const params = ref.params || {};
  const paramsJson = JSON.stringify(params);
  const feed = { adapter: null, live: false, paramsJson };
  feeds.set(dsId, feed);
  feed.adapter = new StompAdapter({
    connection,
    datasource: { snapshot: positions.snapshot, updates: positions.updates },
    params,
    openSocket: (url) => new WebSocket(url),
    onRows: (rows) => {
      const flat = rows.map((r) => flattenRow(r, '', {}, 1));
      engine.apply_message_json(dsId, paramsJson, JSON.stringify(flat));
    },
    onState: (state) => {
      if (state === 'live') { feed.live = true; broadcast({ type: 'state', state: 'live' }); }
    },
  });
  feed.adapter.connect();
}

// Single-datasource demo: broadcast to every port. (General case would track
// which ports subscribed to which key and target only those.)
function broadcast(msg) {
  for (const { port } of ports.values()) port.postMessage(msg);
}

function teardown(sid) {
  const rec = ports.get(sid);
  if (!rec) return;
  ports.delete(sid);
  if (engine) {
    let freed = [];
    try { freed = JSON.parse(engine.disconnect(sid)); } catch { /* already gone */ }
    // A freed cache key `datasourceId#<params>` means its last subscriber left —
    // stop that datasource's upstream feed so we don't stream into a dropped cache.
    for (const key of freed) {
      const dsId = key.split('#')[0];
      const feed = feeds.get(dsId);
      if (feed) { try { feed.adapter?.closeTransport(); } catch { /* ignore */ } feeds.delete(dsId); }
    }
  }
  try { rec.port.close?.(); } catch { /* ignore */ }
}

function handlePortMessage(sid, port, msg) {
  const rec = ports.get(sid);
  if (rec) rec.lastSeen = now(); // any message is a heartbeat
  if (msg?.type === 'poll') { runTick(); return; } // visible tab drives realtime delivery (+ heartbeat)
  if (msg?.type === 'ping') return;             // heartbeat only — not a control message
  if (msg?.type === 'bye') { teardown(sid); return; } // clean unmount
  if (!engine) return;                           // pre-boot (client waits for `ready`)
  if (msg?.type === 'snapshot') { handleSnapshot(sid, port, msg); return; } // CSRM columnar snapshot
  if (msg?.type === 'debug') {                    // introspection: who is this hub serving?
    port.postMessage({ id: msg.id, type: 'debug', payload: {
      sessionCount: engine.session_count(), mySessionId: sid, stats: JSON.parse(engine.mem_stats()),
    } });
    return;
  }

  const out = JSON.parse(engine.on_control(sid, JSON.stringify(msg)));
  for (const m of out) port.postMessage(m);

  if (msg?.type === 'subscribe' && msg?.ref?.datasourceId) {
    startIngestOnce(msg.ref);
    // A late subscriber joins an already-live datasource → send it `live` now
    // (the STOMP adapter only fires `live` once, when the snapshot first loads).
    if (feeds.get(msg.ref.datasourceId)?.live) port.postMessage({ type: 'state', state: 'live' });
  }
}

// One MessagePort per connecting tab.
self.onconnect = (e) => {
  const port = e.ports[0];
  const sid = `s${nextSid++}`;
  ports.set(sid, { port, lastSeen: now() });
  port.onmessage = (ev) => handlePortMessage(sid, port, ev.data);
  port.start();
  booted.then(() => {
    engine.connect(sid);
    port.postMessage({ type: 'result', payload: { ready: true, engine: 'rust-wasm' } });
  });
};

// Poll every session's deltas and route each to its port. Coalesced so multiple
// tabs polling at once don't over-tick.
let lastTick = 0;
const MIN_TICK_MS = 90; // ~10Hz cap: many tabs each polling 100ms coalesce to one tick, not N
function runTick() {
  if (!engine) return;
  const t = now();
  if (t - lastTick < MIN_TICK_MS) return;
  lastTick = t;

  // 1) Per-session GROUP deltas (SSRM) — each client groups differently.
  const perSession = JSON.parse(engine.tick());
  for (const { sessionId, messages } of perSession) {
    const rec = ports.get(sessionId);
    if (!rec) continue;
    for (const m of messages) {
      // SsrmMode.onGroupDelta reads `changed` with CLEAN-value paths; the hub
      // sends `groups` with type-tagged `path` + clean `values`. Bridge it.
      if (m.type === 'groupDelta' && Array.isArray(m.groups)) {
        m.changed = m.groups.map((g) => ({ path: g.values ?? g.path }));
      }
      rec.port.postMessage(m);
    }
  }

  // 2) ONE shared ROW delta per datasource → broadcast to every client. Built once
  // regardless of client count (O(1)), which is what lets many tabs stay realtime.
  for (const [dsId, feed] of feeds) {
    const dstr = engine.poll_shared_delta(dsId, feed.paramsJson);
    if (!dstr) continue;
    const m = JSON.parse(dstr); // parse ONCE, not per client
    for (const { port } of ports.values()) port.postMessage(m);
  }
}

// A SharedWorker's own timers get throttled to ~1 Hz regardless of client
// visibility, so this interval is only a background fallback — realtime delivery
// is driven by `{type:'poll'}` from each VISIBLE tab (whose page timers run at full
// rate). Any tab's poll flushes ALL sessions, so one foreground tab keeps the
// others current too.
setInterval(runTick, TICK_MS);

// Reap sessions that stopped heartbeating (closed/crashed tabs).
setInterval(() => {
  const cutoff = now() - HEARTBEAT_TIMEOUT_MS;
  for (const [sid, rec] of ports) if (rec.lastSeen < cutoff) teardown(sid);
}, 5000);
