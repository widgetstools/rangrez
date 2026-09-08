import { useEffect, useRef, useState } from 'react';
import { HubDataProvider } from './HubDataProvider';
import type { HubProviderConfig } from './types';

export type HubState = 'connecting' | 'live' | `error: ${string}`;

/**
 * Own one HubDataProvider for the component's lifetime: created once, connected
 * on mount, disposed on unmount. StrictMode's dev double-invoke is safe — the
 * cleanup closes the transport and the re-run reconnects.
 */
export function useHubProvider(config: HubProviderConfig): { dp: HubDataProvider; state: HubState } {
  const ref = useRef<HubDataProvider | null>(null);
  if (ref.current === null) ref.current = new HubDataProvider(config);
  const dp = ref.current;

  const [state, setState] = useState<HubState>('connecting');

  useEffect(() => {
    let cancelled = false;
    // Defer the open one tick so React StrictMode's dev mount→unmount→mount cancels
    // here (clearTimeout) instead of opening a socket only to close it mid-handshake.
    const timer = window.setTimeout(() => {
      dp.connect()
        .then(() => {
          if (!cancelled) setState('live');
        })
        .catch((e: unknown) => {
          if (!cancelled) setState(`error: ${e instanceof Error ? e.message : String(e)}`);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      dp.dispose();
    };
  }, [dp]);

  return { dp, state };
}
