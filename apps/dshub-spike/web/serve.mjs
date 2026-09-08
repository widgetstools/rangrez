/** Static server rooted at the repo so /node_modules and /packages resolve. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.json':'application/json', '.wasm':'application/wasm', '.map':'application/json' };

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const path = join(ROOT, url === '/' ? 'apps/dshub-spike/web/index.html' : url);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const s = await stat(path);
    const body = await readFile(s.isDirectory() ? join(path, 'index.html') : path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      // SharedWorker + wasm want a stable origin; no caching while iterating.
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'cross-origin',
    });
    res.end(body);
  } catch (e) { res.writeHead(404, {'content-type':'text/plain'}).end(String(e.message)); }
}).listen(8099, () => console.log('http://localhost:8099'));
