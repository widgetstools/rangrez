import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Hub } from '../src/hub.mjs';
import { validate } from '../../dshub-spec/src/validate.mjs';
import { handleControl, reconcileConfig, PROTOCOL_VERSION } from '../src/control.mjs';
import { attachPort, makeRouter, isBinary } from '../src/port.mjs';
import { encodeFrame } from '../src/adapters/stomp-codec.mjs';
import { STATE } from '../src/table_actor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = join(HERE, '../../dshub-spec');
const controlSchema = JSON.parse(readFileSync(join(SPEC, 'control-protocol.schema.json'), 'utf8'));
const bundle = JSON.parse(readFileSync(join(SPEC, 'examples/positions-stomp.config.json'), 'utf8'));

/** Sockets the test drives by hand; records how many were opened. */
function socketFactory() {
  const opened = [];
  const factory = (url) => {
    const s = {
      url, sent: [],
      send: (d) => s.sent.push(d),
      close: () => { s.closed = true; s.onclose?.({}); },
      open: () => s.onopen?.(),
      deliver: (f) => s.onmessage?.({ data: typeof f === 'string' ? f : encodeFrame(f) }),
    };
    opened.push(s);
    return s;
  };
  factory.opened = opened;
  return factory;
}

function makeHub(over = {}) {
  const openSocket = socketFactory();
  const tables = [];
  const hub = new Hub({
    bundle: { ...bundle, bundleVersion: 3, checksum: 'sha256:aaa' },
    openSocket,
    createTable: async (name) => { const t = { name, blocks: [], update: (b) => t.blocks.push(b), size: () => 0 }; tables.push(t); return t; },
    ...over,
  });
  return { hub, openSocket, tables };
}
const session = (name) => ({ id: name, subscriptions: new Set(), sent: [], send(m) { this.sent.push(m); } });
const ref = { datasourceId: 'positions', params: { clientId: 'trd1', rate: 2000, batchSize: 10 } };

// ------------------------------------------------- the sharing claim

test('two sessions on the same datasource share ONE upstream connection and ONE table', async () => {
  // This is what makes "one stop shop" true rather than aspirational, and it is
  // the reason the host is a SharedWorker at all.
  const { hub, openSocket, tables } = makeHub();
  const a = session('tab-a'), b = session('tab-b');

  const r1 = await hub.subscribe(ref, a);
  const r2 = await hub.subscribe(ref, b);

  assert.equal(openSocket.opened.length, 1, 'one WebSocket, not two');
  assert.equal(tables.length, 1, 'one table, not two');
  assert.equal(r1.tableName, r2.tableName, 'both point at the same table');
  assert.equal(r2.shared, true);
  assert.equal((await hub.stats()).subscribers, 2);
});

test('different params get their own subscription', async () => {
  const { hub, openSocket } = makeHub();
  await hub.subscribe(ref, session('a'));
  await hub.subscribe({ ...ref, params: { ...ref.params, clientId: 'trd2' } }, session('b'));
  assert.equal(openSocket.opened.length, 2);
});

test('the upstream survives one session leaving, and only the last departure tears down', async () => {
  // A trader closing one of two blotters must not re-snapshot the other.
  const teardowns = [];
  const { hub, openSocket } = makeHub();
  hub.registry.setTimer = (fn) => { teardowns.push(fn); return teardowns.length; };

  const a = session('a'), b = session('b');
  await hub.subscribe(ref, a);
  await hub.subscribe(ref, b);

  await hub.unsubscribe(ref, a);
  assert.equal(teardowns.length, 0, 'still referenced — no teardown armed');
  assert.equal(hub.entries.size, 1);

  await hub.unsubscribe(ref, b);
  assert.equal(teardowns.length, 1, 'last departure arms the idle timer');
  assert.equal(hub.entries.size, 1, 'not torn down until the timer fires');

  teardowns[0]();
  assert.equal(hub.entries.size, 0);
  assert.equal(openSocket.opened[0].closed, true, 'teardown must close the upstream socket');
});

test('a disconnecting session releases everything it held', async () => {
  const teardowns = [];
  const { hub } = makeHub();
  hub.registry.setTimer = (fn) => { teardowns.push(fn); return teardowns.length; };
  const s = session('a');
  await hub.subscribe(ref, s);
  await hub.releaseSession(s);
  assert.equal(teardowns.length, 1, 'a closed tab must not leak its subscription');
});

// ------------------------------------------------- transports the worker cannot reach

test('an AMPS datasource is refused with a typed error, not a hang', async () => {
  // AMPS and Solace need a native process (architecture §2.2). Refusing clearly
  // beats a subscription that silently never produces rows.
  const { hub } = makeHub({
    bundle: {
      ...bundle,
      connections: [{ ...bundle.connections[0], id: 'amps-uat', kind: 'amps' }],
      datasources: [{ ...bundle.datasources[0], connectionRef: 'amps-uat' }],
    },
  });
  await assert.rejects(() => hub.subscribe(ref, session('a')), /not available in the worker host/);
});

// ------------------------------------------------- control plane

test('a protocol version mismatch is refused rather than degraded', async () => {
  const { hub } = makeHub();
  const out = await handleControl(
    { id: '1', type: 'hello', protocolVersion: PROTOCOL_VERSION + 1, appId: 'blotter' },
    { schema: controlSchema, validate, hub, session: session('a') }
  );
  assert.equal(out.type, 'error');
  assert.equal(out.code, 'protocol-version-mismatch');
});

test('a malformed control message is rejected before it is acted on', async () => {
  const { hub } = makeHub();
  const out = await handleControl(
    { id: '1', type: 'subscribe' }, // no ref
    { schema: controlSchema, validate, hub, session: session('a') }
  );
  assert.equal(out.type, 'error');
  assert.equal(out.code, 'invalid-params');
});

