// HubDataProvider — the ONE bridge between an AG-Grid and a datasource in the
// hub. It replaces the Mode + DataService layers with a single object.
//
//   const dp = new HubDataProvider({ hubUrl, datasource, params, mode, grid });
//   await dp.connect();
//   const api = createGrid(el, { columnDefs: dp.columnDefs(), ...dp.gridOptions() });
//   dp.attach(api);
//
// It gives the grid its COLUMN DEFINITIONS (from the datasource schema), and:
//   CSRM — populates rowData with the snapshot, then applyTransactionAsync on live deltas.
//   SSRM — installs the IServerSideDatasource (getRows) and pushes live deltas as transactions.
//
// Under it sits only the thin, genuinely-shared transport: ControlClient (RPC +
// events) over a socket.io port. Nothing else.

import { ControlClient } from '/packages/dshub-provider/src/control.mjs';
import { Transport } from '/packages/dshub-provider/src/transport.mjs';
import { socketIoPort } from '/packages/dshub-provider/src/socketPort.mjs';

const PROTOCOL_VERSION = 1;
const numFmt = (p) => (p.value == null ? '' : Number(p.value).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const titleize = (s) => s.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()).trim();
const NUMERIC = new Set(['integer', 'int', 'float', 'double', 'number']);

export class HubDataProvider {
  /**
   * @param {object}  o
   * @param {string}  o.hubUrl      ws://host:port of the hub
   * @param {object}  o.datasource  the datasource config to bootstrap (id, keyColumns, columns, connection, snapshot, updates)
   * @param {object}  o.params      subscription params (e.g. { clientId, rate, batchSize })
   * @param {'csrm'|'ssrm'} o.mode
   * @param {object}  o.grid        colDef hints: { group:[cols], agg:{col:fn} }
   */
  constructor({ hubUrl, datasource, params = {}, mode = 'ssrm', grid = {} }) {
    this.datasource = datasource;
    this.ref = { datasourceId: datasource.id, params };
    this.mode = mode;
    this.grid = grid;
    this.keyField = (datasource.keyColumns && datasource.keyColumns[0]) || 'positionId';

    this.control = new ControlClient({ send: (m) => this.transport.send(m), timeoutMs: 30_000 });
    this.transport = new Transport({
      connect: () => socketIoPort(hubUrl, { openSocket: (u) => new WebSocket(u) }),
      onControl: (m) => this.control.handle(m),
    });
  }

  /** hello → bootstrap the datasource into the hub → subscribe (subscribe-before-snapshot). */
  async connect() {
    this.transport.open();
    await this.control.request({ type: 'hello', appId: 'hub-data-provider', protocolVersion: PROTOCOL_VERSION });
    await this.control.request({ type: 'bootstrap', datasources: [this.datasource] });
    await this.control.request({ type: 'subscribe', ref: this.ref, delivery: 'rows' });
    return this;
  }

  /** Column definitions, derived from the datasource schema (+ grouping/agg hints). */
  columnDefs() {
    const groupSet = new Set(this.grid.group || []);
    const agg = this.grid.agg || {};
    const ssrm = this.mode === 'ssrm';
    return (this.datasource.columns || []).map((c) => {
      const name = typeof c === 'string' ? c : c.name;
      const type = typeof c === 'string' ? 'string' : c.type;
      const def = { field: name, headerName: titleize(name), minWidth: 110, enableCellChangeFlash: true, floatingFilter: true };
      if (NUMERIC.has(type)) {
        def.type = 'rightAligned';
        def.valueFormatter = numFmt;
        def.filter = 'agNumberColumnFilter';
      } else if (name === this.keyField) {
        def.filter = 'agTextColumnFilter';                 // high-cardinality key → text, not a 20k-item set
      } else {
        def.filter = 'agSetColumnFilter';                  // dimension → set filter
        // CSRM auto-populates the set filter from client rows; SSRM has no client rows,
        // so feed it the column's distinct values from the hub (matches CSRM behaviour).
        if (ssrm) def.filterParams = { values: (p) => this.#setFilterValues(name, p) };
      }
      if (groupSet.has(name)) { def.rowGroup = true; def.hide = true; }
      if (agg[name]) def.aggFunc = agg[name];
      return def;
    });
  }

  /** Async Set Filter values for SSRM — the column's distinct values from the hub. */
  async #setFilterValues(colId, params) {
    try {
      const { payload } = await this.control.request({ type: 'distinctValues', ref: this.ref, colId, limit: 5000 });
      params.success(payload || []);
    } catch { params.success([]); }
  }

