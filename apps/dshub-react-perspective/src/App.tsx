import { useEffect, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridApi, GridReadyEvent, ValueGetterParams } from 'ag-grid-community';
import { buildColDefs } from '@wellsfargo-starui/dshub-provider/src/coldefs.mjs';
import { toViewSpec } from '@wellsfargo-starui/dshub-provider/src/modes/ssrm.mjs';
import { useSsrm, type HubRef, type Wired } from './useSsrm';
import { blotterTheme } from './theme';

const REFRESH_MS = 200; // live-refresh cadence — a blotter, not a report
const TOTAL_MS = 300; // grand-total refresh cadence

// A live grand-total row, computed by the HUB (not the grid).
//
// SSRM aggregates on the server, so AG-Grid's own grand-total row never populates
// here. Instead we read the ROOT of a grouped Perspective view — its `__ROW_PATH__:
// []` row is the true total over ALL rows (respecting the current filter) — and show
// it as a pinned bottom row, re-read every tick so it stays live.
function useGrandTotal(gridApi: GridApi | null, wired: Wired | null): void {
  useEffect(() => {
    if (!gridApi || !wired) return;
    const { ssrm, dataService } = wired;
    let alive = true;
    let handle: any = null;
    let openKey = '';
    let inFlight = false; // serialize ticks so overlapping opens can't leak views

    // What the total view should be, given the grid's current filter / agg / grouping.
    const desired = () => {
      const filterModel = { ...(gridApi.getFilterModel() ?? {}), ...((ssrm as any).searchModel ?? {}) };
      const { filter } = toViewSpec({ groupKeys: [], rowGroupCols: [], filterModel, valueCols: [], sortModel: [] });
      const aggregates = Object.fromEntries((gridApi.getValueColumns() ?? []).map((c) => [c.getColId(), c.getAggFunc() ?? 'sum']));
      const groupBy = [gridApi.getRowGroupColumns()[0]?.getColId() ?? 'desk'];
      return { filter, aggregates, groupBy };
    };

    const tick = async () => {
      if (inFlight) return;
      // No meaningful total row while pivoting (measures become split columns).
      if (gridApi.getGridOption('pivotMode')) { gridApi.setGridOption('pinnedBottomRowData', []); return; }
      inFlight = true;
      try {
        const spec = desired();
        const key = JSON.stringify(spec);
        if (!handle || key !== openKey) {              // (re)open when filter/agg/grouping changed
          const next = await dataService.openView(spec);
          if (handle) dataService.disposeView(handle).catch(() => {});
          handle = next; openKey = key;
        }
        const { rows } = await dataService.readWindow(handle, { startRow: 0, endRow: 1 }); // row 0 = root total
        if (alive && rows[0]) gridApi.setGridOption('pinnedBottomRowData', [rows[0]]);
      } catch { /* transient while a view reopens */ } finally { inFlight = false; }
    };

    void tick();
    const timer = window.setInterval(tick, TOTAL_MS);
    const onFilter = () => { openKey = ''; void tick(); }; // force reopen on filter change
    gridApi.addEventListener('filterChanged', onFilter);

    return () => {
      alive = false;
      window.clearInterval(timer);
      gridApi.removeEventListener('filterChanged', onFilter);
      if (handle) dataService.disposeView(handle).catch(() => {});
    };
  }, [gridApi, wired]);
}

const REF: HubRef = { datasourceId: 'positions', params: { clientId: 'react-perspective', rate: 2000, batchSize: 10 } };
const ARTIFACT_URL = '/packages/dshub-spec/corpus/positions/artifact.json';

// Which columns the demo surfaces, and what the user may do with each at runtime.
const DISPLAY: Array<[string, Partial<ColDef>]> = [
  ['desk', { rowGroup: true, hide: true }],
  ['trader', { enableRowGroup: true }],
  ['bookName', { enableRowGroup: true }],
  ['instrumentType', { enableRowGroup: true }],
  ['currency', { enablePivot: true }],
  ['marketValue', { aggFunc: 'sum' }],
  ['notionalAmount', { aggFunc: 'sum' }],
  ['dv01', { aggFunc: 'sum' }],
  ['currentPrice', {}],
  ['positionId', {}],
];

// enableCellChangeFlash: flash any cell whose value ticks (subtotals + leaves). Only
// cells that actually change flash, so it's safe to enable grid-wide.
const defaultColDef: ColDef = { sortable: true, resizable: true, filter: true, flex: 1, minWidth: 120, enableCellChangeFlash: true };

export function App() {
  const [artifact, setArtifact] = useState<any>(null);
  useEffect(() => { fetch(ARTIFACT_URL).then((r) => r.json()).then(setArtifact); }, []);
  if (!artifact) return <div className="boot">loading schema…</div>;
  return <Blotter artifact={artifact} />;
}

