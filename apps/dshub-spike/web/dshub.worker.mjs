/**
 * The SharedWorker, running the real Hub with the REAL Perspective engine.
 *
 * This is the part that could not be tested in Node: `onconnect`, MessagePort
 * transport, and Perspective wasm inside a SharedWorker.
 */

/**
 * Read config from IndexedDB, seeding it from the example bundle when empty.
 *
 * The seed happens ONCE. Re-seeding on every start would silently revert every
 * edit a user made, which is the same failure as not persisting them at all.
 */
async function loadConfig() {
  // Also returns admin-created ARTIFACTS: a datasource onboarded through the
  // admin UI carries schemaRef `${id}@v1` pointing at an artifact in IDB, and
  // without loading those the whole Fields->Columns->Save flow ends at a
  // "cannot build a table schema" error.
  const seed = await (await fetch('/packages/dshub-spec/examples/positions-stomp.config.json')).json();
  try {
    const { openConfigStore } = await import('/packages/dshub-provider/src/configStore.mjs');
    const schema = await (await fetch('/packages/dshub-spec/datasource-config.schema.json')).json();
    const store = openConfigStore({ schema });

    const existing = await store.all('datasources');
    if (existing.length) {
      return {
        ...seed,
        connections: await store.all('connections'),
        datasources: existing,
        artifactsFromStore: await store.all('artifacts'),
        bundleVersion: (await store.meta())?.bundleVersion ?? 1,
      };
    }

    // First run: persist the seed so the admin UI has something to edit.
    await store.transaction(async (tx) => {
      for (const c of seed.connections ?? []) await tx.put('connections', c.id, c);
      for (const d of seed.datasources ?? []) await tx.put('datasources', d.id, d);
      await tx.putMeta({ bundleVersion: 1, seededAt: Date.now(), specVersion: seed.specVersion });
    });
    return seed;
  } catch (e) {
    // A config store that cannot open must not take the hub down with it: the
    // seed is a complete, valid config on its own.
    report({ type: 'configStoreError', message: String(e.message ?? e) });
    return seed;
  }
}

// Order matters: the shim must evaluate before Perspective's module body.
// See worker-env-shim.mjs for why.
import './worker-env-shim.mjs';
import * as psp from '/node_modules/@perspective-dev/client/dist/esm/perspective.inline.js';
import { Hub } from '/packages/dshub-worker/src/hub.mjs';
import { handleControl } from '/packages/dshub-worker/src/control.mjs';
import { attachPort } from '/packages/dshub-worker/src/port.mjs';
import { validate } from '/packages/dshub-spec/src/validate.mjs';
import { perspectiveSchemaFor } from '/packages/dshub-worker/src/schema.mjs';
import { toPerspectiveViewConfig } from '/packages/dshub-spec/src/viewspec.mjs';
import { reloadPlanForBundle } from '/packages/dshub-provider/src/reload.mjs';

let hub = null;
let client = null;
let schema = null;
let bootError = null;
const sessions = new Set();
let nextId = 1;