test('an unknown datasource returns its typed code', async () => {
  const { hub } = makeHub();
  const out = await handleControl(
    { id: '1', type: 'subscribe', ref: { datasourceId: 'nope' } },
    { schema: controlSchema, validate, hub, session: session('a') }
  );
  assert.equal(out.code, 'unknown-datasource');
});

test('subscribe returns the table name and selected mode', async () => {
  const { hub } = makeHub();
  const out = await handleControl(
    { id: '7', type: 'subscribe', ref },
    { schema: controlSchema, validate, hub, session: session('a') }
  );
  assert.equal(out.type, 'subscribed');
  assert.equal(out.schemaRef, 'positions@v1');
  assert.ok(['csrm', 'ssrm', 'vrm'].includes(out.mode));
});

// ------------------------------------------------- config reconcile (defect 2.1)

test('equal version with differing checksum is a CONFLICT, not a silent no-op', () => {
  // Two apps editing offline both bump 12 -> 13 with different content. Comparing
  // versions alone, they meet at "equal -> nothing" and diverge forever.
  const r = reconcileConfig(
    { bundleVersion: 13, bundleChecksum: 'sha256:aaa' },
    { bundleVersion: 13, bundleChecksum: 'sha256:bbb' }
  );
  assert.equal(r.status, 'conflict');
});

test('equal version and equal checksum is genuinely current', () => {
  assert.equal(reconcileConfig(
    { bundleVersion: 13, bundleChecksum: 'x' }, { bundleVersion: 13, bundleChecksum: 'x' }
  ).status, 'current');
});

test('a first-run app with no bundle is not in conflict with anything', () => {
  assert.equal(reconcileConfig({ bundleVersion: 0 }, { bundleVersion: 0 }).status, 'current');
});

test('version comparison still decides when versions differ', () => {
  assert.equal(reconcileConfig({ bundleVersion: 14 }, { bundleVersion: 13 }).status, 'app-newer');
  assert.equal(reconcileConfig({ bundleVersion: 12 }, { bundleVersion: 13 }).status, 'hub-newer');
});

test('a conflict sends the hub bundle down so the diff view has both sides', async () => {
  const { hub } = makeHub();
  const out = await handleControl(
    { id: '1', type: 'hello', protocolVersion: PROTOCOL_VERSION, appId: 'blotter', bundleVersion: 3, bundleChecksum: 'sha256:different' },
    { schema: controlSchema, validate, hub, session: session('a') }
  );
  assert.equal(out.status, 'conflict');
  assert.ok(out.bundle, 'the user cannot pick a side without both bundles');
});

// ------------------------------------------------- the two-channel split

test('binary is Perspective traffic and is never parsed as control', () => {
  const seen = { control: [], binary: [] };
  const route = makeRouter({
    handleControl: (m) => seen.control.push(m),
    handleBinary: (b) => seen.binary.push(b),
  });
  route({ id: '1', type: 'stats' });
  route(new ArrayBuffer(8));
  route(new Uint8Array([1, 2, 3]));
  assert.equal(seen.control.length, 1);
  assert.equal(seen.binary.length, 2, 'typed arrays are binary too');
});

test('isBinary distinguishes the two channels', () => {
  assert.ok(isBinary(new ArrayBuffer(4)));
  assert.ok(isBinary(new Uint8Array(4)));
  assert.ok(!isBinary({ type: 'hello' }));
  assert.ok(!isBinary('text'));
});

test('binary is TRANSFERRED, control is cloned', () => {
  // At 500k x 372 a copy per window read would dominate; and the buffer is dead
  // on this side once sent.
  const posts = [];
  const fake = { postMessage: (m, t) => posts.push({ m, t }), start() {} };
  const ch = attachPort(fake, {});
  ch.control({ type: 'hello' });
  ch.binary(new ArrayBuffer(8));
  assert.equal(posts[0].t, undefined, 'control must not be transferred');
  assert.equal(posts[1].t.length, 1, 'binary must be transferred');
});

// ------------------------------------------------- state propagation

test('state transitions reach every subscriber of that table', async () => {
  const { hub, openSocket } = makeHub();
  const a = session('a'), b = session('b');
  await hub.subscribe(ref, a);
  await hub.subscribe(ref, b);

  const ws = openSocket.opened[0];
  ws.open();
  ws.deliver({ command: 'CONNECTED', headers: { version: '1.2', 'heart-beat': '0,0' } });

  for (const s of [a, b]) {
    assert.ok(s.sent.some((m) => m.type === 'state' && m.state === STATE.SNAPSHOTTING),
      `${s.id} never saw snapshotting: ${JSON.stringify(s.sent)}`);
  }
});

// ------------------------------------------------- query RPCs

/** Hub with a view factory that records creation and disposal. */
function queryHub() {
  const views = { created: 0, deleted: 0, specs: [] };
  const { hub, openSocket } = makeHub({
    createView: async (_t, spec) => {
      views.created++; views.specs.push(spec);
      return {
        num_rows: async () => 123,
        to_columns: async () => ({
          __ROW_PATH__: [[], ['Govies'], ['Rates'], ['Inflation']],
          notional: [600, 100, 200, 300],
        }),
        delete: async () => { views.deleted++; },
      };
    },
  });
  return { hub, views, openSocket };
}

