import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ModuleRegistry } from 'ag-grid-community';
import { AllEnterpriseModule } from 'ag-grid-enterprise';
import { App } from './App';
import './styles.css';

// SSRM + Set Filter + grouping/aggregation are all Enterprise features.
ModuleRegistry.registerModules([AllEnterpriseModule]);

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