async function boot() {
  if (hub) return hub;
  schema ??= await (await fetch('/packages/dshub-spec/control-protocol.schema.json')).json();
  /**
   * Config comes from IndexedDB, seeded from the example bundle on first run.
   *
   * Reading the static file directly was fine while nothing could edit config.
   * Now that the admin UI writes to IndexedDB, reading the file would mean
   * edits appeared to save and then had no effect — the worker serving one
   * config while the editor showed another, with nothing to indicate which was
   * live. IndexedDB is the store (§3.5); the file is only a seed.
   */
  const bundle = await loadConfig();
  const artifact = await (await fetch('/packages/dshub-spec/corpus/positions/artifact.json')).json();

  // Perspective's engine, inside the SharedWorker.
  client = await psp.worker();

  hub = new Hub({
    bundle: { ...bundle, bundleVersion: 1, checksum: 'sha256:browser' },
    openSocket: (url) => new WebSocket(url),
    // The engine seam, now pointing at the real thing rather than a Map.
    // Keyed by schemaRef so every datasource sharing this schema — the same
    // book arriving over STOMP, raw WebSocket or REST — resolves to one copy.
    artifacts: {
      positions: artifact, 'positions@v1': artifact,
      // Admin-onboarded schemas, keyed the way schemaRef resolves them.
      ...Object.fromEntries((bundle.artifactsFromStore ?? []).flatMap((a) => [
        [`${a.id}@v${a.version}`, a], [a.id, a],
      ])),
    },
    createTable: async (name, opts) => {
      // From the artifact's schema — not from empty data, and not from the
      // first batch. See packages/dshub-worker/src/schema.mjs.
      const schema = perspectiveSchemaFor(opts.artifact, { softDeleteColumn: opts.softDeleteColumn });
      const t = await client.table(schema, { index: opts.index, name });
      return {
        name,
        // MUST return the promise. A block body swallowing it makes the write
        // fire-and-forget, so TableActor.flush sees nothing to await and
        // publishes `live` while the snapshot is still being written — the
        // provider then reads an empty table with no error anywhere.
        update: (block) => t.update(block).catch((e) => {
          report({ type: 'engineError', message: String(e) });
          throw e;
        }),
        size: () => t.size(),
        delete: () => t.delete(),
        _table: t,
      };
    },
    // One table, many views — the documented shape: "A Table can support
    // multiple Views concurrently, with Perspective optimizing memory usage by
    // relying on a single Table instance."
    // Translate OUR ViewSpec into Perspective's config. Passing our shape
    // straight through fails with "unknown field `groupBy`" — the hub must go
    // through the same seam the provider does.
    createView: async (table, spec) => {
      const view = await table._table.view(toPerspectiveViewConfig(spec));
      // set_depth is a METHOD, not a config field. SSRM asks for depth 1 so an
      // expansion returns exactly one level of children.
      if (spec?.depth !== undefined && typeof view.set_depth === 'function') {
        try { await view.set_depth(spec.depth); } catch (e) { report({ type: 'depthError', message: String(e).slice(0, 120) }); }
      }
      return view;
    },

    /**
     * Live deltas -> subscribers.
     *
     * `on_update({mode:'row'})` hands back `{port_id, delta}` where delta is an
     * ARROW buffer, not rows. A transient table decodes it; both it and its
     * view are disposed immediately, because a per-update leak here compounds
     * at feed rate.
     *
     * The architecture's intended path is to forward the arrow over the BINARY
     * channel and let the page's own Perspective client apply it (§7.1). This
     * decodes hub-side instead, which costs a copy but keeps the page free of
     * an engine.
     */
    watchTable: async (table, onColumns, wantsColumns) => {
      const view = await table._table.view();
      const cb = async ({ delta }) => {
        if (!delta) return;
        // Only row-delivery (CSRM) subscribers need the decoded rows. For
        // notify-only (SSRM/VRM) subscribers, rebuilding a fresh table from the
        // delta every update is pure waste that saturates the wasm thread — just
        // fan out the change signal instead. (Perspective's own datagrid never
        // pays this; it patches its viewport from the delta directly.)
        if (wantsColumns && !wantsColumns()) { onColumns(null); return; }
        let t2, v2;
        try {
          t2 = await client.table(delta);
          v2 = await t2.view();
          onColumns(await v2.to_columns());
        } catch (e) {
          report({ type: 'deltaError', message: String(e).slice(0, 160) });
        } finally {
          try { await v2?.delete(); } catch {}
          try { await t2?.delete(); } catch {}
        }
      };
      view.on_update(cb, { mode: 'row' });
      return () => { try { view.remove_update(cb); } catch {} view.delete().catch(() => {}); };
    },

    /**
     * Watch ONE already-open view's on_update, decoding to ROWS (Phase 8e).
     *
     * The hub opens a grouped view and hands it here; on every engine update we
     * re-read the view's current rows (grouped views are small — one row per
     * group, not per position) so the differ sees full group aggregates rather
     * than trying to reconstruct them from a delta.
     */
    watchView: async (view, onRows) => {
      const pivot = (cols) => {
        const names = Object.keys(cols ?? {});
        if (!names.length) return [];
        const n = cols[names[0]].length;
        const out = new Array(n);
        for (let i = 0; i < n; i++) { const r = {}; for (const nm of names) r[nm] = cols[nm][i]; out[i] = r; }
        return out;
      };
      const cb = async () => {
        try { onRows(pivot(await view.to_columns())); }
        catch (e) { report({ type: 'groupDeltaError', message: String(e).slice(0, 160) }); }
      };
      view.on_update(cb, { mode: 'row' });
      return () => { try { view.remove_update(cb); } catch {} };
    },
  });
  hub.schema = schema;
  /**
   * Hot-reload planner (architecture §3.8). Injected so the datasource-config
   * schema is loaded once, at the edge, and the hub core stays free of it.
   */
  const configSchema = await (await fetch('/packages/dshub-spec/datasource-config.schema.json')).json();
  hub.reloadPlanner = (prev, next) => reloadPlanForBundle(prev, next, configSchema);
  // Push stats to every session once per second (architecture §10).
  hub.startStatsTicker(1000);
  // system_info lives on the CLIENT instance in the browser build, not on the
  // module (where the Node build exports it). Reading it off `psp` silently
  // yields null, which is how the first attempt reported no engine memory.
  hub.setMemoryProbe(async () => {
    const info = await client.system_info();
    // measureUserAgentSpecificMemory is the accurate cross-check and needs
    // crossOriginIsolated, which the harness server enables via COOP/COEP.
    let uaBytes = null;
    try { uaBytes = (await performance.measureUserAgentSpecificMemory?.())?.bytes ?? null; } catch {}
    return { ...info, uaBytes };
  });
  return hub;
}

function report(msg) { for (const s of sessions) s.send({ id: 'evt', type: 'result', payload: msg }); }

globalThis.onconnect = (e) => { handleConnect(e.ports[0]); };

async function handleConnect(port) {
  const id = nextId++;
  let session;

  const channel = attachPort(port, {
    onControl: async (msg) => {
      try {
        const h = await boot();
        const reply = await handleControl(msg, { schema: h.schema, validate, hub: h, session });
        if (reply) channel.control(reply);
      } catch (err) {
        bootError = String(err?.stack ?? err);
        channel.control({ id: msg?.id ?? 'x', type: 'error', code: 'internal', message: bootError.slice(0, 400) });
      }
    },
    onBinary: () => {}, // Perspective protocol passthrough; unused in this harness
  });

  session = { id, subscriptions: new Set(), send: (m) => channel.control(m) };
  sessions.add(session);

  try {
    const h = await boot();
    h.sessions.add(session);
    channel.control({
      id: 'ready', type: 'result',
      payload: {
        ready: true, sessionId: id, sessions: h.sessions.size,
        memory64: psp.host_supports_memory64(),
        engine: 'perspective-5.3.0',
      },
    });
  } catch (err) {
    channel.control({ id: 'ready', type: 'error', code: 'internal', message: String(err?.stack ?? err).slice(0, 600) });
  }
}
