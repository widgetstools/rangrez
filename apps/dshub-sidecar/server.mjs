#!/usr/bin/env node
/**
 * The DataSource Hub, running OUTSIDE the browser.
 *
 * This is not a stand-in or a spec — it is the same `Hub` the SharedWorker runs,
 * hosted in a Node process, with Perspective's Node engine behind the same
 * `createTable`/`createView`/`watchTable`/`watchView` seams the browser host
 * wires, and exposed to subscribers over socket.io (Phase 10, architecture §2.2).
 *
 * A browser tab reaches it with `socketIoPort` and drives it through the exact
 * same `ControlClient`/`Transport` it uses against the in-page SharedWorker — so
 * "which host am I talking to" is a URL, not a code path. That is the whole point
 * of the host-agnostic Hub: the desk that outgrows the wasm memory ceiling, or
 * needs an AMPS/Solace feed a browser cannot open, moves to THIS process without
 * touching the blotter.
 *
 * The engine wiring here is a line-for-line port of the browser host in
 * apps/dshub-spike/web/dshub.worker.mjs — same seams, Node build instead of the
 * in-worker one, a `ws` server instead of `onconnect`.
 *
 * Run:  node apps/dshub-sidecar/server.mjs            (defaults to :8787)
 *       DSHUB_PORT=9000 node apps/dshub-sidecar/server.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

import * as psp from '@perspective-dev/client/dist/esm/perspective.node.js';

import { Hub } from '../../packages/dshub-worker/src/hub.mjs';
import { handleControl } from '../../packages/dshub-worker/src/control.mjs';
import { attachSidecarSocket } from '../../packages/dshub-worker/src/sidecarServer.mjs';
import { perspectiveSchemaFor } from '../../packages/dshub-worker/src/schema.mjs';
import { validate } from '../../packages/dshub-spec/src/validate.mjs';
import { toPerspectiveViewConfig } from '../../packages/dshub-spec/src/viewspec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = join(HERE, '../../packages/dshub-spec');
const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

const PORT = Number(process.env.DSHUB_PORT ?? 8787);

/**
 * Build the real Hub with Perspective's Node engine behind every seam.
 * Every one of these callbacks is the browser host's, unchanged in substance —
 * only `client.table` becomes the module-level `psp.table` the Node build
 * exports, because there is no in-worker client instance out here.
 */