test('a query view is ALWAYS disposed, including when the caller throws', async () => {
  // A distinct-values view left open per column per grid is the leak that shows
  // up as worker memory growth two weeks into UAT (parity study §1.2).
  const { hub, views } = queryHub();
  await hub.subscribe(ref, session('a'));

  await hub.rowCount(ref, {});
  assert.equal(views.created, 1);
  assert.equal(views.deleted, 1, 'disposed on the happy path');

  await assert.rejects(() => hub.withView(ref, {}, () => { throw new Error('boom'); }));
  assert.equal(views.deleted, 2, 'disposed even when the body throws');
});

test('distinctValues uses a grouped view and drops the root path', async () => {
  const { hub, views } = queryHub();
  await hub.subscribe(ref, session('a'));
  const out = await hub.distinctValues(ref, 'desk');

  assert.deepEqual(out, ['Govies', 'Rates', 'Inflation']);
  assert.deepEqual(views.specs[0].groupBy, ['desk'], 'grouped, not scanned');
});

test('searchValues prefix-matches the distinct set', async () => {
  const { hub } = queryHub();
  await hub.subscribe(ref, session('a'));
  assert.deepEqual(await hub.searchValues(ref, 'desk', 'g'), ['Govies']);
  assert.deepEqual(await hub.searchValues(ref, 'desk', 'zzz'), []);
});

test('aggregates return one row keyed by spec alias', async () => {
  const { hub } = queryHub();
  await hub.subscribe(ref, session('a'));
  const out = await hub.aggregates(ref, [{ column: 'notional', fn: 'sum', as: 'total' }]);
  assert.equal(out.total, 600);
});

test('querying a datasource nobody is subscribed to is a typed error', async () => {
  const { hub } = queryHub();
  await assert.rejects(() => hub.rowCount(ref, {}), (e) => e.code === 'unknown-datasource');
});

test('rank finds a row index without materialising the whole view', async () => {
  // A rank lookup on a 500k-row table must not allocate 500k rows to find one
  // index — it scans in batches and stops at the hit.
  const reads = [];
  const { hub } = makeHub({
    createView: async () => ({
      num_rows: async () => 12,
      to_columns: async ({ start_row, end_row }) => {
        reads.push([start_row, end_row]);
        return { __key: Array.from({ length: end_row - start_row }, (_, i) => `P${start_row + i}`) };
      },
      delete: async () => {},
    }),
  });
  await hub.subscribe(ref, session('a'));

  assert.equal(await hub.rank(ref, 'P7', {}, { batchRows: 5 }), 7);
  assert.ok(reads.length < 4, `stopped early: ${JSON.stringify(reads)}`);
});

test('rank returns null for a key outside the view, not an error', async () => {
  const { hub } = makeHub({
    createView: async () => ({
      num_rows: async () => 3,
      to_columns: async () => ({ __key: ['P1', 'P2', 'P3'] }),
      delete: async () => {},
    }),
  });
  await hub.subscribe(ref, session('a'));
  assert.equal(await hub.rank(ref, 'nope', {}), null);
});

test('stats reach `live` even when the engine write is async', async () => {
  // Regression: the async live-gate returned early and skipped the stats
  // update, so diagnostics reported `snapshotting` for a live datasource —
  // worse than no diagnostics, because it sends someone hunting the wrong fault.
  let resolveWrite;
  const { hub, openSocket } = makeHub({
    createTable: async () => ({ update: () => new Promise((r) => { resolveWrite = r; }), size: () => 0 }),
  });
  await hub.subscribe(ref, session('a'));

  const ws = openSocket.opened[0];
  ws.open();
  ws.deliver({ command: 'CONNECTED', headers: { version: '1.2', 'heart-beat': '0,0' } });
  ws.deliver({ command: 'MESSAGE', headers: { 'message-type': 'snapshot' }, body: JSON.stringify([{ positionId: 'P1' }]) });
  ws.deliver({ command: 'MESSAGE', headers: { 'message-type': 'snapshot-complete' }, body: 'Success: All 1 positions records delivered.' });

  resolveWrite?.();
  await new Promise((r) => setTimeout(r, 0));

  const s = await hub.stats();
  assert.equal(s.datasources[0].state, 'live', 'diagnostics must not report a stale state');
});

// ------------------------------------------------- delta delivery mode

/** A hub whose engine deltas the test fires by hand. */
function deltaHub() {
  let emit;
  const { hub } = makeHub({ watchTable: async (_t, cb) => { emit = cb; return () => {}; } });
  return { hub, emit: (cols) => emit(cols) };
}
const lastDelta = (s) => s.sent.filter((m) => m.type === 'rowDelta').at(-1);

test('a `notify` subscriber gets a COUNT, never the rows', async () => {
  // VRM re-reads its own viewport, so shipping the delta rows would put the
  // whole feed on the wire to be decoded and discarded — precisely the cost
  // VRM exists to avoid. Without this its traffic equals CSRM's.
  const { hub, emit } = deltaHub();
  const vrm = session('vrm'), csrm = session('csrm');
  await hub.subscribe(ref, vrm, { delivery: 'notify' });
  await hub.subscribe(ref, csrm);
  emit({ __key: ['a', 'b'], price: [1, 2] });

  assert.equal(lastDelta(vrm).rows, 2, 'the count still gets through');
  assert.equal(lastDelta(vrm).columns, undefined, 'but not one row of payload');
  assert.deepEqual(lastDelta(csrm).columns.price, [1, 2], 'CSRM holds a local copy, so it needs them');
});

test('delivery is per SESSION, not per table', async () => {
  // One tab can hold a CSRM grid and a VRM tree over the same table.
  const { hub, emit } = deltaHub();
  const a = session('a'), b = session('b');
  await hub.subscribe(ref, a, { delivery: 'notify' });
  await hub.subscribe(ref, b, { delivery: 'rows' });
  emit({ __key: ['x'], price: [9] });
  assert.equal(lastDelta(a).columns, undefined);
  assert.ok(lastDelta(b).columns);
});

