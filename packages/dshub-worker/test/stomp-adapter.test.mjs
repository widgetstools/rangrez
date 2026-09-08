import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StompAdapter, substitute, isEndOfSnapshot, declaredCount } from '../src/adapters/stomp.mjs';
import { encodeFrame } from '../src/adapters/stomp-codec.mjs';

const NUL = String.fromCharCode(0); // STOMP frame terminator

/** Fake socket: records what was sent, lets the test push frames back. */
function fakeSocket() {
  const sent = [];
  const s = {
    sent,
    readyState: 1,
    send: (data) => sent.push(data),
    close: () => s.onclose?.({}),
    // helpers
    open: () => s.onopen?.(),
    deliver: (frame) => s.onmessage?.({ data: typeof frame === 'string' ? frame : encodeFrame(frame) }),
    commandsSent: () => sent.map((f) => f.split('\n')[0]),
  };
  return s;
}

/** The real view-server config, as captured. */
const connection = {
  id: 'stomp-view-server', kind: 'stomp', url: 'ws://localhost:8081',
  heartbeat: { outMs: 0, inMs: 0 },
  reconnect: { initialMs: 100, maxMs: 2000, factor: 2, maxAttempts: null },
};
const datasource = {
  id: 'positions',
  snapshot: {
    mode: 'trigger-reply',
    triggerDestination: '/snapshot/positions/{clientId}/{rate}/{batchSize}',
    replyDestination: '/snapshot/positions/{clientId}',
    endOfSnapshot: { kind: 'sentinel-header', header: 'message-type', value: 'snapshot-complete' },
    timeoutMs: 5000,
  },
  updates: { destination: '/snapshot/positions/{clientId}', bodyShape: 'record-array' },
  keyColumns: ['positionId'],
};
const params = { clientId: 'trd1', rate: 2000, batchSize: 10 };

function harness(over = {}) {
  const ws = fakeSocket();
  const rows = [];
  const states = [];
  const timers = [];
  const a = new StompAdapter({
    connection, datasource, params,
    openSocket: () => ws,
    onRows: (r, phase) => rows.push([phase, r.length]),
    onState: (s, d) => states.push(d ? `${s}:${d}` : s),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    ...over,
  });
  return { a, ws, rows, states, timers };
}

const connected = (ws) => ws.deliver({ command: 'CONNECTED', headers: { version: '1.2', 'heart-beat': '0,0' } });
const snapFrame = (n) => ({
  command: 'MESSAGE',
  headers: { 'message-type': 'snapshot', 'content-type': 'application/json' },
  body: JSON.stringify(Array.from({ length: n }, (_, i) => ({ positionId: `P${i}` }))),
});

// ------------------------------------------------- templates

test('destination templates substitute params', () => {
  assert.equal(
    substitute('/snapshot/positions/{clientId}/{rate}/{batchSize}', params),
    '/snapshot/positions/trd1/2000/10'
  );
});

test('a missing param fails loudly instead of sending a literal brace', () => {
  // Sending "/snapshot/positions/{clientId}" would subscribe to a topic that
  // silently never produces anything.
  assert.throws(() => substitute('/x/{clientId}', {}), /missing param "clientId"/);
});

// ------------------------------------------------- the ordering that matters

test('SUBSCRIBE is sent BEFORE the snapshot trigger', () => {
  // Triggering first leaves a window where rows are produced and nobody is
  // listening; those rows never reappear (architecture §5.5).
  const { a, ws } = harness();
  a.connect(); ws.open(); connected(ws);
  const cmds = ws.commandsSent();
  assert.deepEqual(cmds, ['CONNECT', 'SUBSCRIBE', 'SEND']);
  assert.ok(cmds.indexOf('SUBSCRIBE') < cmds.indexOf('SEND'), 'SUBSCRIBE must precede SEND');
});

test('the trigger goes to the substituted destination', () => {
  const { a, ws } = harness();
  a.connect(); ws.open(); connected(ws);
  const send = ws.sent.find((f) => f.startsWith('SEND'));
  assert.ok(send.includes('/snapshot/positions/trd1/2000/10'), send.split('\n')[1]);
});

// ------------------------------------------------- snapshot atomicity

test('a matching row count goes live', () => {
  const { a, ws, rows, states } = harness();
  a.connect(); ws.open(); connected(ws);
  ws.deliver(snapFrame(10));
  ws.deliver(snapFrame(10));
  ws.deliver({
    command: 'MESSAGE', headers: { 'message-type': 'snapshot-complete' },
    body: "Success: All 20 positions records delivered to client 'trd1'.",
  });
  assert.deepEqual(rows, [['snapshot', 10], ['snapshot', 10]]);
  assert.ok(states.some((s) => s.startsWith('live')), states.join(' -> '));
});

test('a truncated snapshot FAILS rather than going live', () => {
  // The worst outcome in this system is a trader acting on a partial book.
  const { a, ws, states } = harness();
  a.connect(); ws.open(); connected(ws);
  ws.deliver(snapFrame(10));
  ws.deliver({
    command: 'MESSAGE', headers: { 'message-type': 'snapshot-complete' },
    body: "Success: All 20 positions records delivered to client 'trd1'.",
  });
  assert.ok(!states.some((s) => s.startsWith('live')), 'must not go live');
  assert.ok(states.some((s) => s.includes('expected 20 rows, received 10')), states.join(' -> '));
});

