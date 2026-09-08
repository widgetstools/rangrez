import { useEffect, useState } from 'react';
import { Transport } from '@wellsfargo-starui/dshub-provider/src/transport.mjs';
import { ControlClient } from '@wellsfargo-starui/dshub-provider/src/control.mjs';

// CSRM against the Rust wasm hub (SharedWorker). The whole dataset lives in the
// browser: pull the memoized COLUMNAR snapshot once, then keep it live with
// `applyTransactionAsync` on each rowDelta. Grouping / agg / sort / filter are all
// client-side (AG-Grid's own engine), so the hub only serves a snapshot + a delta
// stream — the cheapest thing it does, and shared across every tab.

const APP_ID = 'react-perspective';
const RUST_WORKER_URL = '/apps/dshub-spike/web/dshub-rust.worker.js';
// A SharedWorker's own timers throttle to ~1 Hz, so a VISIBLE page drives delivery
// by polling — its page timer runs at full rate; a hidden tab throttles to ~1 Hz,
// which is fine (it's not being watched). The poll also serves as the heartbeat.
const POLL_MS = 100;

export interface HubRef {
  datasourceId: string;
  params: Record<string, unknown>;
}

export type CsrmState = 'connecting' | 'snapshot' | 'live' | `error: ${string}`;

/** A live delta stream that buffers until the grid is ready, then goes direct. */
export interface DeltaStream {
  buffer: any[];
  live: ((m: any) => void) | null;
}

export interface CsrmWired {
  control: ControlClient;
  ref: HubRef;
  keyColumns: string[];
  initialRows: any[];
  stream: DeltaStream;
  stats: { snapshotMs: number; snapshotMB: number; rows: number; cols: number };
}

// Rebuild row objects from the column-major snapshot payload. This is the client's
// share of the cost — 20k × ~373 assignments — done once, on this tab's main thread.
function columnsToRows(parsed: any): any[] {
  const cols = parsed.columns ?? {};
  const names = Object.keys(cols);
  const n = parsed.rowCount ?? 0;
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const row: any = {};
    for (const name of names) row[name] = cols[name][i];
    rows[i] = row;
  }
  return rows;
}

/**
 * Boot the shared Rust hub and load a CSRM snapshot + live delta stream.
 *
 * ready → hello → subscribe(rows) → wait 'live' → request snapshot (memoized,
 * columnar) → reconstruct rows. rowDeltas are buffered from the moment we
 * subscribe and replayed once the grid mounts (at-least-once, idempotent by key).
 */
export function useCsrm(ref: HubRef, artifact: any): { wired: CsrmWired | null; state: CsrmState } {
  const [wired, setWired] = useState<CsrmWired | null>(null);
  const [state, setState] = useState<CsrmState>('connecting');

  useEffect(() => {
    let cancelled = false;
    let transport: Transport | undefined;
    let heartbeat: number | undefined;

    const onPageHide = () => { try { transport?.send({ type: 'bye' }); } catch { /* not connected */ } };
    window.addEventListener('pagehide', onPageHide);

    const timer = window.setTimeout(async () => {
      try {
        let onReady!: () => void;
        const ready = new Promise<void>((r) => (onReady = r));
        let onLive!: () => void;
        const live = new Promise<void>((r) => (onLive = r));

        const control = new ControlClient({ send: (m) => transport!.send(m), timeoutMs: 120_000 });
        transport = new Transport({
          connect: () => new SharedWorker(RUST_WORKER_URL, { type: 'module', name: APP_ID }).port,
          onControl: (m: any) => {
            if (m.type === 'result' && m.payload?.ready) return onReady();
            control.handle(m);
          },
        });
        transport.open();
        control.on('state', (m: any) => { if (m.state === 'live') onLive(); });
        heartbeat = window.setInterval(() => transport!.send({ type: 'poll' }), POLL_MS);

        // Buffer deltas from the instant we subscribe; the grid drains them on ready.
        const stream: DeltaStream = { buffer: [], live: null };
        control.on('rowDelta', (m: any) => {
          if (stream.live) stream.live(m);
          else stream.buffer.push(m);
        });

        await ready;
        await control.hello({ appId: APP_ID });
        await control.subscribe(ref, { delivery: 'rows' }); // CSRM: snapshot + live rows
        await live;                                          // first snapshot is in the shared cache

        setState('snapshot');
        const t0 = performance.now();
        const snap: any = await control.request({ type: 'snapshot', ref }); // memoized columnar
        const parsed = JSON.parse(snap.payload);
        const initialRows = columnsToRows(parsed);
        const stats = {
          snapshotMs: Math.round(performance.now() - t0),
          snapshotMB: +(snap.payload.length / 1e6).toFixed(1),
          rows: initialRows.length,
          cols: Object.keys(parsed.columns ?? {}).length,
        };

        if (cancelled) { transport.close(); return; }
        const keyColumns: string[] = artifact?.keyColumns ?? ['positionId'];
        setWired({ control, ref, keyColumns, initialRows, stream, stats });
        setState('live');
      } catch (e: any) {
        if (!cancelled) setState(`error: ${e?.message ?? e}`);
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', onPageHide);
      if (heartbeat) window.clearInterval(heartbeat);
      try { transport?.send({ type: 'bye' }); } catch { /* not connected */ }
      transport?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { wired, state };
}
