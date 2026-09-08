// HubDataProvider — the ONE bridge between an AG-Grid and a datasource in the hub.
//
//   const dp = new HubDataProvider({ hubUrl, datasource, params, mode, grid });
//   await dp.connect();
//   const api = createGrid(el, { columnDefs: dp.columnDefs(), ...dp.gridOptions() });
//   dp.attach(api);
//
// It gives the grid its COLUMN DEFINITIONS (from the datasource schema) and then:
//   CSRM — populates rowData with the snapshot, then applyTransactionAsync on live deltas.
//   SSRM — installs the IServerSideDatasource (getRows) and pushes live deltas as transactions.
//
// Under it sits only the thin, genuinely-shared transport: ControlClient (RPC +
// events) over a socket.io port. Nothing else.

import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridOptions,
  IServerSideGetRowsParams,
  ValueFormatterParams,
} from 'ag-grid-community';

import { ControlClient } from '@wellsfargo-starui/dshub-provider/src/control.mjs';
import { Transport } from '@wellsfargo-starui/dshub-provider/src/transport.mjs';
import { socketIoPort } from '@wellsfargo-starui/dshub-provider/src/socketPort.mjs';

import type { DatasourceConfig, GridHints, GridMode, HubProviderConfig } from './types';

const PROTOCOL_VERSION = 1;

type Row = Record<string, any>;
type Ref = { datasourceId: string; params: Record<string, unknown> };

/** AG-Grid Set Filter async values callback shape (kept local to avoid an enterprise type import). */
interface SetValuesParams {
  success: (values: unknown[]) => void;
  fail?: () => void;
}

interface RowDelta {
  upserts?: Row[];
  removals?: string[];
  seq?: number;
}
interface GroupDelta {
  groups?: Array<{ values?: unknown[]; count?: number; aggregates?: Record<string, unknown> }>;
  seq?: number;
}

const numFmt = (p: ValueFormatterParams): string =>
  p.value == null ? '' : Number(p.value).toLocaleString(undefined, { maximumFractionDigits: 2 });

const titleize = (s: string): string =>
  s
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();

const NUMERIC = new Set(['integer', 'int', 'float', 'double', 'number']);

export class HubDataProvider {
  readonly datasource: DatasourceConfig;
  readonly mode: GridMode;
  readonly grid: GridHints;
  readonly ref: Ref;

  private readonly keyField: string;
  private readonly control: ControlClient;
  private readonly transport: Transport;

  constructor({ hubUrl, datasource, params = {}, mode = 'ssrm', grid = {} }: HubProviderConfig) {
    this.datasource = datasource;
    this.ref = { datasourceId: datasource.id, params };
    this.mode = mode;
    this.grid = grid;
    this.keyField = datasource.keyColumns?.[0] ?? 'positionId';

    this.transport = new Transport({
      connect: () => socketIoPort(hubUrl, { openSocket: (u: string) => new WebSocket(u) }),
      onControl: (m) => this.control.handle(m),
    });
    this.control = new ControlClient({ send: (m) => this.transport.send(m), timeoutMs: 30_000 });
  }

  /** hello → bootstrap the datasource into the hub → subscribe (subscribe-before-snapshot). */
  async connect(): Promise<this> {
    this.transport.open();
    await this.control.request({ type: 'hello', appId: 'hub-data-provider', protocolVersion: PROTOCOL_VERSION });
    await this.control.request({ type: 'bootstrap', datasources: [this.datasource] });
    await this.control.request({ type: 'subscribe', ref: this.ref, delivery: 'rows' });
    return this;
  }

  /** Tear down: closes the transport (last subscriber leaving stops the hub's ingestor). Call on unmount. */
  dispose(): void {
    try {
      this.transport.close();
    } catch {
      /* already gone */
    }
  }

  /** Column definitions, derived from the datasource schema (+ grouping/agg hints). */
  columnDefs(): ColDef[] {
    const groupSet = new Set(this.grid.group ?? []);
    const agg = this.grid.agg ?? {};
    const ssrm = this.mode === 'ssrm';
    return (this.datasource.columns ?? []).map((c) => {
      const name = c.name;
      const type = c.type;
      const def: ColDef = {
        field: name,
        headerName: titleize(name),
        minWidth: 110,
        enableCellChangeFlash: true,
        floatingFilter: true,
      };
      if (NUMERIC.has(type)) {
        def.type = 'rightAligned';
        def.valueFormatter = numFmt;
        def.filter = 'agNumberColumnFilter';
      } else if (name === this.keyField) {
        def.filter = 'agTextColumnFilter'; // high-cardinality key → text, not a 20k-item set
      } else {
        def.filter = 'agSetColumnFilter'; // dimension → set filter
        // CSRM auto-populates the set filter from client rows; SSRM has no client
        // rows, so feed it the column's distinct values from the hub.
        if (ssrm) def.filterParams = { values: (p: SetValuesParams) => this.setFilterValues(name, p) };
      }
      if (groupSet.has(name)) {
        def.rowGroup = true;
        def.hide = true;
      }
      if (agg[name]) def.aggFunc = agg[name];
      return def;
    });
  }

