import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SocketIoAdapter, decodeEngineIO, decodeSocketIO, encodeEvent, EIO, SIO,
} from '../src/adapters/socketio.mjs';
import { STATE } from '../src/table_actor.mjs';

// ------------------------------------------------- the codec

test('an Engine.IO packet splits into type and payload', () => {
  assert.deepEqual(decodeEngineIO('0{"sid":"abc"}'), { type: '0', payload: '{"sid":"abc"}' });
  assert.deepEqual(decodeEngineIO('2'), { type: '2', payload: '' });
});

test('a Socket.IO EVENT carries name and payload', () => {
  const p = decodeSocketIO('2["rows",[{"id":1}]]');
  assert.equal(p.type, SIO.EVENT);
  assert.deepEqual(p.data, ['rows', [{ id: 1 }]]);
  assert.equal(p.namespace, '/');
});

test('an explicit namespace is parsed off the front', () => {
  // `2/trades,["ev",{}]` — the comma terminates the namespace, and reading it
  // as part of the JSON would fail to parse.
  const p = decodeSocketIO('2/trades,["ev",{"a":1}]');
  assert.equal(p.namespace, '/trades');
  assert.deepEqual(p.data, ['ev', { a: 1 }]);
});

test('a binary-attachment packet is reported, not misparsed', () => {
  const p = decodeSocketIO('51-["ev",{}]');
  assert.equal(p.binary, true);
  assert.equal(p.data, null);
});

test('encodeEvent produces a packet the decoder round-trips', () => {
  const raw = encodeEvent('subscribe', { destination: 'd' });
  assert.equal(raw[0], EIO.MESSAGE);
  assert.deepEqual(decodeSocketIO(raw.slice(1)).data, ['subscribe', { destination: 'd' }]);
});

// ------------------------------------------------- the adapter

function harness(over = {}) {
  const sockets = [];
  const openSocket = (url) => {
    const s = {
      url, sent: [],
      send: (d) => s.sent.push(d),
      close: () => { s.closed = true; s.onclose?.({}); },
      open: () => s.onopen?.(),
      raw: (t) => s.onmessage?.({ data: t }),
      emit: (name, payload, ns) => s.onmessage?.({ data: encodeEvent(name, payload, ns) }),
    };
    sockets.push(s);
    return s;
  };
  const rows = [], states = [];
  const a = new SocketIoAdapter({
    connection: { id: 'c', kind: 'socketio', url: 'ws://host/socket.io/', ...over.connection },
    datasource: {
      id: 'positions',
      snapshot: { mode: 'trigger-reply', triggerDestination: 'snapshot', triggerBody: { client: '{clientId}' },
                  timeoutMs: 5000, endOfSnapshot: { event: 'snapshot-end' } },
      updates: { destination: 'rows', bodyShape: 'record-array' },
      ...over.datasource,
    },
    params: { clientId: 'trd1' },
    openSocket,
    onRows: (r, phase) => rows.push([phase, r.length]),
    onState: (s, d) => states.push([s, d]),
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  const handshake = () => { sockets[0].raw(`${EIO.OPEN}{"sid":"x","pingInterval":25000}`); };
  const connect = () => { sockets[0].raw(`${EIO.MESSAGE}${SIO.CONNECT}`); };
  return { a, sockets, rows, states, handshake, connect };
}

test('the URL carries the Engine.IO query parameters', () => {
  // A bare ws:// URL gets a 400 and looks like a network fault.
  const { a, sockets } = harness();
  a.connect();
  assert.match(sockets[0].url, /EIO=4&transport=websocket/);
});

test('ping is answered with pong', () => {
  // A client that ignores ping is dropped every pingTimeout and reconnects
  // forever, which reads as an unstable network.
  const { a, sockets, handshake } = harness();
  a.connect();
  handshake();
  sockets[0].sent.length = 0;
  sockets[0].raw(EIO.PING);
  assert.deepEqual(sockets[0].sent, [EIO.PONG]);
});

test('the handshake is answered by joining the namespace', () => {
  const { a, sockets, handshake } = harness();
  a.connect();
  handshake();
  assert.equal(sockets[0].sent[0], `${EIO.MESSAGE}${SIO.CONNECT}`);
});

test('it subscribes before triggering the snapshot', () => {
  const { a, sockets, handshake, connect } = harness();
  a.connect();
  handshake();
  sockets[0].sent.length = 0;
  connect();
  const events = sockets[0].sent.map((r) => decodeSocketIO(r.slice(1)).data[0]);
  assert.deepEqual(events, ['subscribe', 'snapshot']);
});

test('trigger params are substituted', () => {
  const { a, sockets, handshake, connect } = harness();
  a.connect();
  handshake();
  sockets[0].sent.length = 0;
  connect();
  const [, body] = decodeSocketIO(sockets[0].sent[1].slice(1)).data;
  assert.equal(body.client, 'trd1');
});

test('only the configured event carries rows', () => {
  // A server emitting several event types would otherwise have its control
  // chatter ingested as data.
  const { a, sockets, rows, handshake, connect } = harness();
  a.connect(); handshake(); connect();
  sockets[0].emit('telemetry', [{ noise: true }]);
  sockets[0].emit('rows', [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(rows, [['snapshot', 2]]);
});

test('the end event takes the datasource live', () => {
  const { a, sockets, states, handshake, connect } = harness();
  a.connect(); handshake(); connect();
  sockets[0].emit('rows', [{ id: 1 }]);
  sockets[0].emit('snapshot-end', {});
  assert.equal(states.at(-1)[0], STATE.LIVE);
});

test('rows after the end event are live, not snapshot', () => {
  const { a, sockets, rows, handshake, connect } = harness();
  a.connect(); handshake(); connect();
  sockets[0].emit('rows', [{ id: 1 }]);
  sockets[0].emit('snapshot-end', {});
  sockets[0].emit('rows', [{ id: 2 }]);
  assert.deepEqual(rows, [['snapshot', 1], ['live', 1]]);
});

test('a socket.io ERROR packet fails the datasource', () => {
  const { a, sockets, states, handshake } = harness();
  a.connect(); handshake();
  sockets[0].raw(`${EIO.MESSAGE}${SIO.ERROR}"not authorised"`);
  assert.equal(states.at(-1)[0], STATE.FAILED);
  assert.match(states.at(-1)[1], /not authorised/);
});

test('a drop is stale then recovering', () => {
  const { a, sockets, states, handshake, connect } = harness();
  a.connect(); handshake(); connect();
  sockets[0].emit('snapshot-end', {});
  sockets[0].close();
  assert.deepEqual(states.map((s) => s[0]).slice(-2), [STATE.STALE, STATE.RECOVERING]);
});
