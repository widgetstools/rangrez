import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridReadyEvent } from 'ag-grid-community';
import { buildColDefs } from '@wellsfargo-starui/dshub-provider/src/coldefs.mjs';
import { useCsrm, type HubRef, type CsrmWired } from './useCsrm';
import { blotterTheme } from './theme';

const REF: HubRef = { datasourceId: 'positions', params: { clientId: 'react-perspective', rate: 2000, batchSize: 10 } };
const ARTIFACT_URL = '/packages/dshub-spec/corpus/positions/artifact.json';

// Client-side grouping/agg — AG-Grid's own engine does this over the whole dataset.
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

const defaultColDef: ColDef = { sortable: true, resizable: true, filter: true, flex: 1, minWidth: 120, enableCellChangeFlash: true };

// Split a rowDelta into AG-Grid add/update/remove using a known-key set, then apply.
function applyDelta(api: any, m: any, known: Set<string>) {
  const add: any[] = [];
  const update: any[] = [];
  for (const row of m.upserts ?? []) {
    const k = row.__key;
    if (known.has(k)) update.push(row);
    else { known.add(k); add.push(row); }
  }
  const remove: any[] = [];
  for (const k of m.removals ?? []) if (known.delete(k)) remove.push({ __key: k });
  if (add.length || update.length || remove.length) api.applyTransactionAsync({ add, update, remove });
}

function Blotter({ wired }: { wired: CsrmWired }) {
  const gridRef = useRef<AgGridReact>(null);
  const [artifact, setArtifact] = useState<any>(null);
  useEffect(() => { fetch(ARTIFACT_URL).then((r) => r.json()).then(setArtifact); }, []);

  const columnDefs = useMemo<ColDef[]>(() => {
    if (!artifact) return [];
    const all = buildColDefs(artifact, null as any);
    const byId = (n: string) => all.find((d: any) => d.colId === n || d.field === n);
    return DISPLAY.map(([name, extra]) => { const d = byId(name); return d ? { ...d, ...extra } : null; })
      .filter((d): d is ColDef => d !== null);
  }, [artifact]);

  const onGridReady = (e: GridReadyEvent) => {
    if (import.meta.env.DEV) { (window as any).__api = e.api; (window as any).__wired = wired; }
    const known = new Set<string>(wired.initialRows.map((r) => r.__key));
    // Drain deltas buffered during snapshot load, THEN go live — one synchronous
    // pass, so no delta slips through between drain and switch.
    for (const m of wired.stream.buffer) applyDelta(e.api, m, known);
    wired.stream.buffer.length = 0;
    wired.stream.live = (m: any) => applyDelta(e.api, m, known);
  };

  if (!artifact) return <div className="boot">loading schema…</div>;
  return (
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
      pivotPanelShow="always"
      suppressAggFuncInHeader
      grandTotalRow="bottom"
      autoGroupColumnDef={{ headerName: 'Group', minWidth: 260 }}
      onGridReady={onGridReady}
    />
  );
}

// How many CSRM clients is the shared hub serving right now?
function useSessionCount(wired: CsrmWired | null): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!wired) return;
    let alive = true;
    const poll = async () => {
      try { const d: any = await wired.control.request({ type: 'debug' }); if (alive) setN(d.payload.sessionCount); } catch { /* ignore */ }
    };
    void poll();
    const t = window.setInterval(poll, 2000);
    return () => { alive = false; window.clearInterval(t); };
  }, [wired]);
  return n;
}

export function CsrmApp() {
  const [artifact, setArtifact] = useState<any>(null);
  useEffect(() => { fetch(ARTIFACT_URL).then((r) => r.json()).then(setArtifact); }, []);
  const { wired, state } = useCsrm(REF, artifact);
  const sessions = useSessionCount(wired);

  const launch = (count: number) => { for (let i = 0; i < count; i++) window.open(location.href, '_blank'); };

  return (
    <div className="app">
      <header>
        <h1>positions — Rust wasm hub · CSRM</h1>
        <span className="sub">whole dataset in the browser · grouping &amp; agg client-side · live via transactions</span>
        <span className="sub">
          {state === 'live' && wired
            ? `${wired.stats.rows.toLocaleString()} rows × ${wired.stats.cols} cols · snapshot ${wired.stats.snapshotMB} MB in ${wired.stats.snapshotMs} ms`
            : state}
        </span>
        <span className="sub">one shared hub · {sessions ?? '…'} client{sessions === 1 ? '' : 's'}</span>
        <button className="launch" onClick={() => launch(9)}>open 9 more tabs</button>
      </header>
      <div className="grid">
        {wired ? <Blotter wired={wired} /> : <div className="boot">{state}</div>}
      </div>
    </div>
  );
}
