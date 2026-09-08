/**
 * Capture a real corpus from the STOMP view server.
 *
 * Writes packages/dshub-spec/corpus/positions/raw.jsonl — the Phase 1
 * deliverable ("initial recordings from two real datasources") and the input
 * to Phase 3's inference run.
 *
 * Captures BOTH phases, because they have different shapes and the difference
 * is the whole point:
 *   - snapshot  (message-type: snapshot)      full records
 *   - live      (message-type: live-update)   PARTIAL patches, <=15 hot fields
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FrameBuffer, encodeFrame } from '../../../packages/dshub-worker/src/adapters/stomp-codec.mjs';

const URL_ = process.env.WS_URL ?? 'ws://localhost:8081';
const CLIENT = 'trd1';
const RATE = process.env.RATE ?? '2000';
const BATCH = process.env.BATCH ?? '10';
const LISTEN = `/snapshot/positions/${CLIENT}`;
const TRIGGER = `/snapshot/positions/${CLIENT}/${RATE}/${BATCH}`;
const OUT = join(import.meta.dirname, '../../../packages/dshub-spec/corpus/positions');
const LIVE_TARGET = 3000;

const ws = new WebSocket(URL_);
const fb = new FrameBuffer();
const snapshot = [];
const live = [];
let complete = null;
let snapshotDoneAt = null;
const t0 = Date.now();

ws.onopen = () => ws.send(encodeFrame({
  command: 'CONNECT', headers: { 'accept-version': '1.2', host: 'localhost', 'heart-beat': '0,0' },
}));

ws.onmessage = (ev) => {
  const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
  for (const f of fb.push(text)) {
    if (f.command === 'CONNECTED') {
      ws.send(encodeFrame({ command: 'SUBSCRIBE', headers: { id: 'sub-0', destination: LISTEN, ack: 'auto' } }));
      ws.send(encodeFrame({ command: 'SEND', headers: { destination: TRIGGER, 'content-length': '0' }, body: '' }));
      console.log(`subscribed ${LISTEN}\ntriggered  ${TRIGGER}`);
      continue;
    }
    if (f.command !== 'MESSAGE') continue;

    const kind = f.headers['message-type'];
    if (kind === 'snapshot-complete' || f.body.startsWith('Success:')) {
      complete = { headers: f.headers, body: f.body };
      snapshotDoneAt = Date.now() - t0;
      console.log(`snapshot complete at +${snapshotDoneAt}ms — ${snapshot.length} records`);
      console.log(`  ${f.body.trim()}`);
      continue;
    }

    let rows;
    try { rows = JSON.parse(f.body); } catch { continue; }
    if (!Array.isArray(rows)) rows = [rows];

    if (kind === 'live-update' || snapshotDoneAt !== null) {
      for (const r of rows) live.push(r);
      if (live.length >= LIVE_TARGET) { console.log(`captured ${live.length} live updates`); finish(); }
    } else {
      for (const r of rows) snapshot.push(r);
    }
  }
};

ws.onerror = (e) => console.log('ws error:', e.message ?? e.type);

let done = false;
function finish() {
  if (done) return; done = true;
  try { ws.close(); } catch {}

  mkdirSync(OUT, { recursive: true });
  const jsonl = [
    ...snapshot.map((r) => JSON.stringify({ phase: 'snapshot', row: r })),
    ...(complete ? [JSON.stringify({ phase: 'complete', headers: complete.headers, body: complete.body })] : []),
    ...live.map((r) => JSON.stringify({ phase: 'live', row: r })),
  ].join('\n');
  writeFileSync(join(OUT, 'raw.jsonl'), jsonl + '\n');

  // What actually differs between the two phases is the finding.
  const snapKeys = new Set(snapshot.flatMap((r) => Object.keys(r)));
  const liveKeyCounts = new Map();
  for (const r of live) for (const k of Object.keys(r)) liveKeyCounts.set(k, (liveKeyCounts.get(k) ?? 0) + 1);
  const liveSizes = live.map((r) => Object.keys(r).length);

  const meta = {
    capturedAt: new Date().toISOString(),
    source: { url: URL_, listen: LISTEN, trigger: TRIGGER },
    snapshot: { records: snapshot.length, distinctFields: snapKeys.size, tookMs: snapshotDoneAt },
    live: {
      records: live.length,
      minFieldsPerUpdate: Math.min(...liveSizes),
      maxFieldsPerUpdate: Math.max(...liveSizes),
      avgFieldsPerUpdate: +(liveSizes.reduce((a, b) => a + b, 0) / liveSizes.length).toFixed(1),
      mutatedFields: [...liveKeyCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`),
    },
  };
  writeFileSync(join(OUT, 'capture-meta.json'), JSON.stringify(meta, null, 2) + '\n');

  console.log('\n=== capture ===');
  console.log(`snapshot: ${meta.snapshot.records} records, ${meta.snapshot.distinctFields} fields, ${meta.snapshot.tookMs}ms`);
  console.log(`live:     ${meta.live.records} updates, ${meta.live.minFieldsPerUpdate}-${meta.live.maxFieldsPerUpdate} fields each (avg ${meta.live.avgFieldsPerUpdate})`);
  console.log(`mutated fields (${liveKeyCounts.size}):`, meta.live.mutatedFields.slice(0, 20).join(' '));
  console.log(`\nwrote ${OUT}/raw.jsonl`);
  process.exit(0);
}

setTimeout(finish, 45_000);
