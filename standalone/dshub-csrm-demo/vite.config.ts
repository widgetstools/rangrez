import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

// Serve the installed dshub-hub runtime (SharedWorker + wasm + STOMP adapter + config)
// raw & same-origin at /dshub/. This is the "serve the runtime" step from the README.
function serveDshubRuntime(): Plugin {
  const dir = resolve(import.meta.dirname, 'node_modules/dshub-hub/runtime');
  const MIME: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
  return {
    name: 'serve-dshub-runtime',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]);
        if (!url.startsWith('/dshub/')) return next();
        const path = join(dir, url.slice('/dshub/'.length));
        if (!path.startsWith(dir)) { res.statusCode = 403; return res.end(); }
        readFile(path).then((buf) => {
          res.setHeader('content-type', MIME[extname(path)] ?? 'application/octet-stream');
          res.setHeader('cache-control', 'no-store');
          res.end(buf);
        }).catch(() => next());
      });
    },
  };
}

export default defineConfig({
  plugins: [serveDshubRuntime(), react()],
  server: { port: 5176 },
  optimizeDeps: { exclude: ['dshub-hub'] },
});
