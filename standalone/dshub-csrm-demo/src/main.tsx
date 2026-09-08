import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ModuleRegistry } from 'ag-grid-community';
import { AllEnterpriseModule } from 'ag-grid-enterprise';
import { App } from './App';
import './styles.css';

ModuleRegistry.registerModules([AllEnterpriseModule]);
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