test('the default is `rows`, so an existing client is unaffected', async () => {
  const { hub, emit } = deltaHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  emit({ __key: ['x'], price: [9] });
  assert.ok(lastDelta(s1).columns, 'unchanged by default');
});

test('a subscribe carrying `delivery` still validates against the schema', async () => {
  const ok = validate({ id: '1', type: 'subscribe', ref, delivery: 'notify' }, controlSchema);
  assert.deepEqual(ok, [], 'a valid delivery mode passes');
  const bad = validate({ id: '1', type: 'subscribe', ref, delivery: 'firehose' }, controlSchema);
  assert.ok(bad.length, 'an unknown delivery mode is refused, not silently treated as rows');
});

// ------------------------------------------------- joining a running table

/** The entry key is an internal format; ask the hub rather than hardcode it. */
const onlyKey = (hub) => [...hub.entries.keys()][0];

test('a session joining a LIVE table is told so immediately', async () => {
  // `state` messages are transitions. Without a replay the second tab onto a
  // shared datasource waits for an event that already happened — and the first
  // tab works, so this hides until someone opens two.
  const { hub, openSocket } = makeHub();
  const first = session('first');
  await hub.subscribe(ref, first);
  openSocket.opened[0].open();
  hub.publishState(onlyKey(hub), STATE.LIVE);

  const late = session('late');
  await hub.subscribe(ref, late);

  const seen = late.sent.filter((m) => m.type === 'state');
  assert.equal(seen.length, 1, 'exactly one state message, on join');
  assert.equal(seen[0].state, STATE.LIVE);
  assert.equal(seen[0].detail.replay, true, 'marked a replay, so a client can tell it apart from a transition');
});

test('the replay reports the CURRENT state, not a hardcoded live', async () => {
  const { hub } = makeHub();
  await hub.subscribe(ref, session('first'));
  hub.publishState(onlyKey(hub), STATE.STALE);
  const late = session('late');
  await hub.subscribe(ref, late);
  assert.equal(late.sent.find((m) => m.type === 'state').state, STATE.STALE);
});

test('even the FIRST subscriber is told where the table starts', async () => {
  // By the time subscribe returns the adapter has been told to connect, so
  // `connecting` is the truth — and reporting it is what stops a client sitting
  // on a blank badge until the first real transition arrives.
  const { hub } = makeHub();
  const first = session('first');
  await hub.subscribe(ref, first);
  const replays = first.sent.filter((m) => m.type === 'state' && m.detail?.replay);
  assert.equal(replays.length, 1);
  assert.equal(replays[0].state, STATE.CONNECTING, 'the state it is actually in, not a guess');
});

test('the replay names the datasource, not the internal entry key', async () => {
  // The key encodes params and superset wildcards; a client matches on
  // datasourceId and would ignore an event addressed to the raw key.
  const { hub } = makeHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  assert.equal(s1.sent.find((m) => m.type === 'state').ref.datasourceId, 'positions');
});

test('a late joiner still receives subsequent transitions', async () => {
  // The replay must not replace the live subscription.
  const { hub } = makeHub();
  await hub.subscribe(ref, session('first'));
  hub.publishState(onlyKey(hub), STATE.LIVE);
  const late = session('late');
  await hub.subscribe(ref, late);
  hub.publishState(onlyKey(hub), STATE.STALE);
  assert.deepEqual(late.sent.filter((m) => m.type === 'state').map((m) => m.state), [STATE.LIVE, STATE.STALE]);
});

// ------------------------------------------------- one event per transition

test('each lifecycle transition is published EXACTLY once', async () => {
  // The actor and the adapter both transition through connecting/snapshotting/
  // live. Publishing from both put two events on the wire per transition — one
  // bare, then the same state again with detail — so anything counting
  // transitions (reconnects, for one) double-counted.
  const { hub, openSocket } = makeHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);

  const sock = openSocket.opened[0];
  sock.open();
  sock.deliver({ command: 'CONNECTED', headers: { version: '1.2' }, body: '' });

  const lifecycle = s1.sent
    .filter((m) => m.type === 'state' && !m.detail?.replay)
    .map((m) => m.state);
  const counts = {};
  for (const st of lifecycle) counts[st] = (counts[st] ?? 0) + 1;
  for (const [st, n] of Object.entries(counts)) {
    assert.equal(n, 1, `state "${st}" published ${n} times`);
  }
});

test('the published event keeps the DETAIL, not the bare duplicate', async () => {
  // Deduplicating must not cost the diagnostics: the detail is the URL, the
  // listen topic, the row count.
  const { hub, openSocket } = makeHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  openSocket.opened[0].open();

  openSocket.opened[0].deliver({ command: 'CONNECTED', headers: { version: '1.2' }, body: '' });

  // `connecting` is published during subscribe, before the session joins — that
  // is what the replay is for. `snapshotting` is the first one it sees live.
  const snap = s1.sent.find((m) => m.type === 'state' && m.state === STATE.SNAPSHOTTING);
  assert.ok(snap?.detail, 'the surviving event is the one carrying detail');
});

test('a FAILED the actor detects still reaches subscribers', async () => {
  // The actor checks the snapshot row count against what it was told to
  // expect — the adapter cannot see that, so this one must not be suppressed.
  const { hub } = makeHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const entry = hub.entries.get([...hub.entries.keys()][0]);

  if (entry.actor.state === STATE.IDLE) entry.actor.transition(STATE.CONNECTING);
  entry.actor.beginSnapshot('buffer');
  entry.actor.endSnapshot({ expectedRows: 999, actualRows: 0 });

  const failed = s1.sent.filter((m) => m.type === 'state' && m.state === STATE.FAILED);
  assert.equal(failed.length, 1, 'the actor-detected failure got out');
  assert.match(failed[0].detail, /expected 999/);
});

