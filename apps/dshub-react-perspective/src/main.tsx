import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ModuleRegistry } from 'ag-grid-community';
import { AllEnterpriseModule } from 'ag-grid-enterprise';
import { App } from './App';
import { CsrmApp } from './CsrmApp';
import './styles.css';

// SSRM, grouping, the set filter, and pivot are all Enterprise features.
ModuleRegistry.registerModules([AllEnterpriseModule]);

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// ?model=csrm → client-side row model (whole snapshot + live transactions);
// default → SSRM (windowed). Both talk to the same shared Rust wasm hub.
const Root = new URLSearchParams(location.search).get('model') === 'csrm' ? CsrmApp : App;

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
