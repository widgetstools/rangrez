// Persistent mock upstream feed: 36 positions on connect, then a live tick
// every 3s so deltas/alerts/group-deltas are observable. Runs until killed.
import { WebSocketServer } from 'ws';
const DESKS = ['Govies', 'EM Debt', 'HY Credit'];
const TRADERS = ['Jane', 'John', 'Sara'];
const rows = Array.from({ length: 36 }, (_, i) => ({
  positionId: `POS-${String(i).padStart(3, '0')}`,
  desk: DESKS[i % 3], trader: TRADERS[(i >> 1) % 3],
  qty: (i + 1) * 10, pnl: (i % 5) * 1000 - 2000,
}));
const wss = new WebSocketServer({ port: 8820 });
let tick = 0;
wss.on('connection', (s) => {
  s.on('message', () => {});
  s.send(JSON.stringify(rows));                 // snapshot
  const t = setInterval(() => {
    const i = tick % 36; tick++;
    const upd = { positionId: rows[i].positionId, qty: rows[i].qty + tick, pnl: rows[i].pnl + (tick % 7) * 500 };
    if (s.readyState === s.OPEN) s.send(JSON.stringify([upd]));
  }, 3000);
  s.on('close', () => clearInterval(t));
});
console.log('mock feed listening on ws://127.0.0.1:8820');
