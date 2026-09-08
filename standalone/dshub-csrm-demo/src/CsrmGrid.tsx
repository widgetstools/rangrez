import { useMemo, useRef } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridReadyEvent } from 'ag-grid-community';
import { applyCsrmDelta, buildColDefs } from 'dshub-hub';
import { blotterTheme } from './theme';

const DISPLAY = ['desk', 'trader', 'bookName', 'instrumentType', 'currency', 'marketValue', 'notionalAmount', 'dv01', 'currentPrice', 'positionId'];
const VALUES = new Set(['marketValue', 'notionalAmount', 'dv01']);
const defaultColDef: ColDef = { sortable: true, resizable: true, filter: true, flex: 1, minWidth: 120, enableCellChangeFlash: true };

function defs(artifact: any): ColDef[] {
  const all = buildColDefs(artifact, null);
  const byId = (n: string) => all.find((d: any) => d.colId === n || d.field === n);
  return DISPLAY.map((name) => {
    const d = byId(name); if (!d) return null;
    const extra: Partial<ColDef> = {};
    if (name === 'desk') { extra.rowGroup = true; extra.hide = true; }
    else if (['trader', 'bookName', 'instrumentType'].includes(name)) extra.enableRowGroup = true;
    if (VALUES.has(name)) extra.aggFunc = 'sum';
    return { ...d, ...extra };
  }).filter((d): d is ColDef => d !== null);
}

export function CsrmGrid({ wired, artifact }: { wired: any; artifact: any }) {
  const gridRef = useRef<AgGridReact>(null);
  const columnDefs = useMemo(() => defs(artifact), [artifact]);
  const onGridReady = (e: GridReadyEvent) => {
    const known = new Set<string>(wired.initialRows.map((r: any) => r.__key));
    for (const m of wired.stream.buffer) applyCsrmDelta(e.api, m, known);
    wired.stream.buffer.length = 0;
    wired.stream.live = (m: any) => applyCsrmDelta(e.api, m, known);
  };
  return (
    <div className="grid">
      <AgGridReact
        ref={gridRef}
        theme={blotterTheme}
        rowData={wired.initialRows}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        getRowId={(p) => p.data.__key}
        cellFlashDuration={300}
        cellFadeDuration={600}
        rowGroupPanelShow="always"
        suppressAggFuncInHeader
        grandTotalRow="bottom"
        autoGroupColumnDef={{ headerName: 'Group', minWidth: 260 }}
        onGridReady={onGridReady}
      />
    </div>
  );
}
