import { HubDataService } from '@wellsfargo-starui/dshub-provider/src/hubDataService.mjs';

// Adapter: make the Rust wasm hub speak what the Perspective-oriented client
// (HubDataService + SsrmMode) expects, so the demo renders with ZERO changes to
// SsrmMode or the app. Two shape differences to bridge:
//
//  1. readWindow — the Rust hub returns ROW-oriented {rows, rowCount}; the base
//     HubDataService expects Perspective's COLUMNAR {columns} and pivots. So we
//     read `rows` directly (no pivot).
//  2. grouped views — Perspective puts the grand-total ROOT at index 0 (SsrmMode's
//     rootOffset=1 skips it). The Rust hub emits no root, so we synthesize one:
//     undo the +1 offset on block reads, and answer the grand-total [0,1) probe
//     with a real total computed via the `aggregates` control message.
export class RustHubDataService extends HubDataService {
  private ctl: any;
  private myRef: any;
  private views = new Map<string, { grouped: boolean; aggregates: Record<string, string>; filter: any }>();

  constructor(opts: any) {
    super(opts);
    this.ctl = opts.control;
    this.myRef = opts.ref;
  }

  async openView(spec: any) {
    const handle = await super.openView(spec); // { viewId }
    this.views.set(handle.viewId, {
      grouped: Array.isArray(spec?.groupBy) && spec.groupBy.length > 0,
      aggregates: spec?.aggregates ?? {},
      filter: spec?.filter ?? [],
    });
    return handle;
  }

  async readWindow(handle: any, { startRow = 0, endRow }: { startRow?: number; endRow?: number } = {}) {
    const info = this.views.get(handle?.viewId);
    const grouped = info?.grouped ?? false;

    // Flat view: the Rust hub already returns rows — pass through, no pivot.
    if (!grouped) {
      const r = await this.ctl.request({ type: 'readWindow', viewId: handle.viewId, startRow, endRow });
      return { rows: r.payload.rows ?? [], rowCount: r.payload.rowCount ?? 0 };
    }

    // Grouped [0,1) = useGrandTotal's root probe → synthesize the grand total.
    // (SsrmMode's block reads are always startRow >= 1 because of rootOffset.)
    if (startRow === 0) {
      const root = await this.groupRoot(info!);
      return { rows: root ? [root] : [], rowCount: 1 };
    }

    // Grouped block read: undo SsrmMode's +1 offset (the Rust view has no root
    // row at index 0), then re-add 1 to the count so its `rowCount - rootOffset`
    // lands on the true group count.
    const r = await this.ctl.request({
      type: 'readWindow',
      viewId: handle.viewId,
      startRow: startRow - 1,
      endRow: endRow === undefined ? undefined : endRow - 1,
    });
    return { rows: r.payload.rows ?? [], rowCount: (r.payload.rowCount ?? 0) + 1 };
  }

  async disposeView(handle: any) {
    this.views.delete(handle?.viewId);
    return super.disposeView(handle);
  }

  /** The grand-total root row Perspective would emit at index 0. */
  private async groupRoot(info: { aggregates: Record<string, string>; filter: any }) {
    const specs = Object.entries(info.aggregates ?? {}).map(([column, fn]) => ({ column, fn: String(fn), as: column }));
    const base: any = { __group: true, __path: [] };
    if (!specs.length) return base;
    const r = await this.ctl.request({ type: 'aggregates', ref: this.myRef, specs, view: { filter: info.filter ?? [] } });
    return { ...base, ...(r.payload ?? {}) };
  }
}
