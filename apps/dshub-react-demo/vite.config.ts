import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The DataSource Hub provider package (@wellsfargo-starui/dshub-provider) lives
// elsewhere in the monorepo and is symlinked into node_modules. It ships plain
// ESM source, so let Vite read it from the workspace root and don't pre-bundle it.
export default defineConfig({
  plugins: [react()],
  server: {
    // preferred port; if it's taken Vite falls back to the next free one and
    // prints the actual URL, rather than failing to start
    port: 5173,
    fs: { allow: ['..', '../..'] },
  },
  optimizeDeps: {
    exclude: ['@wellsfargo-starui/dshub-provider'],
  },
});
