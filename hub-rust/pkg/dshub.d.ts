/* tslint:disable */
/* eslint-disable */
/**
 * One shared hub + a map of per-port sessions. Held alive by JS across calls.
 *
 * `shared_deltas` is the O(1) row-delta path: one `DeltaSub` per cache key, polled
 * ONCE per tick and broadcast to every client (they share the cache, so the delta
 * is identical). Without it, N CSRM clients each materialize the full-row delta and
 * the single thread collapses past ~2 clients.
 */
export class RustHub {
  private constructor();
  free(): void;
  /**
   * Construct an empty hub. The worker `boot_datasource`s config before any
   * client subscribes (the hub starts knowing no datasources, like the sidecar).
   */
  static new(): RustHub;
  /**
   * Register one datasource config on the shared hub (the worker seeds this once,
   * before any subscribe), reusing the `bootstrap` control path. A throwaway
   * session carries the reply — bootstrap is hub-level, not per-subscriber.
   */
  boot_datasource(config_json: string): string;
  /**
   * Register a new subscriber (one MessagePort = one session).
   */
  connect(session_id: string): void;
  /**
   * Tear a subscriber down: dispose its open views, release its shared-cache
   * refcounts, and drop its session (which drops its group-watches and delta
   * streams). Returns a JSON array of the cache keys that were FULLY freed —
   * the last subscriber left — so the worker can stop that datasource's upstream
   * feed. A key absent from the array still has other subscribers (shared).
   */
  disconnect(session_id: string): string;
  /**
   * Handle one inbound control message for a specific session. Returns a JSON
   * ARRAY string of the reply (if any) followed by that session's queued outbox
   * — one boundary crossing per client message.
   */
  on_control(session_id: string, msg_json: string): string;
  /**
   * Poll EVERY session's row deltas + group deltas + alerts, seq-stamped for
   * ack-based backpressure. Returns a JSON array of `{sessionId, messages:[...]}`
   * so the worker routes each session's pushes to its own port. The JS interval
   * that calls this IS the delivery conflation window.
   */
  tick(): string;
  /**
   * Ingest one upstream message into a subscribed cache. `params_json` must
   * match the subscribe params (same cache key). The worker flattens nested
   * JSON before calling this (the Rust ingest assumes pre-flattened rows).
   * Returns `"[upserts,deletes]"`. Hub-level — every session sharing this cache
   * sees the update on its next tick.
   */
  apply_message_json(ds_id: string, params_json: string, raw_json: string): string;
  /**
   * Column-major snapshot of the whole cache for a datasource — the CSRM
   * snapshot. Returns `{"revision":R,"rowCount":N,"columns":{__key:[...],col:[...]}}`.
   * Built once from the columnar cache (all columns, no row objects); the worker
   * MEMOIZES this per revision so 20 subscribers cost one build, not twenty.
   */
  snapshot_columns(ds_id: string, params_json: string): string;
  /**
   * Poll the SHARED row-delta stream for a datasource — built ONCE per tick and
   * broadcast by the worker to every client (they share the cache, so the delta
   * is identical). Returns a `rowDelta` JSON string, or "" if nothing changed.
   * Get-or-creates the stream at the current revision on first poll.
   */
  poll_shared_delta(ds_id: string, params_json: string): string;
  /**
   * Rewind the SHARED stream to `from_rev` so a joining client's snapshot@from_rev
   * has no gap — the next broadcast re-sends every row changed since then (at
   * CURRENT values, so existing clients re-applying it is a harmless idempotent
   * no-op). Called on each snapshot request.
   */
  rewind_shared_delta(ds_id: string, params_json: string, from_rev: bigint): void;
  /**
   * Number of live sessions (subscribers) this hub is serving.
   */
  session_count(): number;
  /**
   * Diagnostics for the benchmark (datasource/view/row counts).
   */
  mem_stats(): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_rusthub_free: (a: number, b: number) => void;
  readonly rusthub_new: () => number;
  readonly rusthub_boot_datasource: (a: number, b: number, c: number, d: number) => void;
  readonly rusthub_connect: (a: number, b: number, c: number) => void;
  readonly rusthub_disconnect: (a: number, b: number, c: number, d: number) => void;
  readonly rusthub_on_control: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly rusthub_tick: (a: number, b: number) => void;
  readonly rusthub_apply_message_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
  readonly rusthub_snapshot_columns: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly rusthub_poll_shared_delta: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly rusthub_rewind_shared_delta: (a: number, b: number, c: number, d: number, e: number, f: bigint) => void;
  readonly rusthub_session_count: (a: number) => number;
  readonly rusthub_mem_stats: (a: number, b: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
