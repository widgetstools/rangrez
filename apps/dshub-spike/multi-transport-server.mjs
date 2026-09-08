/**
 * Replays the captured positions corpus over REST and raw WebSocket.
 *
 * Phase 6's exit criterion is that every browser-reachable transport serves the
 * SAME blotter from config alone. Asserting that in unit tests only proves the
 * adapters parse what the tests feed them; this serves the real captured rows
 * so the claim is end-to-end.
 *
 *   GET  /rest/positions?offset&limit   paginated snapshot, X-Total-Count header
 *   ws://host/ws                        subscribe -> snapshot batches -> {type:'end'} -> updates
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { WebSocketServer } from 'ws';

const CORPUS = new URL('../../packages/dshub-spec/corpus/positions/raw.jsonl', import.meta.url);
const PORT = Number(process.argv[2] ?? 8123);
const LIMIT = Number(process.argv[3] ?? 20000);

const snapshot = [];
const live = [];

async function load() {
  const rl = createInterface({ input: createReadStream(CORPUS), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.phase === 'snapshot') { if (snapshot.length < LIMIT) snapshot.push(rec.row); }
    else if (live.length < 5000) live.push(rec.row);
    if (snapshot.length >= LIMIT && live.length >= 5000) break;
  }
  console.log(`loaded ${snapshot.length} snapshot rows, ${live.length} live rows`);
}

await load();

// ---------------------------------------------------------------- REST
const http = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');

  if (url.pathname === '/rest/positions') {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 1000);
    const page = snapshot.slice(offset, offset + limit);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Total-Count', String(snapshot.length));
    res.end(JSON.stringify(page));
    return;
  }
  res.statusCode = 404;
  res.end('no');
});

// ---------------------------------------------------------------- raw WS
const wss = new WebSocketServer({ server: http, path: '/ws' });
wss.on('connection', (ws) => {
  let subscribed = false;
  let snapshotRequested = false;
  let timer = null;

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(String(buf)); } catch { return; }

    if (msg.type === 'subscribe') {
      subscribed = true;
      // A pure update socket — which is what `rest-then-subscribe` opens — only
      // ever subscribes; it never asks for a snapshot. Waiting for a trigger
      // here would mean REST datasources silently never receive updates.
      setTimeout(() => { if (!snapshotRequested) startUpdates(); }, 200);
      return;
    }
    if (msg.req !== 'snap') return;
    snapshotRequested = true;

    // Snapshot in batches, then the sentinel.
    const BATCH = 500;
    let i = 0;
    const pump = () => {
      if (ws.readyState !== ws.OPEN) return;
      if (i >= snapshot.length) {
        ws.send(JSON.stringify({ type: 'end', total: snapshot.length }));
        if (subscribed) startUpdates();
        return;
      }
      ws.send(JSON.stringify(snapshot.slice(i, i + BATCH)));
      i += BATCH;
      setImmediate(pump);
    };
    pump();
  });

  function startUpdates() {
    if (timer) return;
    let k = 0;
    timer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return clearInterval(timer);
      const batch = [];
      for (let n = 0; n < 10; n++) batch.push(live[(k++) % live.length]);
      ws.send(JSON.stringify(batch));
    }, 50);
  }

  ws.on('close', () => { if (timer) clearInterval(timer); });
});

http.listen(PORT, () => console.log(`REST  http://localhost:${PORT}/rest/positions`));
