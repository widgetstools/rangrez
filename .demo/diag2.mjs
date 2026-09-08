import { WebSocket } from 'ws';
import { ControlClient } from '/Users/develop/wfh/rangrez/packages/dshub-provider/src/control.mjs';
import { Transport } from '/Users/develop/wfh/rangrez/packages/dshub-provider/src/transport.mjs';
import { socketIoPort } from '/Users/develop/wfh/rangrez/packages/dshub-provider/src/socketPort.mjs';
const control = new ControlClient({ send: (m) => transport.send(m), timeoutMs: 8000 });
const transport = new Transport({ connect: () => socketIoPort('ws://127.0.0.1:8787', { openSocket: (u) => new WebSocket(u) }), onControl: (m) => control.handle(m) });
transport.open();
const ref = { datasourceId: 'positions', params: { clientId: 'ssrm-app', rate: 50000, batchSize: 1000 } };
try {
  await control.request({ type: 'hello', appId: 'diag2', protocolVersion: 1 });
  await control.request({ type: 'subscribe', ref });
  let prev = null;
  for (let i = 0; i < 12; i++) {
    const agg = await control.request({ type: 'aggregates', ref, specs: [{ column: 'marketValue', fn: 'sum', as: 'mv' }], view: { filter: [] } });
    const mv = Math.round(agg.payload.mv);
    const changed = prev === null ? '(first)' : (mv !== prev ? 'CHANGED  Δ=' + (mv - prev).toLocaleString() : '—— no change ——');
    console.log(`  t${i}s  ΣmarketValue=${mv.toLocaleString()}   ${changed}`);
    prev = mv;
    await new Promise((r) => setTimeout(r, 1000));
  }
} catch (e) { console.log('ERR', e.code || '', e.message); }
finally { transport.close(); setTimeout(() => process.exit(0), 80); }
