/**
 * Sidecar conformance (Phase 10): the SAME hub, reached over socket.io, behaves
 * identically to the in-process path.
 *
 * This is the honest core of Phase 10 in JS: the provider's own `ControlClient`
 * and `Transport`, pointed at the real `Hub` through a REAL WebSocket loopback
 * carrying the socket.io framing, complete the same control exchange it does
 * over a MessagePort. If the JS hub is faithful over the socket, the Rust twin's
 * job is a reimplementation of a proven, transport-independent design — and THIS
 * test is the executable spec it must match.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

import { Hub } from '../src/hub.mjs';
import { handleControl, PROTOCOL_VERSION } from '../src/control.mjs';
import { validate } from '../../dshub-spec/src/validate.mjs';
import { attachSidecarSocket } from '../src/sidecarServer.mjs';
import { ControlClient } from '../../dshub-provider/src/control.mjs';
import { Transport } from '../../dshub-provider/src/transport.mjs';
import { socketIoPort } from '../../dshub-provider/src/socketPort.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = join(HERE, '../../dshub-spec');
const controlSchema = JSON.parse(readFileSync(join(SPEC, 'control-protocol.schema.json'), 'utf8'));
const bundle = JSON.parse(readFileSync(join(SPEC, 'examples/positions-stomp.config.json'), 'utf8'));
const artifact = { columns: [{ column: 'positionId', type: 'string' }], keyColumns: ['positionId'], estimatedRows: 100 };

/** Stand up a real Hub behind a real socket.io server on a loopback port. */
async function sidecar() {
  const hub = new Hub({
    bundle: { ...bundle, bundleVersion: 7, checksum: 'sha256:sidecar' },
    openSocket: () => ({ send() {}, close() {}, set onopen(_f) {}, set onmessage(_f) {}, set onclose(_f) {} }),
    createTable: async (name) => ({ name, update: async () => {}, size: () => 100, delete: async () => {} }),
    // A minimal view engine so query RPCs (rowCount) round-trip — the transport
    // is what is under test, not the engine.
    createView: async () => ({ num_rows: async () => 100, to_columns: async () => ({ __key: [] }), delete: async () => {} }),
    artifacts: { positions: artifact, 'positions@v1': artifact },
  });
  hub.sessions = new Set();

  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    // Adapt `ws` (send + on) to the shape attachSidecarSocket expects.
    attachSidecarSocket(ws, { handleControl, hub, schema: controlSchema, validate });
  });
  await new Promise((r) => wss.on('listening', r));
  const url = `ws://127.0.0.1:${wss.address().port}`;
  return { hub, wss, url, close: () => new Promise((r) => wss.close(r)) };
}

/** A ControlClient wired to the sidecar over socketIoPort — the provider stack. */
function connect(url) {
  const openSocket = (u) => new WebSocket(u);
  const control = new ControlClient({ send: (m) => transport.send(m), timeoutMs: 5000 });
  const transport = new Transport({
    connect: () => portShim(socketIoPort(url, { openSocket })),
    onControl: (m) => control.handle(m),
  });
  transport.open();
  return { control, transport };
}

/**
 * `ws` uses `addEventListener`-free callbacks and `.on()`; socketIoPort sets
 * `ws.onopen/onmessage/onclose`. Node's `ws` supports those setters, so the port
 * works directly — this shim only bridges Transport's `.onmessage = fn` contract,
 * which socketIoPort already satisfies.
 */
const portShim = (p) => p;

test('the full control exchange completes over socket.io, same as in-process', async () => {
  const sc = await sidecar();
  const { control, transport } = connect(sc.url);
  try {
    // hello -> configAck, carrying the hub's real bundle version.
    const ack = await control.request({ type: 'hello', appId: 'sidecar-test', protocolVersion: PROTOCOL_VERSION });
    assert.equal(ack.type, 'configAck');
    assert.equal(ack.bundleVersion, 7, 'the sidecar hub answered, over the socket');

    // subscribe -> the hub creates the table and replies subscribed.
    const sub = await control.request({ type: 'subscribe', ref: { datasourceId: 'positions', params: { clientId: 'trd1' } } });
    assert.equal(sub.type, 'subscribed');

    // A query RPC round-trips.
    const rc = await control.request({ type: 'rowCount', ref: { datasourceId: 'positions', params: { clientId: 'trd1' } }, view: { filter: [] } });
    assert.equal(typeof rc.payload, 'number');
  } finally {
    transport.close();
    await sc.close();
  }
});

test('a malformed message is rejected identically over the socket', async () => {
  const sc = await sidecar();
  const { control, transport } = connect(sc.url);
  try {
    await control.request({ type: 'hello', appId: 'x', protocolVersion: PROTOCOL_VERSION });
    await assert.rejects(
      () => control.request({ type: 'subscribe' }),   // missing ref
      (e) => /invalid|malformed|ref/i.test(e.message),
    );
  } finally {
    transport.close();
    await sc.close();
  }
});

test('a protocol-version mismatch is refused over the socket, not silently degraded', async () => {
  const sc = await sidecar();
  const { control, transport } = connect(sc.url);
  try {
    await assert.rejects(
      () => control.request({ type: 'hello', appId: 'x', protocolVersion: 'v0-ancient' }),
      (e) => /protocol/i.test(e.message),
    );
  } finally {
    transport.close();
    await sc.close();
  }
});

test('two clients on one sidecar share the hub — the point of the sidecar', async () => {
  const sc = await sidecar();
  const a = connect(sc.url), b = connect(sc.url);
  try {
    await a.control.request({ type: 'hello', appId: 'a', protocolVersion: PROTOCOL_VERSION });
    await b.control.request({ type: 'hello', appId: 'b', protocolVersion: PROTOCOL_VERSION });
    await a.control.request({ type: 'subscribe', ref: { datasourceId: 'positions', params: { clientId: 'trd1' } } });
    await b.control.request({ type: 'subscribe', ref: { datasourceId: 'positions', params: { clientId: 'trd1' } } });
    // Both subscribed to the same (datasource, params): ONE entry in the hub.
    assert.equal(sc.hub.entries.size, 1, 'one upstream, two subscribers — over socket.io');
  } finally {
    a.transport.close(); b.transport.close();
    await sc.close();
  }
});