  /** Grid options this provider needs (row id, flashing, and — for SSRM — the row model). */
  gridOptions(): Partial<GridOptions> {
    const base: Partial<GridOptions> = {
      getRowId: (p: GetRowIdParams) => this.rowId(p),
      cellFlashDuration: 700,
      cellFadeDuration: 500,
    };
    if (this.mode === 'csrm') return base;
    return {
      ...base,
      rowModelType: 'serverSide',
      cacheBlockSize: 100,
      suppressAggFuncInHeader: true,
      autoGroupColumnDef: {
        headerName: (this.grid.group ?? []).map(titleize).join(' / ') || 'Group',
        minWidth: 240,
        flex: 1,
      },
    };
  }

  /** Wire this provider to a live grid. */
  attach(gridApi: GridApi): void {
    if (this.mode === 'csrm') void this.attachCsrm(gridApi);
    else this.attachSsrm(gridApi);
  }

  // ── row identity: leaves by the hub-minted __key; groups by their display path ──
  private rowId(p: GetRowIdParams): string {
    const data = p.data as Row | undefined;
    if (data && data.__group) {
      const level = (p.parentKeys ?? []).length;
      const gcol = (this.grid.group ?? [])[level];
      return 'g:' + [...(p.parentKeys ?? []), data[gcol]].join('');
    }
    return this.leafId(data);
  }

  private leafId(row: Row | undefined): string {
    return 'p:' + (row ? (row.__key ?? row[this.keyField]) : '');
  }

  private ack(m: { seq?: number }): void {
    if (m && m.seq != null) this.transport.send({ type: 'ack', seq: m.seq });
  }

  /** Async Set Filter values for SSRM — the column's distinct values from the hub. */
  private async setFilterValues(colId: string, params: SetValuesParams): Promise<void> {
    try {
      const { payload } = await this.control.request<unknown[]>({
        type: 'distinctValues',
        ref: this.ref,
        colId,
        limit: 5000,
      });
      params.success(payload ?? []);
    } catch {
      params.success([]);
    }
  }

  /** Translate an AG-Grid filterModel into hub filter conditions (ANDed). */
  private filterConditions(filterModel: Record<string, any> | null | undefined): Row[] {
    const one = (column: string, c: any): Row => {
      if (c.filterType === 'set') return { column, op: 'in', value: c.values ?? [] }; // empty ⇒ nothing, like AG-Grid
      const cond: Row = { column, op: c.type, value: c.filter };
      if (c.type === 'inRange') cond.valueTo = c.filterTo;
      return cond;
    };
    const out: Row[] = [];
    for (const [column, m] of Object.entries(filterModel ?? {})) {
      const model = m as any;
      if (model.operator && Array.isArray(model.conditions)) {
        const subs = model.conditions.map((c: any) => one(column, c));
        if (model.operator === 'OR') out.push({ op: 'or', conditions: subs });
        else out.push(...subs); // AND ⇒ separate top-level leaves
      } else {
        out.push(one(column, model));
      }
    }
    return out;
  }

  // ─────────────────────────────── CSRM ────────────────────────────────
  private async attachCsrm(api: GridApi): Promise<void> {
    // snapshot: read the whole table once → rowData
    const { payload: opened } = await this.control.request<{ viewId: string }>({
      type: 'openView',
      ref: this.ref,
      view: {},
    });
    const { payload } = await this.control.request<{ rows: Row[]; rowCount: number }>({
      type: 'readWindow',
      viewId: opened.viewId,
    });
    void this.control.request({ type: 'disposeView', viewId: opened.viewId }).catch(() => {});
    api.setGridOption('rowData', payload.rows);

    // live: one unified upsert stream (Perspective-style). The snapshot above is
    // only whatever the cache held at read time; the source may still be filling.
    // So each upsert is add-or-update by row id, which both fills in late-arriving
    // rows and ticks the ones already here. applyTransactionAsync batches per frame.
    this.control.on('rowDelta', (raw) => {
      const m = raw as RowDelta;
      this.ack(m);
      const add: Row[] = [];
      const update: Row[] = [];
      for (const row of m.upserts ?? []) {
        (api.getRowNode(this.leafId(row)) ? update : add).push(row);
      }
      const remove = (m.removals ?? []).map((k) => ({ __key: k }));
      api.applyTransactionAsync({ add, update, remove });
    });
  }

