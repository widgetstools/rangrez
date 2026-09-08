import { useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { useHubProvider } from './hub/useHubProvider';
import type { GridMode } from './hub/types';
import { GRID_HINTS, HUB_URL, POSITIONS } from './datasource';
import { blotterTheme } from './theme';

const defaultColDef = { sortable: true, resizable: true, filter: true, flex: 1, minWidth: 110 };

function Blotter({ mode }: { mode: GridMode }) {
  // remount on mode change (key below) so the provider is rebuilt for the new mode
  const { dp, state } = useHubProvider({
    hubUrl: HUB_URL,
    mode,
    params: { clientId: `react-demo-${mode}`, rate: 2000, batchSize: 10 },
    grid: { group: [...GRID_HINTS.group], agg: { ...GRID_HINTS.agg } },
    datasource: POSITIONS,
  });

  if (state !== 'live') {
    return <div className="boot">{state === 'connecting' ? 'connecting to hub…' : state}</div>;
  }

  return (
    <div className="grid">
      <AgGridReact
        theme={blotterTheme}
        columnDefs={dp.columnDefs()}
        defaultColDef={defaultColDef}
        {...dp.gridOptions()}
        onGridReady={(e) => dp.attach(e.api)}
      />
    </div>
  );
}

export function App() {
  const [mode, setMode] = useState<GridMode>('ssrm');
  return (
    <div className="app">
      <header>
        <h1>DataSource Hub</h1>
        <div className="modes" role="tablist" aria-label="Row model">
          {(['ssrm', 'csrm'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? 'on' : ''}
              onClick={() => setMode(m)}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="sub">&lt;AgGridReact&gt; ⟶ HubDataProvider ⟶ hub :8787 ⟶ STOMP :8081</span>
      </header>
      {/* key forces a clean remount (fresh provider + subscription) when the mode flips */}
      <Blotter key={mode} mode={mode} />
    </div>
  );
}