export async function buildHub({ bundle, artifacts, schema } = {}) {
  bundle ??= readJSON(join(SPEC, 'examples/positions-stomp.config.json'));
  schema ??= readJSON(join(SPEC, 'control-protocol.schema.json'));
  if (!artifacts) {
    const artifact = readJSON(join(SPEC, 'corpus/positions/artifact.json'));
    // Keyed the way schemaRef resolves: `id@vN` first, bare `id` as a fallback.
    artifacts = { positions: artifact, 'positions@v1': artifact };
  }

  const hub = new Hub({
    bundle: { ...bundle, bundleVersion: bundle.bundleVersion ?? 1, checksum: bundle.checksum ?? 'sha256:sidecar' },
    // Upstream market-data connections (STOMP / raw WS / socket.io adapters).
    // `ws`'s WebSocket honours the browser-style onopen/onmessage/onclose the
    // adapters set, so the same adapter code runs unchanged out here.
    openSocket: (url) => new WebSocket(url),
    artifacts,

    createTable: async (name, opts) => {
      const tblSchema = perspectiveSchemaFor(opts.artifact, { softDeleteColumn: opts.softDeleteColumn });
      const t = await psp.table(tblSchema, { index: opts.index, name });
      return {
        name,
        // MUST return the promise — a swallowed write publishes `live` over an
        // unwritten table (see the browser host for the bug this caused).
        update: (block) => t.update(block),
        size: () => t.size(),
        delete: () => t.delete(),
        _table: t,
      };
    },

    createView: async (table, spec) => {
      const view = await table._table.view(toPerspectiveViewConfig(spec));
      if (spec?.depth !== undefined && typeof view.set_depth === 'function') {
        try { await view.set_depth(spec.depth); } catch { /* depth is best-effort */ }
      }
      return view;
    },

    // Live deltas -> subscribers. on_update hands back an Arrow buffer; a
    // transient table decodes it to columns, then both are disposed at once
    // because a per-update leak compounds at feed rate.
    watchTable: async (table, onColumns) => {
      const view = await table._table.view();
      const cb = async ({ delta }) => {
        if (!delta) return;
        let t2, v2;
        try { t2 = await psp.table(delta); v2 = await t2.view(); onColumns(await v2.to_columns()); }
        catch { /* a bad delta must not take the feed down */ }
        finally { try { await v2?.delete(); } catch {} try { await t2?.delete(); } catch {} }
      };
      view.on_update(cb, { mode: 'row' });
      return () => { try { view.remove_update(cb); } catch {} view.delete().catch(() => {}); };
    },

    // Watch one already-open (grouped) view, decoding to rows for the aggregate
    // differ (Phase 8e). Grouped views are small — one row per group.
    watchView: async (view, onRows) => {
      const pivot = (cols) => {
        const names = Object.keys(cols ?? {});
        if (!names.length) return [];
        const n = cols[names[0]].length;
        const out = new Array(n);
        for (let i = 0; i < n; i++) { const r = {}; for (const nm of names) r[nm] = cols[nm][i]; out[i] = r; }
        return out;
      };
      const cb = async () => { try { onRows(pivot(await view.to_columns())); } catch { /* keep watching */ } };
      view.on_update(cb, { mode: 'row' });
      return () => { try { view.remove_update(cb); } catch {} };
    },
  });

  hub.schema = schema;
  hub.validate = validate;
  hub.sessions = new Set();
  // The same diagnostics the browser host exposes — resident engine memory,
  // which out here is the number that decides whether a desk needs this host.
  hub.setMemoryProbe?.(async () => { try { return await psp.system_info(); } catch { return null; } });
  return hub;
}

/** Stand the hub up on a socket.io endpoint and serve until killed. */
export async function serve({ port = PORT } = {}) {
  const hub = await buildHub();
  hub.startStatsTicker?.(1000);

  const wss = new WebSocketServer({ port });
  let nextSid = 1;
  wss.on('connection', (ws, req) => {
    const sid = `s${nextSid++}`;
    attachSidecarSocket(ws, { handleControl, hub, schema: hub.schema, validate, sid: () => sid });
    log(`+ subscriber ${sid} (${req?.socket?.remoteAddress ?? '?'}) — ${hub.sessions.size} live`);
    ws.on('close', () => log(`- subscriber ${sid} — ${hub.sessions.size} live`));
  });

  await new Promise((r) => wss.on('listening', r));
  const actualPort = wss.address().port;   // resolves the real port when `port: 0`
  log(`DataSource Hub sidecar listening on ws://127.0.0.1:${actualPort}`);
  log(`engine: perspective-5.3.0 (node)  memory64: ${safe(() => psp.host_supports_memory64())}`);
  log(`datasources: ${(hub.bundle?.datasources ?? []).map((d) => d.id).join(', ') || '(none in bundle)'}`);

  const shutdown = () => { log('shutting down'); wss.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { hub, wss, port: actualPort, close: () => new Promise((r) => wss.close(r)) };
}

const log = (m) => process.stdout.write(`[dshub-sidecar] ${m}\n`);
const safe = (f) => { try { return f(); } catch { return '?'; } };

// Run when invoked directly (not when imported by the smoke test).
if (import.meta.url === `file://${process.argv[1]}`) {
  serve().catch((e) => { process.stderr.write(`[dshub-sidecar] fatal: ${e?.stack ?? e}\n`); process.exit(1); });
}