test('a sentinel that never arrives fails on the timeout, not silently', () => {
  const { a, ws, states, timers } = harness();
  a.connect(); ws.open(); connected(ws);
  ws.deliver(snapFrame(10));
  const t = timers.find((x) => x.ms === 5000);
  assert.ok(t, 'a snapshot timeout must be armed');
  t.fn();
  assert.ok(states.some((s) => s.includes('sentinel not seen')), states.join(' -> '));
});

test('rows after the sentinel are live, not snapshot', () => {
  const { a, ws, rows } = harness();
  a.connect(); ws.open(); connected(ws);
  ws.deliver(snapFrame(20));
  ws.deliver({ command: 'MESSAGE', headers: { 'message-type': 'snapshot-complete' }, body: 'Success: All 20 positions records delivered.' });
  ws.deliver({ command: 'MESSAGE', headers: { 'message-type': 'live-update' }, body: JSON.stringify([{ positionId: 'P1' }]) });
  assert.deepEqual(rows.at(-1), ['live', 1]);
});

// ------------------------------------------------- end-of-snapshot kinds

test('every endOfSnapshot kind is honoured', () => {
  const f = { headers: { 'message-type': 'snapshot-complete' }, body: 'Success: All 20 done' };
  assert.ok(isEndOfSnapshot(f, { kind: 'sentinel-header', header: 'message-type', value: 'snapshot-complete' }));
  assert.ok(isEndOfSnapshot(f, { kind: 'sentinel-substring', value: 'success' }), 'case-insensitive by default');
  assert.ok(!isEndOfSnapshot(f, { kind: 'sentinel-substring', value: 'success', caseSensitive: true }));
  assert.ok(isEndOfSnapshot({ headers: {}, body: '' }, { kind: 'count-reached', expected: 5 }, 5));
  assert.ok(!isEndOfSnapshot({ headers: {}, body: '' }, { kind: 'count-reached', expected: 5 }, 4));
});

test('an unknown endOfSnapshot kind throws rather than never terminating', () => {
  assert.throws(() => isEndOfSnapshot({ headers: {}, body: '' }, { kind: 'wishful' }), /unknown endOfSnapshot/);
});

test('the declared count is read from a header or from the completion prose', () => {
  assert.equal(declaredCount({ headers: { 'total-rows': '20000' }, body: '' }, { expectedCountHeader: 'total-rows' }), 20000);
  assert.equal(declaredCount({ headers: {}, body: "Success: All 20000 positions records delivered to client 'trd1'." }, {}), 20000);
  assert.equal(declaredCount({ headers: {}, body: 'Success: All 1,234 records' }, {}), 1234);
  assert.equal(declaredCount({ headers: {}, body: 'no count here' }, {}), undefined);
});

// ------------------------------------------------- reconnect and failover

test('a dropped connection goes STALE, not FAILED — the cache is still good', () => {
  const { a, ws, states } = harness();
  a.connect(); ws.open(); connected(ws);
  ws.deliver(snapFrame(20));
  ws.deliver({ command: 'MESSAGE', headers: { 'message-type': 'snapshot-complete' }, body: 'Success: All 20 records' });
  ws.close();
  assert.ok(states.some((s) => s.startsWith('stale')), states.join(' -> '));
  assert.ok(!states.some((s) => s.startsWith('failed')), 'a drop is not a failure');
});

test('reconnect backs off exponentially, capped', () => {
  const { a, ws, timers } = harness();
  a.connect(); ws.open(); connected(ws);
  const delays = [];
  for (let i = 0; i < 8; i++) {
    ws.close();
    delays.push(timers.at(-1).ms);
    a.connect();
  }
  assert.equal(delays[0], 100);
  assert.equal(delays[1], 200);
  assert.equal(delays[2], 400);
  assert.ok(delays.every((d) => d <= 2000), `capped at maxMs: ${delays.join(',')}`);
});

test('failover moves to the next endpoint after maxAttempts, as a recovery', () => {
  const { a, ws, states } = harness({
    connection: {
      ...connection,
      failover: ['ws://backup:8081'],
      reconnect: { initialMs: 10, maxMs: 100, factor: 2, maxAttempts: 2 },
    },
  });
  a.connect(); ws.open(); connected(ws);
  for (let i = 0; i < 4; i++) { ws.close(); a.connect(); }
  assert.ok(states.some((s) => s.includes('backup')), `never failed over: ${states.join(' -> ')}`);
  assert.ok(!states.some((s) => s.startsWith('failed')), 'failover is a recovery, not a failure');
});

test('an explicit close does not trigger a reconnect', () => {
  const { a, ws, states } = harness();
  a.connect(); ws.open(); connected(ws);
  a.close();
  ws.close();
  assert.ok(!states.some((s) => s.startsWith('recovering')), states.join(' -> '));
});

// ------------------------------------------------- broker errors

test('an ERROR frame fails the subscription with the broker message', () => {
  const { a, ws, states } = harness();
  a.connect(); ws.open(); connected(ws);
  ws.deliver({ command: 'ERROR', headers: { message: 'no such destination' }, body: '' });
  assert.ok(states.some((s) => s.includes('no such destination')), states.join(' -> '));
});

test('a malformed frame fails rather than silently dropping rows', () => {
  const { a, ws, states } = harness();
  a.connect(); ws.open(); connected(ws);
  ws.deliver('MESSAGE\nbad-escape:a\\q\n\nx' + NUL);
  assert.ok(states.some((s) => s.includes('frame error')), states.join(' -> '));
});