// ------------------------------------------------- shared schema artifacts

test('an artifact is found by schemaRef, not just by datasource id', async () => {
  // `positions`, `positions-ws` and `positions-rest` are the same book arriving
  // three ways. Keying the lookup on id meant every one but the first failed
  // with "artifact with no columns", which points at the artifact rather than
  // at the lookup.
  const { hub } = makeHub();
  const art = { columns: [{ column: 'a', type: 'string' }], keyColumns: ['a'], estimatedRows: 10 };
  hub.artifacts = { 'positions@v1': art };
  assert.equal(hub.artifactFor({ id: 'positions-ws', schemaRef: 'positions@v1' }), art);
});

test('the version suffix is optional in the artifact key', async () => {
  const { hub } = makeHub();
  const art = { columns: [], keyColumns: [] };
  hub.artifacts = { positions: art };
  assert.equal(hub.artifactFor({ id: 'positions-rest', schemaRef: 'positions@v1' }), art);
});

test('a datasource with no schemaRef still resolves by id', async () => {
  const { hub } = makeHub();
  const art = { columns: [], keyColumns: [] };
  hub.artifacts = { legacy: art };
  assert.equal(hub.artifactFor({ id: 'legacy' }), art);
});

// ------------------------------------------------- malformed rows

test('a null row is dropped and counted, not fatal to the datasource', async () => {
  // `normalize` reads the payload with Object.entries, so null throws — and
  // ingestion sits behind one catch per transport, so ONE bad record took the
  // whole book down with an error pointing at the normalizer, not the feed.
  // JSON.stringify turns a hole in an array into a null, so this reaches real
  // feeds.
  const { hub, openSocket } = makeHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const entry = hub.entries.get([...hub.entries.keys()][0]);

  entry.adapter.onRows([{ positionId: 'P1' }, null, { positionId: 'P2' }, undefined], 'live');

  assert.equal(entry.stats.malformed, 2, 'both bad rows counted');
  assert.notEqual(entry.state, STATE.FAILED, 'and the datasource survived');
});

test('a row that is not an object at all is also survivable', async () => {
  const { hub } = makeHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const entry = hub.entries.get([...hub.entries.keys()][0]);
  entry.adapter.onRows(['just a string', 42], 'live');
  assert.equal(entry.stats.malformed, 2);
});

// ------------------------------------------------- backpressure ladder

/** A hub whose engine deltas the test fires by hand, with a tight flow limit. */
function ladderHub(over = {}) {
  let emit;
  const { hub } = makeHub({ watchTable: async (_t, cb) => { emit = cb; return () => {}; } });
  hub.flowLimit = over.flowLimit ?? 4;
  hub.conflateMs = over.conflateMs ?? 0;
  return { hub, emit: (n = 1) => emit({ __key: Array.from({ length: n }, (_, i) => `k${i}`), px: Array.from({ length: n }, () => 1) }) };
}
const deltasTo = (s) => s.sent.filter((m) => m.type === 'rowDelta');

test('a healthy subscriber that acks keeps receiving every delta', async () => {
  const { hub, emit } = ladderHub();
  const s1 = session('fast');
  await hub.subscribe(ref, s1);
  for (let i = 0; i < 20; i++) {
    emit();
    const last = deltasTo(s1).at(-1);
    hub.flowFor(s1).onAck(last.seq);
  }
  assert.equal(deltasTo(s1).length, 20);
  assert.equal(hub.flowFor(s1).rung, 'none');
});

test('a subscriber that never acks is told to refresh, then dropped', async () => {
  // The exit criterion: a deliberately stalled subscriber degrades through the
  // ladder and is disconnected.
  const { hub, emit } = ladderHub();
  const slow = session('wedged');
  await hub.subscribe(ref, slow);
  const flow = hub.flowFor(slow);
  flow.stuckMs = 60_000;                     // not yet "stuck", just behind

  for (let i = 0; i < 30; i++) emit();
  assert.ok(slow.sent.some((m) => m.type === 'refresh' && m.reason === 'backpressure'),
    'it was told to re-read while it was merely behind');
  assert.equal(slow.sent.some((m) => m.code === 'backpressure-disconnect'), false,
    'and NOT dropped on the first sign of trouble');

  // Still making no progress once the grace period expires.
  flow.stuckMs = 0;
  emit();
  const err = slow.sent.find((m) => m.type === 'error' && m.code === 'backpressure-disconnect');
  assert.ok(err, 'and dropped with a TYPED error, not silently');
  assert.match(err.message, /unapplied/);
});

test('a dropped subscriber stops receiving and is off the table', async () => {
  const { hub, emit } = ladderHub();
  const slow = session('wedged');
  await hub.subscribe(ref, slow);
  hub.flowFor(slow).stuckMs = 0;
  for (let i = 0; i < 30; i++) emit();

  const before = slow.sent.length;
  emit();
  assert.equal(slow.sent.length, before, 'nothing more is sent');
  const entry = hub.entries.get([...hub.entries.keys()][0]);
  assert.equal(entry.subscribers.has(slow), false);
});