  /** Translate an AG-Grid filterModel into hub filter conditions (ANDed). */
  #filterConditions(filterModel) {
    const one = (column, c) => {
      if (c.filterType === 'set') return { column, op: 'in', value: c.values || [] };  // empty ⇒ matches nothing, like AG-Grid
      const cond = { column, op: c.type, value: c.filter };
      if (c.type === 'inRange') cond.valueTo = c.filterTo;
      return cond;
    };
    const out = [];
    for (const [column, m] of Object.entries(filterModel || {})) {
      if (m.operator && Array.isArray(m.conditions)) {
        const subs = m.conditions.map((c) => one(column, c));
        if (m.operator === 'OR') out.push({ op: 'or', conditions: subs });
        else out.push(...subs);                            // AND ⇒ separate top-level leaves
      } else {
        out.push(one(column, m));
      }
    }
    return out;
  }

  /** Grid options this provider needs (row id, flashing, and — for SSRM — the row model). */
  gridOptions() {
    const base = { getRowId: (p) => this.#rowId(p), cellFlashDuration: 700, cellFadeDuration: 500 };
    if (this.mode === 'csrm') return base;
    return {
      ...base,
      rowModelType: 'serverSide',
      cacheBlockSize: 100,
      suppressAggFuncInHeader: true,
      autoGroupColumnDef: { headerName: (this.grid.group || []).map(titleize).join(' / ') || 'Group', minWidth: 240, flex: 1 },
    };
  }

  /** Wire this provider to a live grid. */
  attach(gridApi) {
    this.gridApi = gridApi;
    return this.mode === 'csrm' ? this.#attachCsrm() : this.#attachSsrm();
  }

  /** Tear down: closes the transport (last subscriber leaving stops the hub's ingestor). Call on unmount. */
  dispose() { try { this.transport.close(); } catch { /* already gone */ } }

  // ── row identity: leaves by the hub-minted __key; groups by their display path ──
  #rowId(p) {
    if (p.data && p.data.__group) {
      const level = (p.parentKeys || []).length;
      const gcol = (this.grid.group || [])[level];
      return 'g:' + [...(p.parentKeys || []), p.data[gcol]].join('');
    }
    return this.#leafId(p.data);
  }

  #leafId(row) { return 'p:' + (row ? (row.__key ?? row[this.keyField]) : ''); }

  #ack(m) { if (m && m.seq != null) this.transport.send({ type: 'ack', seq: m.seq }); }

  // ─────────────────────────────── CSRM ────────────────────────────────
  async #attachCsrm() {
    const api = this.gridApi;
    // snapshot: read the whole table once → rowData
    const { payload: opened } = await this.control.request({ type: 'openView', ref: this.ref, view: {} });
    const { payload } = await this.control.request({ type: 'readWindow', viewId: opened.viewId });
    this.control.request({ type: 'disposeView', viewId: opened.viewId }).catch(() => {});
    api.setGridOption('rowData', payload.rows);

    // live: one unified upsert stream (Perspective-style). The snapshot above is
    // only whatever the cache held at read time; the source may still be filling.
    // So each upsert is add-or-update by row id, which both fills in late-arriving
    // rows and ticks the ones already here. applyTransactionAsync batches per frame.
    this.control.on('rowDelta', (m) => {
      this.#ack(m);
      const add = [], update = [];
      for (const row of (m.upserts || [])) {
        (api.getRowNode(this.#leafId(row)) ? update : add).push(row);
      }
      const remove = (m.removals || []).map((k) => ({ __key: k }));
      api.applyTransactionAsync({ add, update, remove });
    });
  }

  // ─────────────────────────────── SSRM ────────────────────────────────
  #attachSsrm() {
    const api = this.gridApi;
    api.setGridOption('serverSideDatasource', { getRows: (p) => this.#getRows(p) });

    const GCOLS = this.grid.group || [];
    const LIVE = Object.keys(this.grid.agg || {});
    const liveSorted = () => api.getColumnState().some((c) => c.sort && LIVE.includes(c.colId));
    const filtered = () => Object.keys(api.getFilterModel() || {}).length > 0;
    // A live tick can't be applied in place when a live column is sorted (rows must
    // re-order) or a filter is active (hub deltas are unfiltered); re-fetch instead.
    const mustRefetch = () => liveSorted() || filtered();
    let pending = false;
    const refresh = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; api.refreshServerSide({ purge: false }); }, 120); };

    // group aggregates — push only the moved groups
    if (GCOLS.length) {
      this.control.request({ type: 'watchGroups', ref: this.ref, groupBy: GCOLS, aggregates: this.grid.agg || {} }).catch(() => {});
      this.control.on('groupDelta', (m) => {
        this.#ack(m);
        if (mustRefetch()) return refresh();
        const byRoute = new Map();
        for (const g of (m.groups || [])) {
          const v = g.values || []; if (!v.length) continue;
          const level = v.length - 1;
          const route = v.slice(0, level);
          const row = { __group: true, __count: g.count, [GCOLS[level]]: v[level], ...g.aggregates };
          const k = JSON.stringify(route);
          if (!byRoute.has(k)) byRoute.set(k, { route, update: [] });
          byRoute.get(k).update.push(row);
        }
        for (const { route, update } of byRoute.values()) { try { api.applyServerSideTransaction({ route, update }); } catch (e) {} }
      });
    }

    // leaf ticks — apply each changed row to its current group route ([] when ungrouped)
    this.control.on('rowDelta', (m) => {
      this.#ack(m);
      if (mustRefetch()) return refresh();
      const groupCols = api.getRowGroupColumns().map((c) => c.getColId());
      const byRoute = new Map();
      for (const row of (m.upserts || [])) {
        const route = groupCols.map((col) => row[col]);
        const k = JSON.stringify(route);
        if (!byRoute.has(k)) byRoute.set(k, { route, update: [] });
        byRoute.get(k).update.push(row);
      }
      for (const { route, update } of byRoute.values()) { try { api.applyServerSideTransaction({ route, update }); } catch (e) {} }
    });
  }

  async #getRows(params) {
    const req = params.request;
    const groupKeys = req.groupKeys || [];
    const rowGroupCols = req.rowGroupCols || [];
    const filter = [
      ...groupKeys.map((value, i) => ({ column: rowGroupCols[i].id, op: 'equals', value })),  // walk into this group
      ...this.#filterConditions(req.filterModel),                                              // the user's column filters
    ];
    const view = { filter, sort: (req.sortModel || []).map((s) => ({ colId: s.colId, sort: s.sort })) };
    const next = rowGroupCols[groupKeys.length];
    if (next) {
      view.groupBy = [next.id];
      view.aggregates = {};
      for (const vc of req.valueCols || []) view.aggregates[vc.field ?? vc.id] = vc.aggFunc ?? 'sum';
    }
    try {
      const { payload: opened } = await this.control.request({ type: 'openView', ref: this.ref, view });
      const { payload } = await this.control.request({ type: 'readWindow', viewId: opened.viewId, startRow: req.startRow, endRow: req.endRow });
      this.control.request({ type: 'disposeView', viewId: opened.viewId }).catch(() => {});
      params.success({ rowData: payload.rows, rowCount: payload.rowCount });
    } catch (e) { params.fail(); }
  }
}
