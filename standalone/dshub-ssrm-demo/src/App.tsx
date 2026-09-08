import { useEffect, useState } from 'react';
import { SsrmGrid } from './SsrmGrid';

// The artifact (column schema) is served with the runtime.
const ARTIFACT_URL = '/dshub/artifact.json';

export function App() {
  const [artifact, setArtifact] = useState<any>(null);
  useEffect(() => { fetch(ARTIFACT_URL).then((r) => r.json()).then(setArtifact); }, []);
  if (!artifact) return <div className="boot">loading schema…</div>;
  return (
    <div className="app">
      <header>
        <h1>positions — Rust wasm hub · SSRM</h1>
        <span className="sub">two independent grids · one shared SharedWorker hub &amp; cache</span>
      </header>
      <div className="grids">
        <div className="pane">
          <div className="cap">Grid A — grouped by Desk</div>
          <SsrmGrid artifact={artifact} groupCols={['desk']} />
        </div>
        <div className="pane">
          <div className="cap">Grid B — grouped by Trader → BookName</div>
          <SsrmGrid artifact={artifact} groupCols={['trader', 'bookName']} />
        </div>
      </div>
    </div>
  );
}