  // ─────────────────────────────── SSRM ────────────────────────────────
  private attachSsrm(api: GridApi): void {
    api.setGridOption('serverSideDatasource', { getRows: (p: IServerSideGetRowsParams) => this.getRows(p) });

    const GCOLS = this.grid.group ?? [];
    const LIVE = Object.keys(this.grid.agg ?? {});
    const liveSorted = () => api.getColumnState().some((c) => c.sort && LIVE.includes(c.colId));
    const filtered = () => Object.keys(api.getFilterModel() ?? {}).length > 0;
    // A live tick can't be applied in place when a live column is sorted (rows must
    // re-order) or a filter is active (hub deltas are unfiltered); re-fetch instead.
    const mustRefetch = () => liveSorted() || filtered();
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        api.refreshServerSide({ purge: false });
      }, 120);
    };

    // group aggregates — push only the moved groups
    if (GCOLS.length) {
      void this.control
        .request({ type: 'watchGroups', ref: this.ref, groupBy: GCOLS, aggregates: this.grid.agg ?? {} })
        .catch(() => {});
      this.control.on('groupDelta', (raw) => {
        const m = raw as GroupDelta;
        this.ack(m);
        if (mustRefetch()) return refresh();
        const byRoute = new Map<string, { route: string[]; update: Row[] }>();
        for (const g of m.groups ?? []) {
          const v = g.values ?? [];
          if (!v.length) continue;
          const level = v.length - 1;
          const route = v.slice(0, level).map(String);
          const row: Row = { __group: true, __count: g.count, [GCOLS[level]]: v[level], ...g.aggregates };
          const k = JSON.stringify(route);
          if (!byRoute.has(k)) byRoute.set(k, { route, update: [] });
          byRoute.get(k)!.update.push(row);
        }
        for (const { route, update } of byRoute.values()) {
          try {
            api.applyServerSideTransaction({ route, update });
          } catch {
            /* stale route between refreshes */
          }
        }
      });
    }

    // leaf ticks — apply each changed row to its current group route ([] when ungrouped)
    this.control.on('rowDelta', (raw) => {
      const m = raw as RowDelta;
      this.ack(m);
      if (mustRefetch()) return refresh();
      const groupCols = api.getRowGroupColumns().map((c) => c.getColId());
      const byRoute = new Map<string, { route: string[]; update: Row[] }>();
      for (const row of m.upserts ?? []) {
        const route = groupCols.map((col) => String(row[col]));
        const k = JSON.stringify(route);
        if (!byRoute.has(k)) byRoute.set(k, { route, update: [] });
        byRoute.get(k)!.update.push(row);
      }
      for (const { route, update } of byRoute.values()) {
        try {
          api.applyServerSideTransaction({ route, update });
        } catch {
          /* stale route between refreshes */
        }
      }
    });
  }

  private async getRows(params: IServerSideGetRowsParams): Promise<void> {
    const req = params.request;
    const groupKeys = req.groupKeys ?? [];
    const rowGroupCols = req.rowGroupCols ?? [];
    const filter: Row[] = [
      ...groupKeys.map((value, i) => ({ column: rowGroupCols[i].id, op: 'equals', value })), // walk into this group
      ...this.filterConditions(req.filterModel as Record<string, any>), // the user's column filters
    ];
    const view: Row = {
      filter,
      sort: (req.sortModel ?? []).map((s) => ({ colId: s.colId, sort: s.sort })),
    };
    const next = rowGroupCols[groupKeys.length];
    if (next) {
      view.groupBy = [next.id];
      const aggregates: Record<string, string> = {};
      for (const vc of req.valueCols ?? []) aggregates[vc.field ?? vc.id] = vc.aggFunc ?? 'sum';
      view.aggregates = aggregates;
    }
    try {
      const { payload: opened } = await this.control.request<{ viewId: string }>({
        type: 'openView',
        ref: this.ref,
        view,
      });
      const { payload } = await this.control.request<{ rows: Row[]; rowCount: number }>({
        type: 'readWindow',
        viewId: opened.viewId,
        startRow: req.startRow,
        endRow: req.endRow,
      });
      void this.control.request({ type: 'disposeView', viewId: opened.viewId }).catch(() => {});
      params.success({ rowData: payload.rows, rowCount: payload.rowCount });
    } catch {
      params.fail();
    }
  }
}
