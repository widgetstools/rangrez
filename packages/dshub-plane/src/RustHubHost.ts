/** Injectable WASM hub — tests supply a fake; the worker loads vendored dshub. */
export interface RustHubLike {
  boot_datasource(config_json: string): string;
  connect(session_id: string): void;
  disconnect(session_id: string): string;
  on_control(session_id: string, msg_json: string): string;
  tick(): string;
  apply_message_json(ds_id: string, params_json: string, raw_json: string): string;
  /** Delete rows by key — removals ride the delta stream. Returns "[n]". */
  delete_rows(ds_id: string, params_json: string, keys_json: string): string;
  /** Remove every row in one revision, schema kept. Returns "[n]". */
  truncate(ds_id: string, params_json: string): string;
  /**
   * Atomic truncate + ingest — restart semantics: afterwards the table holds
   * exactly the rows sent; surviving keys are never emitted as removals.
   * Returns "[upserts,truncated]".
   */
  replace_snapshot(ds_id: string, params_json: string, raw_json: string): string;
  /** Drop the ingest retention pin (provider stop). Returns "true"/"false". */
  drop_table(ds_id: string, params_json: string): string;
  poll_shared_delta(ds_id: string, params_json: string): string;
  /**
   * Engine feature manifest (JSON). OPTIONAL on the injectable interface —
   * test fakes predate it — and the plane treats "absent" as "none of the
   * gated features": computed columns are then reported unsupported instead
   * of silently mis-served.
   */
  capabilities?(): string;
  mem_stats(): string;
  /** Per-session diagnostics. Absent on engine builds before 0.8. */
  diagnostics?(): string;
}

export type RustHubFactory = () => RustHubLike | Promise<RustHubLike>;

type DshubModule = typeof import('@starui/dshub');

let wasmReady: Promise<RustHubLike> | null = null;
let importDshub: () => Promise<DshubModule> = defaultImportDshub;

function defaultImportDshub(): Promise<DshubModule> {
  // Literal specifier so esbuild inlines vendor/dshub into the worker.
  // Vitest aliases `@starui/dshub` to `dshub.vitest-stub.ts`.
  return import('@starui/dshub') as Promise<DshubModule>;
}

export function resetRustHubLoader(next?: () => Promise<DshubModule>): void {
  wasmReady = null;
  importDshub = next ?? defaultImportDshub;
}

/** Load the vendored WASM module once per worker. */
export async function loadVendoredRustHub(): Promise<RustHubLike> {
  if (wasmReady) return wasmReady;
  wasmReady = (async () => {
    const mod = await importDshub();
    const wasmUrl = new URL('./dshub_bg.wasm', import.meta.url);
    await mod.default({ module_or_path: wasmUrl });
    return mod.RustHub.new();
  })();
  return wasmReady;
}

export class RustHubHost {
  private hub: RustHubLike | null = null;
  private hubPromise: Promise<RustHubLike> | null = null;
  private readonly factory: RustHubFactory;

  constructor(factory: RustHubFactory = loadVendoredRustHub) {
    this.factory = factory;
  }

  async ensure(): Promise<RustHubLike> {
    // Memoise the IN-FLIGHT creation, not just the result: `boot()` and the
    // first `ingest()` race in the same tick (a mock-ssrm provider emits its
    // snapshot on a microtask right after create), and a `this.hub = await
    // factory()` here would build TWO engines — the ingest lands on the one
    // that loses the assignment and the data silently vanishes. The default
    // vendored loader happens to memoise globally, which masked this for
    // every injected factory.
    if (!this.hubPromise) {
      this.hubPromise = Promise.resolve(this.factory());
    }
    this.hub = await this.hubPromise;
    return this.hub;
  }

  get current(): RustHubLike | null {
    return this.hub;
  }
}
