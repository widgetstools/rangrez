/**
 * Test connection (Phase 7, borrowed shape: stern's useProviderProbe).
 *
 * Connect, subscribe, trigger the snapshot, capture the first N rows, report
 * sentinel arrival, timing and row count. READ-ONLY: no table is created and
 * nothing touches the hub — the probe drives the same adapter the worker would
 * use, which is what makes its verdict trustworthy. A probe with its own
 * simplified client would pass on configs the worker then fails on.
 */

import { StompAdapter } from '../../dshub-worker/src/adapters/stomp.mjs';
import { WsAdapter } from '../../dshub-worker/src/adapters/ws.mjs';
import { SocketIoAdapter } from '../../dshub-worker/src/adapters/socketio.mjs';
import { RestAdapter } from '../../dshub-worker/src/adapters/rest.mjs';

const ADAPTERS = { stomp: StompAdapter, ws: WsAdapter, socketio: SocketIoAdapter, rest: RestAdapter };

/** Fill `{param}` values from the datasource's declared defaults. */
export function defaultParams(datasource) {
  const out = {};
  for (const [k, spec] of Object.entries(datasource?.params ?? {})) {
    if (spec && typeof spec === 'object' && 'default' in spec) out[k] = spec.default;
  }
  return out;
}

/**
 * @returns {Promise<{success:boolean, rows:object[], rowCount:number,
 *   sentinelSeen:boolean, tookMs:number, states:{state:string,detail?:string,at:number}[],
 *   error:string|null}>}
 */
export function probeDatasource({
  connection, datasource, params, maxRows = 5, timeoutMs = 10_000,
  openSocket = (url) => new WebSocket(url),
  fetchImpl,
  signal,
}) {
  const Adapter = ADAPTERS[connection?.kind];
  if (!Adapter) {
    return Promise.resolve({
      success: false, rows: [], rowCount: 0, sentinelSeen: false, tookMs: 0, states: [],
      error: `"${connection?.kind}" is not a browser-reachable transport` +
        (connection?.kind === 'amps' || connection?.kind === 'solace' ? ' (Phase 10, sidecar)' : ''),
    });
  }

  const t0 = Date.now();
  const states = [];
  const rows = [];
  let rowCount = 0;

  return new Promise((resolve) => {
    let settled = false;
    let adapter = null;
    const finish = (success, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Teardown FIRST: a probe that leaves its socket open holds a snapshot
      // subscription against the real server for the full server-side timeout.
      try { adapter?.close(); } catch { /* already gone */ }
      resolve({
        success, rows: rows.slice(0, maxRows), rowCount,
        sentinelSeen: states.some((s) => s.state === 'live'),
        tookMs: Date.now() - t0, states, error,
      });
    };

    const timer = setTimeout(() => finish(false, `no live state within ${timeoutMs}ms (${rowCount} rows seen)`), timeoutMs);
    signal?.addEventListener?.('abort', () => finish(false, 'aborted'));

    try {
      adapter = new Adapter({
        connection, datasource,
        params: params ?? defaultParams(datasource),
        openSocket, fetchImpl,
        onRows: (batch) => {
          rowCount += batch.length;
          for (const r of batch) if (rows.length < maxRows) rows.push(r);
        },
        onState: (state, detail) => {
          states.push({ state, detail: detail === undefined ? undefined : String(detail).slice(0, 160), at: Date.now() - t0 });
          if (state === 'live') finish(true);
          if (state === 'failed') finish(false, String(detail ?? 'failed'));
        },
      });
      adapter.connect();
    } catch (e) {
      finish(false, String(e?.message ?? e));
    }
  });
}
