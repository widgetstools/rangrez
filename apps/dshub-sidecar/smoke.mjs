/**
 * Sidecar smoke: the hub, the REAL Perspective Node engine, and a REAL browser
 * client stack — end to end, out of the browser.
 *
 * The conformance test (packages/dshub-worker/test/sidecar.conformance.test.mjs)
 * proves the TRANSPORT with a stub engine. This proves the ENGINE: it boots the
 * actual sidecar with Perspective 5.3.0 in Node, connects the provider's own
 * ControlClient over socketIoPort, subscribes, writes rows into the real table,
 * and reads the count back — all over socket.io. If this prints OK, the
 * DataSource Hub is genuinely running outside the browser.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { serve } from './server.mjs';
import { ControlClient } from '../../packages/dshub-provider/src/control.mjs';
import { Transport } from '../../packages/dshub-provider/src/transport.mjs';
import { socketIoPort } from '../../packages/dshub-provider/src/socketPort.mjs';
import { PROTOCOL_VERSION } from '../../packages/dshub-worker/src/control.mjs';

const ref = { datasourceId: 'positions', params: { clientId: 'smoke' } };

function connect(url) {
  const control = new ControlClient({ send: (m) => transport.send(m), timeoutMs: 8000 });
  const transport = new Transport({
    connect: () => socketIoPort(url, { openSocket: (u) => new WebSocket(u) }),
    onControl: (m) => control.handle(m),
  });
  transport.open();
  return { control, transport };
}

const sc = await serve({ port: 0 });
const url = `ws://127.0.0.1:${sc.port}`;
const { control, transport } = connect(url);

try {
  // 1. Control handshake, over socket.io, answered by the out-of-browser hub.
  const ack = await control.request({ type: 'hello', appId: 'smoke', protocolVersion: PROTOCOL_VERSION });
  assert.equal(ack.type, 'configAck');
  console.log(`  hello → configAck  (bundleVersion ${ack.bundleVersion})`);

  // 2. Subscribe — this creates the REAL Perspective table in Node.
  const sub = await control.request({ type: 'subscribe', ref });
  assert.equal(sub.type, 'subscribed');
  console.log('  subscribe → subscribed  (real Perspective table created)');

  // 3. Feed rows straight into that table — standing in for the upstream adapter,
  //    which would need a live STOMP/WS feed. The engine is what we are proving.
  const entry = [...sc.hub.entries.entries()].find(([k]) => k.startsWith('positions#'))?.[1];
  assert.ok(entry, 'the hub created a Perspective-backed entry for positions');
  await entry.table.update({
    __key:      ['P1', 'P2', 'P3'],
    positionId: ['P1', 'P2', 'P3'],
  });
  console.log(`  wrote 3 rows into the engine  (table.size = ${await entry.table.size()})`);

  // 4. Read the count back OVER THE SOCKET — the full path a blotter uses.
  const rc = await control.request({ type: 'rowCount', ref, view: { filter: [] } });
  assert.equal(rc.payload, 3, 'rowCount over socket.io reflects the engine');
  console.log(`  rowCount over socket.io → ${rc.payload}`);

  // 5. A filter runs in the real engine, over the socket.
  const one = await control.request({
    type: 'rowCount', ref,
    view: { filter: [{ column: 'positionId', op: 'equals', value: 'P2' }] },
  });
  assert.equal(one.payload, 1, 'the engine filtered, out of the browser');
  console.log(`  filtered rowCount (positionId==P2) → ${one.payload}`);

  console.log('\nOK — the DataSource Hub ran outside the browser, real engine, over socket.io.');
} finally {
  transport.close();
  await sc.close();
  // Perspective's Node engine keeps the loop alive; this smoke has proven its point.
  setTimeout(() => process.exit(0), 50);
}