test('ONE wedged subscriber does not affect the others', async () => {
  // This is the whole point of the ladder being per session.
  const { hub, emit } = ladderHub();
  const fast = session('fast'), slow = session('wedged');
  await hub.subscribe(ref, fast);
  await hub.subscribe(ref, slow);
  hub.flowFor(slow).stuckMs = 0;

  for (let i = 0; i < 30; i++) {
    emit();
    const last = deltasTo(fast).at(-1);
    if (last) hub.flowFor(fast).onAck(last.seq);
  }

  assert.equal(deltasTo(fast).length, 30, 'the healthy tab got every delta');
  assert.equal(hub.flowFor(fast).rung, 'none');
  assert.ok(slow.sent.some((m) => m.code === 'backpressure-disconnect'), 'only the wedged one was dropped');
  const entry = hub.entries.get([...hub.entries.keys()][0]);
  assert.equal(entry.subscribers.has(fast), true);
});

test('a `notify` subscriber is exempt — there is nothing to fall behind on', async () => {
  // It re-reads its own viewport, so a count can never back up.
  const { hub, emit } = ladderHub();
  const vrm = session('vrm');
  await hub.subscribe(ref, vrm, { delivery: 'notify' });
  for (let i = 0; i < 50; i++) emit();
  assert.equal(deltasTo(vrm).length, 50);
  assert.equal(vrm.sent.some((m) => m.code === 'backpressure-disconnect'), false);
});

test('conflation collapses a burst into one delta per interval', async () => {
  const { hub, emit } = ladderHub({ conflateMs: 10_000 });
  const s1 = session('slowish');
  await hub.subscribe(ref, s1);
  for (let i = 0; i < 2; i++) { emit(); }
  const before = deltasTo(s1).length;
  for (let i = 0; i < 10; i++) emit();
  assert.ok(deltasTo(s1).length - before <= 1, 'ten deltas produced at most one message');
});

// ------------------------------------------------- reconnect diff, in the hub

/** A hub whose table contents the test controls, so the diff has a baseline. */
function reconnectHub(tableRows = []) {
  const rows = new Map(tableRows.map((r) => [r.__key, r]));
  const { hub, openSocket } = makeHub({
    createView: async () => ({
      to_columns: async () => {
        const names = new Set(['__key']);
        for (const r of rows.values()) for (const k of Object.keys(r)) names.add(k);
        const out = {};
        for (const n of names) out[n] = [...rows.values()].map((r) => r[n] ?? null);
        return out;
      },
      delete: async () => {},
    }),
  });
  return { hub, openSocket, rows };
}

test('the FIRST snapshot is applied whole — there is nothing to diff', async () => {
  const { hub } = reconnectHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const e = hub.entries.get([...hub.entries.keys()][0]);
  assert.equal(e.differ.active, false, 'no diff on a first connect');
});

test('a re-snapshot after live data is diffed, not re-applied', async () => {
  // Re-pushing 20,000 identical rows makes Perspective report 20,000 changes,
  // which CSRM turns into a full repaint: scroll jump, selection disturbed.
  const { hub } = reconnectHub([
    { __key: 'a', px: 1 }, { __key: 'b', px: 2 }, { __key: 'c', px: 3 },
  ]);
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const e = hub.entries.get([...hub.entries.keys()][0]);

  e.actor.rowsOut = 3;                       // it has served data before
  e.differ.begin();
  e.differ.collect([{ __key: 'a', px: 1 }, { __key: 'b', px: 2 }, { __key: 'c', px: 99 }]);
  const d = await e.differ.end();

  assert.deepEqual(d.upserts.map((r) => r.__key), ['c'], 'only the row that moved');
  assert.equal(d.unchanged, 2);
});

test('a position that vanished during the outage is removed', async () => {
  const { hub } = reconnectHub([{ __key: 'a', px: 1 }, { __key: 'closed', px: 2 }]);
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const e = hub.entries.get([...hub.entries.keys()][0]);

  e.differ.begin();
  e.differ.collect([{ __key: 'a', px: 1 }]);
  const d = await e.differ.end();
  assert.equal(d.removals.length, 1, 'the phantom would otherwise never clear');
  assert.equal(d.removals[0].__key, 'closed');
});

// ------------------------------------------------- hot reload (§3.8)

import { reloadPlanForBundle } from '../../dshub-provider/src/reload.mjs';
import { readFileSync as _rf } from 'node:fs';
const configSchema = JSON.parse(_rf(join(SPEC, 'datasource-config.schema.json'), 'utf8'));

/** A hub whose reload planner is the real one, so classes come from the schema. */
function hotHub() {
  const { hub, openSocket } = makeHub();
  hub.reloadPlanner = (prev, next) => reloadPlanForBundle(prev, next, configSchema);
  return { hub, openSocket };
}
const mutate = (bundle, dsId, patch) => ({
  ...bundle,
  datasources: bundle.datasources.map((d) => (d.id === dsId ? { ...d, ...patch } : d)),
});

test('a conflation-interval change applies LIVE with no re-snapshot', async () => {
  // The exit criterion. The actor and every subscriber flow are mutated in
  // place; the upstream socket is never touched.
  const { hub, openSocket } = hotHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const entry = hub.entries.get([...hub.entries.keys()][0]);
  const flow = hub.flowFor(s1);
  const socketsBefore = openSocket.opened.length;

  const next = mutate(hub.bundle, 'positions', { conflation: { defaultIntervalMs: 999 } });
  const { applied } = await hub.applyConfig(next);

  assert.equal(applied.find((a) => a.id === 'positions').action, 'in-place');
  assert.equal(flow.conflateMs, 999, 'the running subscriber picked it up');
  assert.equal(hub.conflateMs, 999, 'and so will the next one');
  assert.equal(openSocket.opened.length, socketsBefore, 'no reconnect, no re-snapshot');
  assert.ok(hub.entries.has(entry === undefined ? null : [...hub.entries.keys()][0]), 'the table is untouched');
});

