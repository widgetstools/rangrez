import { WebSocket } from 'ws';
import { ControlClient } from '/Users/develop/wfh/rangrez/packages/dshub-provider/src/control.mjs';
import { Transport } from '/Users/develop/wfh/rangrez/packages/dshub-provider/src/transport.mjs';
import { socketIoPort } from '/Users/develop/wfh/rangrez/packages/dshub-provider/src/socketPort.mjs';
import { PROTOCOL_VERSION } from '/Users/develop/wfh/rangrez/packages/dshub-worker/src/control.mjs';

const HUB = 'ws://127.0.0.1:8787';
const control = new ControlClient({ send: (m) => transport.send(m), timeoutMs: 6000 });
const transport = new Transport({ connect: () => socketIoPort(HUB, { openSocket: (u) => new WebSocket(u) }), onControl: (m) => control.handle(m) });
transport.open();
const ref = { datasourceId: 'positions', params: { clientId: 'ssrm-demo' } };

const money = (n) => (n == null ? '—' : (n < 0 ? `(${Math.abs(n).toLocaleString()})` : n.toLocaleString()));
function printTree(rows, label) {
  console.log(`\n  ${label}   (${rows.length} visible rows)`);
  for (const r of rows) {
    if (r.__group) {
      const indent = '  '.repeat(r.__level);
      const twist = r.__expanded ? '▼' : '▶';
      const val = r.__level === 0 ? r.desk : (r.trader ?? r.desk);
      console.log(`    │ ${indent}${twist} ${String(val).padEnd(12 - r.__level * 2)}  n=${String(r.__count).padStart(2)}  Σqty=${String(r.qty).padStart(4)}  Σpnl=${money(r.pnl)}`);
    } else {
      console.log(`    │        • ${r.positionId}  ${r.desk}/${r.trader}  qty=${r.qty}  pnl=${money(r.pnl)}`);
    }
  }
}

try {
  await control.request({ type: 'hello', appId: 'ssrm-demo', protocolVersion: PROTOCOL_VERSION });
  const boot = await control.request({ type: 'bootstrap', datasources: [{
    id: 'positions', schemaRef: 'positions@v1', keyColumns: ['positionId'],
    columns: [{ name: 'positionId', type: 'string' }, { name: 'desk', type: 'string' }, { name: 'trader', type: 'string' }, { name: 'qty', type: 'integer' }, { name: 'pnl', type: 'integer' }],
    connection: { transport: 'websocket', url: 'ws://127.0.0.1:8820' },
    updates: { destination: 'positions.delta', bodyShape: 'record-array' },
  }]});
  console.log('  bootstrap →', JSON.stringify(boot.payload.datasources[0]));
  await control.request({ type: 'subscribe', ref });
  await new Promise((r) => setTimeout(r, 400));

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SSRM demo — 36 positions grouped server-side (Rust hub :8787)');
  console.log('═══════════════════════════════════════════════════════════════');

  const ov = await control.request({ type: 'openView', ref, view: { groupBy: ['desk', 'trader'], aggregates: { qty: 'sum', pnl: 'sum' }, sort: [{ colId: 'desk', sort: 'asc' }] } });
  const viewId = ov.payload.viewId;
  let w = await control.request({ type: 'readWindow', viewId, startRow: 0, endRow: 100 });
  printTree(w.payload.rows, 'STEP 1 — collapsed, grouped by desk → trader');

  const govIdx = w.payload.rows.findIndex((r) => r.__group && r.desk === 'Govies');
  const ex = await control.request({ type: 'expandRow', viewId, index: govIdx });
  console.log(`\n  STEP 2 — expandRow(${govIdx}, "Govies"): rowCount ${w.payload.rowCount} → ${ex.payload.rowCount}`);
  w = await control.request({ type: 'readWindow', viewId, startRow: 0, endRow: 100 });
  printTree(w.payload.rows, 'Govies expanded');

  const trIdx = w.payload.rows.findIndex((r) => r.__group && r.__level === 1);
  const ex2 = await control.request({ type: 'expandRow', viewId, index: trIdx });
  console.log(`\n  STEP 3 — expandRow(${trIdx}, a trader): rowCount → ${ex2.payload.rowCount}`);
  w = await control.request({ type: 'readWindow', viewId, startRow: 0, endRow: 100 });
  printTree(w.payload.rows, 'trader expanded — leaves appear');

  const flat = await control.request({ type: 'openView', ref, view: { sort: [{ colId: 'qty', sort: 'desc' }] } });
  const blk = await control.request({ type: 'readWindow', viewId: flat.payload.viewId, startRow: 0, endRow: 5 });
  console.log(`\n  STEP 4 — flat, qty desc, block [0,5) of ${blk.payload.rowCount}:`);
  for (const r of blk.payload.rows) console.log(`    │   ${r.positionId}  ${r.desk}/${r.trader}  qty=${r.qty}`);

  console.log('\n  ✓ served server-side by the Rust hub. Sidecar left running on :8787.');
} catch (e) { console.log('  ERROR', e.code || '', e.message); }
finally { transport.close(); setTimeout(() => process.exit(0), 80); }
