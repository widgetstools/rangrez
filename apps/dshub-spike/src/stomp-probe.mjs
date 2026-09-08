/**
 * Probe the local STOMP server: connect, subscribe, trigger a snapshot, and
 * report the ACTUAL frame shapes.
 *
 * This is the "test connection" flow the admin UI needs (plan Phase 7) and the
 * ground truth the schema inference has been missing.
 */

import { FrameBuffer, encodeFrame, negotiateHeartbeat } from '../../../packages/dshub-worker/src/adapters/stomp-codec.mjs';

const URL_ = 'ws://localhost:8081';
const LISTEN = '/snapshot/positions/trd1';
const TRIGGER = '/snapshot/positions/trd1/1000/10';
const END_TOKEN = 'success';

const ws = new WebSocket(URL_);
const fb = new FrameBuffer();
const seen = new Map();          // command -> count
const bodies = [];               // first N message bodies
let connectedHeaders = null;
let firstMessageAt = null;
let endTokenAt = null;
const t0 = Date.now();

const send = (f) => ws.send(encodeFrame(f));
const bump = (c) => seen.set(c, (seen.get(c) ?? 0) + 1);

ws.onopen = () => {
  console.log(`connected to ${URL_}`);
  send({ command: 'CONNECT', headers: { 'accept-version': '1.2', host: 'localhost', 'heart-beat': '10000,10000' } });
};

ws.onerror = (e) => { console.log('ws error:', e.message ?? e.type); };
ws.onclose = (e) => { console.log(`closed: code=${e.code} reason=${e.reason || '(none)'}`); report(); };

ws.onmessage = (ev) => {
  const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
  for (const f of fb.push(text)) {
    bump(f.command);

    if (f.command === 'CONNECTED') {
      connectedHeaders = f.headers;
      console.log('CONNECTED headers:', JSON.stringify(f.headers));
      console.log('heartbeat negotiated:', JSON.stringify(negotiateHeartbeat('10000,10000', f.headers['heart-beat'])));

      // Subscribe BEFORE triggering — otherwise there is a gap (arch §5.5).
      send({ command: 'SUBSCRIBE', headers: { id: 'sub-0', destination: LISTEN, ack: 'auto' } });
      console.log(`SUBSCRIBE ${LISTEN}`);
      send({ command: 'SEND', headers: { destination: TRIGGER, 'content-length': '0' }, body: '' });
      console.log(`SEND (trigger) ${TRIGGER}\n`);
      continue;
    }

    if (f.command === 'ERROR') { console.log('ERROR frame:', JSON.stringify(f.headers), f.body.slice(0, 300)); continue; }
    if (f.command === 'HEARTBEAT') continue;

    if (f.command === 'MESSAGE') {
      if (firstMessageAt === null) {
        firstMessageAt = Date.now() - t0;
        console.log(`first MESSAGE at +${firstMessageAt}ms`);
        console.log('  headers:', JSON.stringify(f.headers));
        console.log('  body[0:400]:', f.body.slice(0, 400));
      }
      if (bodies.length < 5) bodies.push(f.body);

      // The configured end-of-snapshot rule: case-insensitive substring.
      const hay = (f.body + ' ' + JSON.stringify(f.headers)).toLowerCase();
      if (endTokenAt === null && hay.includes(END_TOKEN)) {
        endTokenAt = Date.now() - t0;
        console.log(`\nEND TOKEN "${END_TOKEN}" seen at +${endTokenAt}ms after ${seen.get('MESSAGE')} MESSAGE frames`);
        console.log('  terminating frame headers:', JSON.stringify(f.headers));
        console.log('  terminating frame body:', f.body.slice(0, 300));
        setTimeout(() => { try { ws.close(); } catch {} }, 1500);
      }
    }
  }
};

function report() {
  console.log('\n=== summary ===');
  console.log('frames by command:', JSON.stringify(Object.fromEntries(seen)));
  console.log('first message at:', firstMessageAt, 'ms');
  console.log('end token at:', endTokenAt, 'ms');
  console.log('\n=== sample bodies ===');
  bodies.forEach((b, i) => console.log(`[${i}] ${b.slice(0, 300)}`));
  process.exit(0);
}

setTimeout(() => { console.log('\n(timeout)'); try { ws.close(); } catch {} report(); }, 30_000);