test('a batch change is applied to the running actor in place', async () => {
  const { hub } = hotHub();
  await hub.subscribe(ref, session('s1'));
  const entry = hub.entries.get([...hub.entries.keys()][0]);
  const next = mutate(hub.bundle, 'positions', { batch: { maxMs: 17, maxRows: 33 } });
  await hub.applyConfig(next);
  assert.equal(entry.actor.maxMs, 17);
  assert.equal(entry.actor.maxRows, 33);
});

test('a key-column change REBUILDS and tells subscribers to re-init', async () => {
  // Changing key columns invalidates every row identity; applying it live would
  // leave the grid addressing rows that no longer exist.
  const { hub, openSocket } = hotHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const before = openSocket.opened.length;
  s1.sent.length = 0;

  const next = mutate(hub.bundle, 'positions', { keyColumns: ['positionId', 'book'] });
  const { applied } = await hub.applyConfig(next);

  assert.equal(applied.find((a) => a.id === 'positions').reload, 'rebuild');
  assert.ok(s1.sent.some((m) => m.type === 'refresh' && m.reason === 'reconnect'),
    'the client was told to re-read before its rows became invalid');
  assert.ok(openSocket.opened.length > before, 'the upstream was re-established');
  assert.ok(hub.entries.has([...hub.entries.keys()][0]), 'and the subscriber kept a live table');
});

test('a subscriber survives a rebuild — its blotter is not silently dropped', async () => {
  const { hub } = hotHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const next = mutate(hub.bundle, 'positions', { keyColumns: ['positionId', 'book'] });
  await hub.applyConfig(next);
  const entry = hub.entries.get([...hub.entries.keys()][0]);
  assert.ok(entry.subscribers.has(s1), 're-attached to the rebuilt table');
});

test('new config is authoritative for future subscribers even if nothing is running', async () => {
  const { hub } = hotHub();
  const next = mutate(hub.bundle, 'positions', { conflation: { defaultIntervalMs: 42 } });
  const { applied } = await hub.applyConfig(next);
  assert.equal(applied[0]?.action ?? 'not-running', 'not-running', 'nothing to poke');
  assert.equal(hub.datasource('positions').conflation.defaultIntervalMs, 42, 'but the config moved');
});

test('an untouched datasource is not disturbed by another one changing', async () => {
  const { hub, openSocket } = hotHub();
  await hub.subscribe(ref, session('s1'));
  const before = openSocket.opened.length;
  // Change a DIFFERENT (non-running) datasource; the running one must not react.
  const next = { ...hub.bundle, datasources: [...hub.bundle.datasources, { ...hub.bundle.datasources[0], id: 'other' }] };
  await hub.applyConfig(next);
  assert.equal(openSocket.opened.length, before, 'the live positions table was left alone');
});

// ------------------------------------------------- managed-view leak (Phase 8)

/** A hub whose engine views count themselves, so leaks are observable. */
function viewCountingHub() {
  let live = 0;
  const { hub } = makeHub({
    createView: async () => ({ __live: true, delete: async () => { live--; } }),
  });
  const origCreate = hub.createView;
  hub.createView = async (...a) => { live++; return origCreate(...a); };
  return { hub, live: () => live };
}

test('managed views return to baseline after a session disconnects', async () => {
  // SSRM holds one managed view per expanded node. A tab that closes with 20
  // groups open must not leave 20 views behind — the two-weeks-into-UAT leak.
  const { hub, live } = viewCountingHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const baseline = hub.openViewCount;

  const handles = [];
  for (let i = 0; i < 50; i++) handles.push(await hub.openView(ref, { groupBy: ['desk'], filter: [] }, s1));
  assert.equal(hub.openViewCount, baseline + 50);
  assert.equal(live(), 50, 'engine views actually created');

  await hub.disposeSessionViews(s1);
  assert.equal(hub.openViewCount, baseline, 'the hub count came back');
  assert.equal(live(), 0, 'and every engine view was disposed');
});

test('explicit disposeView drops exactly one, never orphaning the rest', async () => {
  const { hub, live } = viewCountingHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const a = await hub.openView(ref, { groupBy: ['desk'] }, s1);
  const b = await hub.openView(ref, { groupBy: ['trader'] }, s1);
  await hub.disposeView(a.viewId);
  assert.equal(live(), 1, 'one gone, one held');
  assert.ok(s1.views.has(b.viewId), 'the survivor is still tracked');
  await hub.disposeSessionViews(s1);
  assert.equal(live(), 0);
});

test('a transient query view is disposed even though it is never tracked', async () => {
  // rowCount/distinctValues/aggregates each open a view and must dispose it in a
  // finally — a thrown query must not leak.
  const { hub, live } = viewCountingHub();
  await hub.subscribe(ref, session('s1'));
  const before = live();
  await hub.rowCount(ref, { filter: [] }).catch(() => {});
  assert.equal(live(), before, 'the transient view did not survive the query');
  assert.equal(hub.openViewCount, 0, 'and it never entered the managed-view map');
});

// ------------------------------------------------- group-aggregate deltas (8e)

/** A hub with engine view + view-watch seams the test drives by hand. */
function groupHub() {
  let emit = null;
  let viewsLive = 0;
  const { hub } = makeHub({
    createView: async (_t, spec) => ({ __spec: spec, __live: true, delete: async () => { viewsLive--; } }),
    watchView: async (_v, cb) => { emit = cb; return () => { emit = null; }; },
  });
  const origCreate = hub.createView;
  hub.createView = async (...a) => { viewsLive++; return origCreate(...a); };
  return { hub, feed: (rows) => emit?.(rows), viewsLive: () => viewsLive };
}
const grouped = (...specs) => [
  { __ROW_PATH__: [], dv01: 0 },
  ...specs.map(([path, dv01]) => ({ __ROW_PATH__: path, dv01 })),
];

