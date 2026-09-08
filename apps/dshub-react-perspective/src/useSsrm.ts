import { useEffect, useState } from 'react';
import { Transport } from '@wellsfargo-starui/dshub-provider/src/transport.mjs';
import { ControlClient } from '@wellsfargo-starui/dshub-provider/src/control.mjs';
import { HubDataService } from '@wellsfargo-starui/dshub-provider/src/hubDataService.mjs';
import { SsrmMode } from '@wellsfargo-starui/dshub-provider/src/modes/ssrm.mjs';
import { RustHubDataService } from './RustHubDataService';

// This app's identity — the SharedWorker name (so all tabs of this app share one
// hub) AND the appId in `hello`. One hub per (origin + appName); within it, each
// datasourceId shares one cache + one upstream feed.
const APP_ID = 'react-perspective';
// The proven spike worker, served same-origin & raw by the dev middleware.
const WORKER_URL = '/apps/dshub-spike/web/dshub.worker.mjs';
// The Rust hub compiled to wasm (?engine=rust) — same control protocol, now a
// SharedWorker just like the Perspective one, so tabs share a single wasm hub.
const RUST_WORKER_URL = '/apps/dshub-spike/web/dshub-rust.worker.js';
const ENGINE = new URLSearchParams(location.search).get('engine');
// A SharedWorker's own timers throttle to ~1 Hz, so a VISIBLE page drives realtime
// delivery by polling at full rate. The poll also keeps this port's session alive
// (SharedWorker has no close event).
const POLL_MS = 100;

export interface HubRef {
  datasourceId: string;
  params: Record<string, unknown>;
}

export type SsrmState = 'connecting' | 'live' | `error: ${string}`;

export interface Wired {
  ssrm: SsrmMode;
  control: ControlClient;
  dataService: HubDataService;
}

/**
 * Boot the browser Perspective hub once and wire an SsrmMode to it.
 *
 * ready → hello → subscribe(notify) → wait for 'live' → build dataService + mode.
 * Created once; disposed on unmount (StrictMode-safe via the deferred timer).
 */
export function useSsrm(ref: HubRef, artifact: any): { wired: Wired | null; state: SsrmState } {
  const [wired, setWired] = useState<Wired | null>(null);
  const [state, setState] = useState<SsrmState>('connecting');

  useEffect(() => {
    let cancelled = false;
    let transport: Transport | undefined;
    let mode: SsrmMode | undefined;
    let heartbeat: number | undefined;

    // A hard tab close doesn't run React cleanup, so send 'bye' on pagehide too —
    // the reliable tab-close signal — for prompt teardown (the reaper is the
    // fallback if even this is missed).
    const onPageHide = () => {
      if (ENGINE === 'rust') { try { transport?.send({ type: 'bye' }); } catch { /* not connected */ } }
    };
    if (ENGINE === 'rust') window.addEventListener('pagehide', onPageHide);

    const timer = window.setTimeout(async () => {
      try {
        let onReady!: () => void;
        const ready = new Promise<void>((r) => (onReady = r));
        let onLive!: () => void;
        const live = new Promise<void>((r) => (onLive = r));

        const control = new ControlClient({ send: (m) => transport!.send(m), timeoutMs: 60_000 });
        transport = new Transport({
          // Both engines are SharedWorkers now: one hub instance per (origin +
          // name). The name is the appId for Rust, so every tab of this app shares
          // one wasm hub; the Perspective worker keeps its own name.
          connect: () =>
            ENGINE === 'rust'
              ? new SharedWorker(RUST_WORKER_URL, { type: 'module', name: APP_ID }).port
              : new SharedWorker(WORKER_URL, { type: 'module', name: 'dshub-perspective' }).port,
          onControl: (m) => {
            if (m.type === 'result' && m.payload?.ready) return onReady();
            control.handle(m);
          },
        });
        transport.open();
        control.on('state', (m) => { if (m.state === 'live') onLive(); });
        // A visible page drives realtime delivery (the SharedWorker's own timer is
        // throttled to ~1 Hz) AND keeps this port's session alive. Perspective
        // manages its own lifecycle, so only Rust polls.
        if (ENGINE === 'rust') heartbeat = window.setInterval(() => transport!.send({ type: 'poll' }), POLL_MS);

        await ready;                                             // engine booted in the SharedWorker
        await control.hello({ appId: APP_ID });                  // → configAck (no bootstrap)
        // Perspective SSRM re-fetches its own blocks (notify is enough). The Rust
        // engine also pushes changed leaf rows in place (applyServerSideTransaction
        // in App.tsx), so it needs the actual rows → delivery:'rows'.
        await control.subscribe(ref, { delivery: ENGINE === 'rust' ? 'rows' : 'notify' });
        await live;                                              // first snapshot is in the table

        const keyColumns: string[] = artifact.keyColumns ?? ['positionId'];
        // The Rust hub returns row-oriented windows with no group root; its adapter
        // bridges that to what SsrmMode expects. Perspective uses HubDataService.
        const DataService = ENGINE === 'rust' ? RustHubDataService : HubDataService;
        const dataService = new DataService({
          control, ref, artifact, mode: 'ssrm', keyColumns,
          searchColumns: ['desk', 'trader', 'bookName'],
        });
        mode = new SsrmMode({ dataService, artifact, keyColumns, maxViews: 12 });

        if (cancelled) { await mode.destroy(); transport.close(); return; }
        setWired({ ssrm: mode, control, dataService });
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
      // Best-effort clean teardown of this session in the shared hub; if the
      // 'bye' is lost (tab crash) the worker's idle reaper collects it.
      if (ENGINE === 'rust') { try { transport?.send({ type: 'bye' }); } catch { /* not connected */ } }
      void mode?.destroy();
      transport?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { wired, state };
}
