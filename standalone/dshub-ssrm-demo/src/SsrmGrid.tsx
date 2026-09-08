import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridReadyEvent } from 'ag-grid-community';
import { useSsrm, attachSsrmLiveTicks, buildColDefs } from 'dshub-hub';
import { blotterTheme } from './theme';

const HUB = { workerUrl: '/dshub/dshub-rust.worker.js', appId: 'ssrm-demo' };
const REF = { datasourceId: 'positions', params: { clientId: 'ssrm-demo', rate: 2000, batchSize: 10 } };
const DISPLAY = ['desk', 'trader', 'bookName', 'instrumentType', 'currency', 'marketValue', 'notionalAmount', 'dv01', 'currentPrice', 'positionId'];
const VALUES = new Set(['marketValue', 'notionalAmount', 'dv01']);
const defaultColDef: ColDef = { sortable: true, resizable: true, filter: true, flex: 1, minWidth: 120, enableCellChangeFlash: true };

function pickDefs(artifact: any, dataService: any, groupCols: string[]): ColDef[] {
  const all = buildColDefs(artifact, dataService);
  const byId = (n: string) => all.find((d: any) => d.colId === n || d.field === n);
  return DISPLAY.map((name) => {
    const d = byId(name); if (!d) return null;
    const extra: Partial<ColDef> = {};
    if (groupCols.includes(name)) { extra.rowGroup = true; extra.hide = true; }
    else if (['trader', 'bookName', 'instrumentType'].includes(name)) extra.enableRowGroup = true;
    if (VALUES.has(name)) extra.aggFunc = 'sum';
    return { ...d, ...extra };
  }).filter((d): d is ColDef => d !== null);
}

export function SsrmGrid({ artifact, groupCols }: { artifact: any; groupCols: string[] }) {
  const { wired, state } = useSsrm(REF, artifact, { ...HUB, searchColumns: ['desk', 'trader', 'bookName'] });
  const columnDefs = useMemo(() => (wired ? pickDefs(artifact, wired.dataService, groupCols) : []), [wired, artifact, groupCols]);

  if (!wired) return <div className="boot">{state}</div>;
  const { ssrm, control } = wired;
  const onGridReady = (e: GridReadyEvent) => {
    ssrm.attach(control, e.api, { refreshMs: 200, ref: REF });
    attachSsrmLiveTicks(e.api, control); // per-cell + deep-group live ticking
    const rearm = () => {
      const gb = e.api.getRowGroupColumns().map((c) => c.getColId());
      if (!gb.length) return;
      const agg = Object.fromEntries((e.api.getValueColumns() ?? []).map((c) => [c.getColId(), c.getAggFunc() ?? 'sum']));
      ssrm.watchGroups(gb, agg as Record<string, string>);
    };
    rearm();
    e.api.addEventListener('columnRowGroupChanged', rearm);
    e.api.addEventListener('columnValueChanged', rearm);
  };
  return (
    <div className="grid">
      <AgGridReact
        theme={blotterTheme}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        rowModelType="serverSide"
        serverSideDatasource={ssrm.datasource()}
        getRowId={(p) => ssrm.getRowId(p)}
        cacheBlockSize={200}
        cellFlashDuration={300}
        cellFadeDuration={600}
        rowGroupPanelShow="always"
        suppressAggFuncInHeader
        autoGroupColumnDef={{ headerName: 'Group', minWidth: 240 }}
        onGridReady={onGridReady}
      />
    </div>
  );
}