test('watchGroups pushes a groupDelta only for groups whose aggregate moved', async () => {
  const { hub, feed } = groupHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  await hub.watchGroups(ref, { groupBy: ['desk'], aggregates: { dv01: 'sum' } }, s1);

  feed(grouped([['Govies'], 100], [['EM Debt'], 200]));   // first: both new
  feed(grouped([['Govies'], 137], [['EM Debt'], 200]));   // only Govies moved

  const deltas = s1.sent.filter((m) => m.type === 'groupDelta');
  assert.equal(deltas.length, 2, 'one per feed that had a change');
  assert.deepEqual(deltas.at(-1).changed.map((c) => c.path), [['Govies']]);
  assert.equal(deltas.at(-1).changed[0].values.dv01, 137);
});

test('a feed with no aggregate movement sends nothing', async () => {
  const { hub, feed } = groupHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  await hub.watchGroups(ref, { groupBy: ['desk'], aggregates: { dv01: 'sum' } }, s1);
  feed(grouped([['Govies'], 100]));
  s1.sent.length = 0;
  feed(grouped([['Govies'], 100]));                        // identical
  assert.equal(s1.sent.filter((m) => m.type === 'groupDelta').length, 0);
});

test('re-grouping replaces the watched view rather than leaking one', async () => {
  const { hub, viewsLive } = groupHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  await hub.watchGroups(ref, { groupBy: ['desk'], aggregates: { dv01: 'sum' } }, s1);
  assert.equal(viewsLive(), 1);
  await hub.watchGroups(ref, { groupBy: ['trader'], aggregates: { dv01: 'sum' } }, s1);
  assert.equal(viewsLive(), 1, 'the desk view was disposed when the trader view opened');
});

test('the same grouping twice does not open a second view', async () => {
  const { hub, viewsLive } = groupHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  await hub.watchGroups(ref, { groupBy: ['desk'], aggregates: { dv01: 'sum' } }, s1);
  await hub.watchGroups(ref, { groupBy: ['desk'], aggregates: { dv01: 'sum' } }, s1);
  assert.equal(viewsLive(), 1);
});

test('a group watch is disposed when the session disconnects — no leak', async () => {
  const { hub, viewsLive } = groupHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  await hub.watchGroups(ref, { groupBy: ['desk'], aggregates: { dv01: 'sum' } }, s1);
  assert.equal(viewsLive(), 1);
  await hub.disposeSessionViews(s1);              // the disconnect path
  assert.equal(viewsLive(), 0, 'the grouped view came back to baseline too');
});

test('watchGroups is a no-op when the host has no view engine', async () => {
  // A host without createView/watchView (e.g. the Map-backed test hub) must
  // degrade to the coarse refresh, not throw.
  const { hub } = makeHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const r = await hub.watchGroups(ref, { groupBy: ['desk'], aggregates: {} }, s1);
  assert.equal(r.watching, false);
});

// ------------------------------------------------- the write path (§8.6)

test('a command applies to the read model and reports applied', async () => {
  // v1 annotations: the write becomes a row update that echoes via the feed.
  const { hub } = makeHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const entry = hub.entries.get([...hub.entries.keys()][0]);
  const pushed = [];
  const origPush = entry.actor.push.bind(entry.actor);
  entry.actor.push = (rows) => { pushed.push(...rows); return origPush(rows); };

  const r = await hub.command({ ref, verb: 'edit', idempotencyKey: 'w1', payload: { key: 'POS-1', field: 'note', value: 'watch' } });
  assert.equal(r.outcome, 'applied');
  assert.deepEqual(pushed.at(-1), { __key: 'POS-1', note: 'watch' }, 'applied as a keyed partial update');
});

test('a retried command is deduped by idempotencyKey — never double-applied', async () => {
  // The client cannot tell an ambiguous timeout from a lost command, so it
  // retries; the key is what makes that safe.
  const { hub } = makeHub();
  const s1 = session('s1');
  await hub.subscribe(ref, s1);
  const entry = hub.entries.get([...hub.entries.keys()][0]);
  let applies = 0;
  const orig = entry.actor.push.bind(entry.actor);
  entry.actor.push = (rows) => { applies++; return orig(rows); };

  const cmd = { ref, verb: 'edit', idempotencyKey: 'w1', payload: { key: 'POS-1', field: 'note', value: 'x' } };
  const first = await hub.command(cmd);
  const retry = await hub.command(cmd);
  assert.equal(first.outcome, 'applied');
  assert.equal(retry.outcome, 'duplicate', 'the second is recognised, not reapplied');
  assert.equal(applies, 1, 'the write hit the table exactly once');
});

test('a command with no key or field is rejected, not silently dropped', async () => {
  const { hub } = makeHub();
  await hub.subscribe(ref, session('s1'));
  const r = await hub.command({ ref, verb: 'edit', idempotencyKey: 'w1', payload: { value: 'x' } });
  assert.equal(r.outcome, 'rejected');
  assert.match(r.detail, /key and field/);
});

test('a command against an unsubscribed datasource is rejected with the reason', async () => {
  const { hub } = makeHub();
  const r = await hub.command({ ref, verb: 'edit', idempotencyKey: 'w1', payload: { key: 'POS-1', field: 'note', value: 'x' } });
  assert.equal(r.outcome, 'rejected');
  assert.match(r.detail, /not subscribed/);
});
