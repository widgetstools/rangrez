import { WebSocket } from 'ws';
import { ControlClient } from '/Users/develop/wfh/rangrez/packages/dshub-provider/src/control.mjs';
import { Transport } from '/Users/develop/wfh/rangrez/packages/dshub-provider/src/transport.mjs';
import { socketIoPort } from '/Users/develop/wfh/rangrez/packages/dshub-provider/src/socketPort.mjs';

const control = new ControlClient({ send: (m) => transport.send(m), timeoutMs: 8000 });
const transport = new Transport({ connect: () => socketIoPort('ws://127.0.0.1:8787', { openSocket: (u) => new WebSocket(u) }), onControl: (m) => control.handle(m) });
transport.open();
const ref = { datasourceId: 'positions', params: { clientId: 'ssrm-app', rate: 50000, batchSize: 1000 } };
const q = async () => {
  const rc = await control.request({ type: 'rowCount', ref, view: { filter: [] } });
  const agg = await control.request({ type: 'aggregates', ref, specs: [{ column: 'marketValue', fn: 'sum', as: 'mv' }, { column: 'currentPrice', fn: 'avg', as: 'px' }], view: { filter: [] } });
  return { rows: rc.payload, mv: agg.payload.mv, px: agg.payload.px };
};
try {
  await control.request({ type: 'hello', appId: 'diag', protocolVersion: 1 });
  await control.request({ type: 'subscribe', ref });  // attaches to the existing shared cache
  for (let i = 0; i < 5; i++) {
    const s = await q();
    console.log(`  t${i * 2}s  rows=${s.rows}  ΣmarketValue=${Math.round(s.mv).toLocaleString()}  avg(price)=${s.px?.toFixed(4)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
} catch (e) { console.log('ERR', e.code || '', e.message); }
finally { transport.close(); setTimeout(() => process.exit(0), 80); }
