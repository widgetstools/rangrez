// Static server rooted at the repo so /node_modules, /packages, /.demo resolve.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, normalize } from 'node:path';
const ROOT = resolve(import.meta.dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.map': 'application/json', '.wasm': 'application/wasm' };
createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let path = normalize(join(ROOT, url));
    if (!path.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
    const s = await stat(path).catch(() => null);
    if (!s) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + url); return; }
    const body = await readFile(s.isDirectory() ? join(path, 'index.html') : path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e.message)); }
}).listen(8930, '127.0.0.1', () => console.log('demo server: http://127.0.0.1:8930/.demo/app.html'));
