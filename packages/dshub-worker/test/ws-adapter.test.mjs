import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsAdapter, isEndOfSnapshot } from '../src/adapters/ws.mjs';
import { STATE } from '../src/table_actor.mjs';

function harness(over = {}) {
  const sockets = [];
  const openSocket = (url) => {
    const s = {
      url, sent: [],
      send: (d) => s.sent.push(typeof d === 'string' ? JSON.parse(d) : d),
      close: () => { s.closed = true; s.onclose?.({}); },
      open: () => s.onopen?.(),
      deliver: (o) => s.onmessage?.({ data: typeof o === 'string' ? o : JSON.stringify(o) }),
    };
    sockets.push(s);
    return s;
  };
  const rows = [], states = [];
  const a = new WsAdapter({
    connection: { id: 'c', kind: 'ws', url: 'ws://host/feed', ...over.connection },
    datasource: {
      id: 'positions',
      snapshot: { mode: 'trigger-reply', triggerBody: { req: 'snap' }, timeoutMs: 5000,
                  endOfSnapshot: { kind: 'sentinel-body', path: 'type', value: 'end' } },
      updates: { destination: 'positions.{clientId}', bodyShape: 'record-array' },
      ...over.datasource,
    },
    params: { clientId: 'trd1' },
    openSocket,
    onRows: (r, phase) => rows.push([phase, r.length]),
    onState: (s, d) => states.push([s, d]),
    setTimer: over.setTimer ?? ((fn) => { const t = { fn }; (harness.timers ??= []).push(t); return t; }),
    clearTimer: () => {},
  });
  return { a, sockets, rows, states };
}

// ------------------------------------------------- ordering

test('it subscribes BEFORE triggering the snapshot', () => {
  // Subscribing after the trigger loses whatever changed in between
  // (architecture §5.5) — the same rule as every other transport.
  const { a, sockets } = harness();
  a.connect();
  sockets[0].open();
  assert.equal(sockets[0].sent[0].type, 'subscribe');
  assert.equal(sockets[0].sent[1].req, 'snap', 'trigger comes second');
});

test('destination params are substituted', () => {
  const { a, sockets } = harness();
  a.connect();
  sockets[0].open();
  assert.equal(sockets[0].sent[0].destination, 'positions.trd1');
});

// ------------------------------------------------- snapshot lifecycle

test('rows before the sentinel are snapshot rows, after it are live', () => {
  const { a, sockets, rows } = harness();
  a.connect();
  sockets[0].open();
  sockets[0].deliver([{ id: 1 }, { id: 2 }]);
  sockets[0].deliver({ type: 'end' });
  sockets[0].deliver([{ id: 3 }]);
  assert.deepEqual(rows, [['snapshot', 2], ['live', 1]]);
});

test('the sentinel takes the datasource live', () => {
  const { a, sockets, states } = harness();
  a.connect();
  sockets[0].open();
  sockets[0].deliver([{ id: 1 }]);
  sockets[0].deliver({ type: 'end' });
  assert.equal(states.at(-1)[0], STATE.LIVE);
});

test('a declared count that does not match FAILS rather than going live', () => {
  // Going live on a silently truncated book is the worst outcome in this
  // system, because everything downstream looks healthy.
  const { a, sockets, states } = harness({
    datasource: {
      snapshot: { mode: 'trigger-reply', timeoutMs: 5000, expectedCountHeader: 'total',
                  endOfSnapshot: { kind: 'sentinel-body', path: 'type', value: 'end' } },
      updates: { destination: 'd', bodyShape: 'record-array' },
    },
  });
  a.connect();
  sockets[0].open();
  sockets[0].deliver([{ id: 1 }]);
  sockets[0].deliver({ type: 'end', total: 99 });
  assert.equal(states.at(-1)[0], STATE.FAILED);
  assert.match(states.at(-1)[1], /expected 99 rows, received 1/);
});

test('non-JSON chatter is ignored, not ingested', () => {
  const { a, sockets, rows } = harness();
  a.connect();
  sockets[0].open();
  sockets[0].deliver('ping');
  assert.deepEqual(rows, []);
});

// ------------------------------------------------- stream-end

test('with stream-end, the socket closing IS the sentinel', () => {
  const { a, sockets, states } = harness({
    datasource: {
      snapshot: { mode: 'trigger-reply', timeoutMs: 5000, endOfSnapshot: { kind: 'stream-end' } },
      updates: { destination: 'd', bodyShape: 'record-array' },
    },
  });
  a.connect();
  sockets[0].open();
  sockets[0].deliver([{ id: 1 }]);
  sockets[0].close();
  assert.equal(states.at(-1)[0], STATE.LIVE);
});

test('a mid-session drop is NOT read as a completed snapshot', () => {
  // Only while snapshotting. Otherwise a network blip would take a partial book
  // live.
  const { a, sockets, states } = harness({
    datasource: {
      snapshot: { mode: 'trigger-reply', timeoutMs: 5000, endOfSnapshot: { kind: 'stream-end' } },
      updates: { destination: 'd', bodyShape: 'record-array' },
    },
  });
  a.connect();
  sockets[0].open();
  sockets[0].close();                       // snapshot ends -> live
  assert.equal(states.at(-1)[0], STATE.LIVE);
  sockets[1] ??= sockets[0];
  a.state = STATE.LIVE;
  a.onSocketClose();                        // a later drop
  assert.deepEqual(
    states.map((s) => s[0]).slice(-2), [STATE.STALE, STATE.RECOVERING],
    'stale then recovering, not a second completed snapshot',
  );
});

// ------------------------------------------------- endOfSnapshot vocabulary

test('sentinel-header is refused: a raw socket has no headers', () => {
  // Silently never matching would look like a hung snapshot.
  assert.throws(
    () => isEndOfSnapshot({}, { kind: 'sentinel-header', name: 'x' }, 0),
    /has none/,
  );
});

test('count-reached ends the snapshot at the expected row count', () => {
  assert.equal(isEndOfSnapshot({}, { kind: 'count-reached', expected: 5 }, 5), true);
  assert.equal(isEndOfSnapshot({}, { kind: 'count-reached', expected: 5 }, 4), false);
});

test('an unknown endOfSnapshot kind is refused loudly', () => {
  assert.throws(() => isEndOfSnapshot({}, { kind: 'vibes' }, 0), /unknown endOfSnapshot/);
});

// ------------------------------------------------- recovery

test('a drop is STALE and schedules a reconnect, not FAILED', () => {
  // The cache is still valid; the blotter should grey out rather than empty.
  const { a, sockets, states } = harness();
  a.connect();
  sockets[0].open();
  sockets[0].deliver({ type: 'end' });
  sockets[0].close();
  assert.deepEqual(states.map((s) => s[0]).slice(-2), [STATE.STALE, STATE.RECOVERING]);
});

test('bodyShape record delivers ONE row even for an array payload', () => {
  // A datasource whose records are themselves arrays would otherwise explode
  // into garbage rows.
  const { a, sockets, rows } = harness({
    datasource: {
      snapshot: { mode: 'trigger-reply', timeoutMs: 5000, endOfSnapshot: { kind: 'sentinel-body', path: 'type', value: 'end' } },
      updates: { destination: 'd', bodyShape: 'record' },
    },
  });
  a.connect();
  sockets[0].open();
  sockets[0].deliver([1, 2, 3]);
  assert.deepEqual(rows, [['snapshot', 1]]);
});
