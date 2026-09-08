// Mock STOMP view server — mimics the real stomp-view-server the hub connects to.
//
// Protocol (STOMP 1.2 over WebSocket), matching the example config:
//   client → CONNECT                → server → CONNECTED
//   client → SUBSCRIBE /snapshot/…   (the hub listens here first, §5.5)
//   client → SEND      /snapshot/…   (the trigger)
//   server → MESSAGE … (snapshot batches) … then a completion sentinel
//   server → MESSAGE … (live updates every 3s)
//
// Reuses the project's own STOMP codec so the frames are exactly what the hub's
// Rust STOMP client parses.
import { WebSocketServer } from 'ws';
import { encodeFrame, FrameBuffer } from '/Users/develop/wfh/rangrez/packages/dshub-worker/src/adapters/stomp-codec.mjs';

const DESKS = ['Govies', 'EM Debt', 'HY Credit'];
const TRADERS = ['Jane', 'John', 'Sara'];
const rows = Array.from({ length: 36 }, (_, i) => ({
  positionId: `POS-${String(i).padStart(3, '0')}`,
  desk: DESKS[i % 3], trader: TRADERS[(i >> 1) % 3],
  qty: (i + 1) * 10, pnl: (i % 5) * 1000 - 2000,
}));

const wss = new WebSocketServer({ port: 8071 });
console.log('mock STOMP view server on ws://127.0.0.1:8071');

wss.on('connection', (sock) => {
  const fb = new FrameBuffer();
  let subDest = null, mid = 0, timer = null;
  const send = (f) => { if (sock.readyState === sock.OPEN) sock.send(encodeFrame(f)); };
  const message = (dest, body, extra = {}) => send({
    command: 'MESSAGE',
    headers: { destination: dest, subscription: 'sub-0', 'message-id': `m${mid++}`, 'content-type': 'application/json', ...extra },
    body,
  });

  sock.on('message', (data) => {
    let frames;
    try { frames = fb.push(data.toString()); } catch { return; }
    for (const f of frames) {
      if (f.command === 'CONNECT') {
        console.log('  ← CONNECT; → CONNECTED');
        send({ command: 'CONNECTED', headers: { version: '1.2', 'heart-beat': '0,0', server: 'mock-view-server/1.0' }, body: '' });
      } else if (f.command === 'SUBSCRIBE') {
        subDest = f.headers.destination;
        console.log(`  ← SUBSCRIBE ${subDest}`);
      } else if (f.command === 'SEND') {
        const dest = subDest ?? f.headers.destination;
        console.log(`  ← SEND (trigger) ${f.headers.destination}; → snapshot on ${dest}`);
        message(dest, JSON.stringify(rows.slice(0, 18)));      // snapshot batch 1
        message(dest, JSON.stringify(rows.slice(18)));         // snapshot batch 2
        message(dest, `all ${rows.length} rows`, { snapshot: 'complete' }); // sentinel (non-JSON; hub skips)
        timer = setInterval(() => {
          const i = mid % 36;
          const upd = { positionId: rows[i].positionId, qty: rows[i].qty + mid, pnl: rows[i].pnl + (mid % 7) * 500 };
          message(dest, JSON.stringify([upd]));                // live tick
        }, 3000);
      }
    }
  });
  sock.on('close', () => { if (timer) clearInterval(timer); });
});