function Blotter({ artifact }: { artifact: any }) {
  const { wired, state } = useSsrm(REF, artifact);
  const [gridApi, setGridApi] = useState<GridApi | null>(null);
  useGrandTotal(gridApi, wired); // live hub-computed grand-total row

  // Column defs come from the datasource schema, then get the runtime capabilities.
  const columnDefs = useMemo<ColDef[]>(() => {
    if (!wired) return [];
    const all = buildColDefs(artifact, wired.dataService);
    const byId = (n: string) => all.find((d) => d.colId === n || d.field === n);
    return DISPLAY
      .map(([name, extra]) => { const d = byId(name); return d ? { ...d, ...extra } : null; })
      .filter((d): d is ColDef => d !== null);
  }, [wired, artifact]);

  if (!wired) {
    return <div className="boot">{state === 'connecting' ? 'connecting to hub…' : state}</div>;
  }
  const { ssrm, control, dataService } = wired;

  const onGridReady = (e: GridReadyEvent) => {
    setGridApi(e.api); // drives the live grand-total row
    if (import.meta.env.DEV) { (window as any).__api = e.api; (window as any).__wired = wired; } // dev handles

    // Live updates: SSRM re-fetches loaded blocks (coarse) + surgical group-route
    // refreshes from groupDelta.
    ssrm.attach(control, e.api, { refreshMs: REFRESH_MS, ref: REF });

    // Rust engine: tick leaf rows in place. SsrmMode re-fetches group aggregates
    // (subtotals) but never the loaded leaf blocks; delivery:'rows' streams the
    // changed rows, so route each to its group and update it in place. A group
    // that isn't expanded/loaded yields RouteNotFound → a harmless no-op.
    if (new URLSearchParams(location.search).get('engine') === 'rust') {
      control.on('rowDelta', (m: any) => {
        if (m?.reset) return; // initial snapshot flood — the coarse refresh handles it
        const upserts: any[] = m?.upserts ?? [];
        if (!upserts.length) return;
        const groupCols = e.api.getRowGroupColumns().map((c) => c.getColId());
        const byRoute = new Map<string, { route: string[]; update: any[] }>();
        for (const row of upserts) {
          const route = groupCols.map((col) => String(row[col]));
          const key = route.join('/');
          let bucket = byRoute.get(key);
          if (!bucket) byRoute.set(key, (bucket = { route, update: [] }));
          bucket.update.push(row);
        }
        for (const { route, update } of byRoute.values()) {
          try { e.api.applyServerSideTransaction({ route, update }); } catch { /* stale route */ }
        }
      });

      // Deep group subtotals (level ≥ 2). SsrmMode refreshes group routes via
      // refreshServerSide, which lands at depth 0–1 (root + one level) but is a
      // no-op for deeper routes with this block shape — so books/etc. under a
      // desk→trader path never tick. Push their aggregates in place instead: the
      // groupDelta already carries every changed group's path + aggregates, so
      // route each L2+ group to its parent and update the group row directly.
      control.on('groupDelta', (m: any) => {
        const groups: any[] = m?.groups ?? [];
        if (!groups.length) return;
        const groupCols = e.api.getRowGroupColumns().map((c) => c.getColId());
        const byRoute = new Map<string, { route: string[]; update: any[] }>();
        for (const g of groups) {
          const values: any[] = g?.values ?? [];
          if (values.length < 3) continue; // L0/L1 already tick via refreshServerSide
          const groupCol = groupCols[values.length - 1];
          if (!groupCol) continue;
          const route = values.slice(0, -1).map(String);
          const updateRow = { [groupCol]: values[values.length - 1], ...(g.aggregates ?? {}) };
          const key = route.join('/');
          let bucket = byRoute.get(key);
          if (!bucket) byRoute.set(key, (bucket = { route, update: [] }));
          bucket.update.push(updateRow);
        }
        for (const { route, update } of byRoute.values()) {
          try { e.api.applyServerSideTransaction({ route, update }); } catch { /* stale route */ }
        }
      });
    }

    // Re-arm the group-aggregate watch on every grouping / aggFunc / pivot change,
    // deriving the aggregates from the grid's current value columns.
    const rearm = () => {
      const groupBy = e.api.getRowGroupColumns().map((c) => c.getColId());
      if (!groupBy.length) return;
      const aggregates = Object.fromEntries(
        (e.api.getValueColumns() ?? []).map((c) => [c.getColId(), c.getAggFunc() ?? 'sum']),
      );
      ssrm.watchGroups(groupBy, aggregates as Record<string, string>);
    };
    rearm();
    e.api.addEventListener('columnRowGroupChanged', rearm);
    e.api.addEventListener('columnValueChanged', rearm);
    e.api.addEventListener('columnPivotChanged', rearm);
  };

  return (
    <div className="app">
      <header>
        <h1>positions — Perspective SharedWorker · SSRM</h1>
        <input
          className="search"
          placeholder="quick filter…"
          onInput={(ev) => ssrm.setSearch(dataService.search((ev.target as HTMLInputElement).value, ['desk', 'trader', 'bookName']))}
        />
        <span className="sub">drag columns to group / pivot · totals tick live</span>
        <span className="sub">{state}</span>
      </header>
      <div className="grid">
        <AgGridReact
          theme={blotterTheme}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          rowModelType="serverSide"
          getRowId={(p) => ssrm.getRowId(p)}
          serverSideDatasource={ssrm.datasource()}
          cacheBlockSize={200}
          maxBlocksInCache={10}
          blockLoadDebounceMillis={80}
          cellFlashDuration={300}
          cellFadeDuration={600}
          rowGroupPanelShow="always"
          pivotPanelShow="always"
          suppressAggFuncInHeader
          serverSidePivotResultFieldSeparator="|"
          autoGroupColumnDef={{
            headerName: 'Group',
            minWidth: 260,
            // label the pinned total row in the group column
            valueGetter: (p: ValueGetterParams) => (p.node?.rowPinned === 'bottom' ? 'Grand Total' : undefined),
          }}
          onGridReady={onGridReady}
        />
      </div>
    </div>
  );
}
