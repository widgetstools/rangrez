import { useEffect, useState } from 'react';
import { useCsrm } from 'dshub-hub';
import { CsrmGrid } from './CsrmGrid';

const ARTIFACT_URL = '/dshub/artifact.json';
const HUB = { workerUrl: '/dshub/dshub-rust.worker.js', appId: 'csrm-demo' };
const REF = { datasourceId: 'positions', params: { clientId: 'csrm-demo', rate: 2000, batchSize: 10 } };

export function App() {
  const [artifact, setArtifact] = useState<any>(null);
  useEffect(() => { fetch(ARTIFACT_URL).then((r) => r.json()).then(setArtifact); }, []);
  const { wired, state } = useCsrm(REF, artifact ?? { keyColumns: ['positionId'] }, HUB);
  const launch = (n: number) => { for (let i = 0; i < n; i++) window.open(location.href, '_blank'); };

  return (
    <div className="app">
      <header>
        <h1>positions — Rust wasm hub · CSRM</h1>
        <span className="sub">whole dataset in the browser · client-side grouping · one shared hub</span>
        <span className="sub">
          {state === 'live' && wired ? `${wired.stats.rows.toLocaleString()} rows × ${wired.stats.cols} cols · snapshot ${wired.stats.snapshotMB} MB in ${wired.stats.snapshotMs} ms` : state}
        </span>
        <button className="launch" onClick={() => launch(9)}>open 9 more tabs</button>
      </header>
      {wired ? <CsrmGrid wired={wired} artifact={artifact} /> : <div className="boot">{state}</div>}
    </div>
  );
}
