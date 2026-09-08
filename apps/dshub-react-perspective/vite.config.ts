import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

// The SharedWorker (from apps/dshub-spike/web) and its Perspective wasm must be
// served SAME-ORIGIN and untouched — so the worker runs byte-identical to the
// proven spike rather than through Vite's bundler. This middleware serves those
// exact paths raw from the repo root. The React app itself is a normal bundled
// Vite app. (No COOP/COEP: the inline Perspective build is single-threaded and
// uses no SharedArrayBuffer, so cross-origin isolation isn't needed.)
const FLAT_PREFIXES = ['/packages/', '/node_modules/@perspective-dev/', '/apps/dshub-spike/', '/hub-rust/'];
const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.map': 'application/json', '.html': 'text/html',
};

function serveRepoFlat(): Plugin {
  return {
    name: 'serve-repo-flat',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]);
        if (!FLAT_PREFIXES.some((p) => url.startsWith(p))) return next();
        const path = join(REPO_ROOT, url);
        if (!path.startsWith(REPO_ROOT)) { res.statusCode = 403; return res.end(); }
        try {
          const s = await stat(path);
          if (s.isDirectory()) return next();
          res.setHeader('content-type', MIME[extname(path)] ?? 'application/octet-stream');
          res.setHeader('cache-control', 'no-store');
          res.statusCode = 200;
          res.end(await readFile(path));
        } catch { next(); }
      });
    },
  };
}

export default defineConfig({
  plugins: [serveRepoFlat(), react()],
  server: {
    port: 5174,
    fs: { allow: ['..', '../..'] },
  },
  // The provider ships ESM source; let Vite transform it rather than pre-bundle.
  optimizeDeps: { exclude: ['@wellsfargo-starui/dshub-provider', '@wellsfargo-starui/dshub-spec'] },
});
