// Type surface for the genuinely-shared transport in @wellsfargo-starui/dshub-provider.
// The package ships plain ESM; these ambient declarations give the app strict
// types for the three primitives the HubDataProvider sits on. Runtime code comes
// from the real .mjs files via the workspace symlink.

/** A port-like object (socket.io channel) the Transport drives. */
interface DshubPort {
  postMessage(data: unknown): void;
  close(): void;
  start?(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

declare module '@wellsfargo-starui/dshub-provider/src/control.mjs' {
  export class ControlError extends Error {
    code: string;
    retryable: boolean;
  }

  export interface ControlReply<T = unknown> {
    id: string;
    type: string;
    payload: T;
    partial?: boolean;
  }

  export class ControlClient {
    constructor(o: {
      send: (msg: Record<string, unknown>) => boolean | void;
      timeoutMs?: number;
    });
    /** Subscribe to a server-pushed event type (e.g. 'rowDelta', 'groupDelta'). Returns an unsubscribe. */
    on(type: string, fn: (msg: Record<string, unknown>) => void): () => void;
    /** Send a request and await its correlated reply. */
    request<T = unknown>(
      msg: Record<string, unknown>,
      opts?: { timeoutMs?: number; onPartial?: (payload: T, msg: Record<string, unknown>) => void },
    ): Promise<ControlReply<T>>;
    /** Feed every inbound control message here. */
    handle(msg: unknown): void;
  }
}

declare module '@wellsfargo-starui/dshub-provider/src/transport.mjs' {
  export class Transport {
    constructor(o: {
      connect: () => DshubPort;
      onControl: (msg: Record<string, unknown>) => void;
      onBinary?: (buf: ArrayBuffer) => void;
      onState?: (state: string, detail?: string) => void;
      reconnect?: Record<string, unknown>;
    });
    open(): void;
    /** Returns false if the message was queued (offline) rather than sent. */
    send(msg: Record<string, unknown>): boolean;
    close(): void;
  }
}

declare module '@wellsfargo-starui/dshub-provider/src/socketPort.mjs' {
  export function socketIoPort(
    url: string,
    opts?: { openSocket?: (u: string) => WebSocket; namespace?: string },
  ): DshubPort;
}
