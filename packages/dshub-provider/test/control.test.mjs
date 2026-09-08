import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlClient, ControlError } from '../src/control.mjs';
import { Transport, isBinary } from '../src/transport.mjs';

/** Client with controllable timers, recording what it sent. */
function client(over = {}) {
  const sent = [];
  const timers = [];
  const c = new ControlClient({
    send: (m) => { sent.push(m); return true; },
    timeoutMs: 1000,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (t) => { const i = timers.findIndex((x, idx) => idx + 1 === t); if (i >= 0) timers[i].cleared = true; },
    ...over,
  });
  return { c, sent, timers };
}

// ------------------------------------------------- correlation

test('a request correlates to its reply by id', async () => {
  const { c, sent } = client();
  const p = c.subscribe({ datasourceId: 'positions' });
  assert.equal(sent[0].type, 'subscribe');
  assert.ok(sent[0].id, 'an id is assigned');

  c.handle({ id: sent[0].id, type: 'subscribed', tableName: 't', mode: 'csrm' });
  const out = await p;
  assert.equal(out.tableName, 't');
});

test('concurrent requests resolve independently and in any order', async () => {
  const { c, sent } = client();
  const a = c.rowCount({ datasourceId: 'x' });
  const b = c.getStats();

  // Reply out of order — correlation must not depend on arrival sequence.
  c.handle({ id: sent[1].id, type: 'result', payload: { tables: 3 } });
  c.handle({ id: sent[0].id, type: 'result', payload: 42 });

  assert.equal((await b).payload.tables, 3);
  assert.equal((await a).payload, 42);
});

test('ids are unique across requests', () => {
  const { c, sent } = client();
  c.getStats(); c.getStats(); c.getStats();
  assert.equal(new Set(sent.map((m) => m.id)).size, 3);
});

// ------------------------------------------------- errors

test('an error reply rejects with a TYPED error, not a string', async () => {
  const { c, sent } = client();
  const p = c.subscribe({ datasourceId: 'nope' });
  c.handle({ id: sent[0].id, type: 'error', code: 'unknown-datasource', message: 'no such datasource' });

  await assert.rejects(p, (e) => {
    assert.ok(e instanceof ControlError);
    assert.equal(e.code, 'unknown-datasource');
    return true;
  });
});

test('retryable is carried through so the UI can decide', async () => {
  const { c, sent } = client();
  const p = c.getStats();
  c.handle({ id: sent[0].id, type: 'error', code: 'upstream-unavailable', message: 'down', retryable: true });
  await assert.rejects(p, (e) => e.retryable === true);
});

// ------------------------------------------------- timeouts

test('a request that never replies rejects on the timeout', async () => {
  const { c, timers } = client();
  const p = c.getStats();
  timers[0].fn();
  await assert.rejects(p, (e) => e.code === 'timeout' && e.retryable);
  assert.equal(c.stats.timedOut, 1);
});

test('a reply arriving AFTER the timeout does not resolve, and does not leak', async () => {
  // The entry must be dropped before rejecting, or a late reply resolves an
  // already-rejected promise and the pending map grows without bound.
  const { c, sent, timers } = client();
  const p = c.getStats();
  timers[0].fn();
  await assert.rejects(p);

  c.handle({ id: sent[0].id, type: 'result', payload: 1 });
  assert.equal(c.pending.size, 0, 'nothing left pending');
  assert.equal(c.stats.late, 1, 'the late reply is counted, not silently dropped');
});

test('a resolved request clears its timer', async () => {
  const { c, sent, timers } = client();
  const p = c.getStats();
  c.handle({ id: sent[0].id, type: 'result', payload: 1 });
  await p;
  assert.ok(timers[0].cleared, 'a live timer after resolution would fire later');
  assert.equal(c.pending.size, 0);
});

test('a per-request timeout overrides the default', () => {
  const { c, timers } = client();
  c.request({ type: 'export' }, { timeoutMs: 120_000 });
  assert.equal(timers[0].ms, 120_000);
});

// ------------------------------------------------- events

test('events dispatch to listeners and never correlate', () => {
  const { c } = client();
  const seen = [];
  c.on('state', (m) => seen.push(m.state));
  c.handle({ id: 'evt-1', type: 'state', state: 'stale' });
  c.handle({ id: 'evt-2', type: 'state', state: 'live' });
  assert.deepEqual(seen, ['stale', 'live']);
  assert.equal(c.stats.late, 0, 'an event is not an unmatched reply');
});

test('a wildcard listener sees everything', () => {
  const { c } = client();
  const seen = [];
  c.on('*', (m) => seen.push(m.type));
  c.handle({ id: 'e', type: 'state', state: 'live' });
  c.handle({ id: 'e', type: 'alert', ruleId: 'r1', row: {} });
  assert.deepEqual(seen, ['state', 'alert']);
});

test('unsubscribing a listener stops delivery', () => {
  const { c } = client();
  let n = 0;
  const off = c.on('state', () => n++);
  c.handle({ id: 'e', type: 'state', state: 'live' });
  off();
  c.handle({ id: 'e', type: 'state', state: 'stale' });
  assert.equal(n, 1);
});

// ------------------------------------------------- disconnect

test('disconnect fails everything in flight rather than hanging', async () => {
  // A pending request whose transport is gone will never resolve. A typed
  // error the caller can retry beats a spinner with no explanation.
  const { c } = client();
  const a = c.getStats();
  const b = c.rowCount({ datasourceId: 'x' });
  c.failAll();

  for (const p of [a, b]) {
    await assert.rejects(p, (e) => e.code === 'transport-unavailable' && e.retryable);
  }
  assert.equal(c.pending.size, 0);
});

// ------------------------------------------------- transport

test('binary is routed to the Perspective handler, never parsed as control', () => {
  const control = [], binary = [];
  const port = { postMessage() {}, start() {} };
  const t = new Transport({ connect: () => port, onControl: (m) => control.push(m), onBinary: (b) => binary.push(b) });
  t.open();

  port.onmessage({ data: { type: 'state' } });
  port.onmessage({ data: new ArrayBuffer(8) });
  port.onmessage({ data: new Uint8Array([1, 2]) });

  assert.equal(control.length, 1);
  assert.equal(binary.length, 2, 'typed arrays are binary too');
});

test('messages sent while disconnected are queued and replayed on reconnect', () => {
  // A subscribe lost across a reconnect leaves a blotter permanently blank.
  const posts = [];
  const port = { postMessage: (m) => posts.push(m), start() {} };
  const timers = [];
  const t = new Transport({
    connect: () => port, onControl: () => {},
    setTimer: (fn) => { timers.push(fn); return timers.length; },
  });
  t.open();
  t.handleClose();

  assert.equal(t.send({ type: 'subscribe' }), false, 'not sent while down');
  assert.equal(posts.length, 0);

  timers[0]();                       // reconnect fires
  assert.equal(posts.length, 1, 'queued message replayed');
  assert.equal(posts[0].type, 'subscribe');
});

test('reconnect backs off and reports state transitions', () => {
  const states = [];
  const timers = [];
  const t = new Transport({
    connect: () => ({ postMessage() {}, start() {} }),
    onControl: () => {}, onState: (s, d) => states.push(d ? `${s}:${d}` : s),
    reconnect: { initialMs: 100, maxMs: 800, factor: 2, maxAttempts: null },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  });
  t.open();
  for (let i = 0; i < 5; i++) { t.handleClose(); t.open(); }

  assert.ok(states.includes('connected'));
  assert.ok(states.includes('disconnected'));
  assert.ok(states.some((s) => s.startsWith('reconnecting')));
  assert.ok(timers.every((x) => x.ms <= 800), 'backoff is capped');
});

test('an explicit close does not reconnect', () => {
  const timers = [];
  const t = new Transport({
    connect: () => ({ postMessage() {}, start() {}, close() {} }),
    onControl: () => {}, setTimer: (fn) => { timers.push(fn); return timers.length; },
  });
  t.open();
  t.close();
  t.handleClose();
  assert.equal(timers.length, 0);
});

test('isBinary distinguishes the channels', () => {
  assert.ok(isBinary(new ArrayBuffer(1)));
  assert.ok(isBinary(new Float64Array(1)));
  assert.ok(!isBinary({}));
  assert.ok(!isBinary('x'));
});

// ------------------------------------------------- browser timer semantics

/**
 * Reproduces the browser rule that Node does not enforce: `setTimeout` must be
 * invoked with `this` as the global. Stored on an instance and called as
 * `this.setTimer(...)`, a bare browser timer throws `Illegal invocation` —
 * silently disabling every timeout, and only in a browser.
 */
const strictTimer = (fn, ms) => {
  // eslint-disable-next-line no-invalid-this
  if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
  return setTimeout(fn, ms);
};

test('the default timer survives being called as a method', () => {
  // Constructed with NO timer override, exactly as the blotter does.
  const c = new ControlClient({ send: () => true, timeoutMs: 50 });
  assert.doesNotThrow(() => { const p = c.request({ type: 'stats' }); p.catch(() => {}); });
  c.failAll();
});

test('Transport default timer survives being called as a method', () => {
  const t = new Transport({ connect: () => ({ postMessage() {}, start() {} }), onControl: () => {} });
  t.open();
  assert.doesNotThrow(() => t.handleClose());
  t.close();
});

test('a this-sensitive timer is accepted, proving no unbound call happens', () => {
  const c = new ControlClient({ send: () => true, timeoutMs: 50, setTimer: strictTimer });
  const p = c.request({ type: 'stats' });
  p.catch(() => {});
  assert.equal(c.pending.size, 1);
  c.failAll();
});

// ------------------------------------------------- streaming

test('partial results stream and do NOT resolve the request', async () => {
  // export/scan emit many batches before the final reply. Resolving on the
  // first hands the caller one batch and discards the rest as late replies —
  // a scan of 20,000 rows silently delivering 2,000.
  const { c, sent } = client();
  const batches = [];
  const p = c.request({ type: 'scan' }, { onPartial: (payload) => batches.push(payload) });
  const id = sent[0].id;

  c.handle({ id, type: 'result', partial: true, payload: { start: 0 } });
  c.handle({ id, type: 'result', partial: true, payload: { start: 2000 } });
  assert.equal(batches.length, 2);
  assert.equal(c.pending.size, 1, 'still awaiting the final reply');
  assert.equal(c.stats.late, 0, 'partials are not late replies');

  c.handle({ id, type: 'result', payload: { rows: 4000 } });
  assert.equal((await p).payload.rows, 4000);
  assert.equal(c.pending.size, 0);
});

test('a partial for an unknown id is still counted as late', async () => {
  const { c } = client();
  c.handle({ id: 'gone', type: 'result', partial: true, payload: {} });
  assert.equal(c.stats.late, 1);
});

test('a stream that errors midway rejects rather than half-resolving', async () => {
  const { c, sent } = client();
  const batches = [];
  const p = c.request({ type: 'scan' }, { onPartial: (x) => batches.push(x) });
  c.handle({ id: sent[0].id, type: 'result', partial: true, payload: { start: 0 } });
  c.handle({ id: sent[0].id, type: 'error', code: 'internal', message: 'view died' });
  await assert.rejects(p, (e) => e.code === 'internal');
  assert.equal(batches.length, 1);
});

// ------------------------------------------------- unsolicited announcements

test('an unsolicited error is delivered, not counted as late and discarded', async () => {
  // The hub sends `backpressure-disconnect` so a dropped tab learns WHY. It
  // correlates to no request, so it was landing in the late/unmatched bucket —
  // the explanation was sent and never delivered, which is the same outcome as
  // not sending it, and the tab sits on stale prices believing them current.
  const c = new ControlClient({ send: () => {} });
  const seen = [];
  c.on('error', (m) => seen.push(m));

  c.handle({ id: 'nobody-asked', type: 'error', code: 'backpressure-disconnect', message: 'dropped' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, 'backpressure-disconnect');
  assert.equal(c.stats.late, 0, 'not counted as a late reply');
});

test('an error that DOES correlate still rejects its request', async () => {
  // Broadcasting it instead would leave the caller hanging until timeout.
  const sent = [];
  const c = new ControlClient({ send: (m) => sent.push(m) });
  const p = c.request({ type: 'rowCount', ref: {} });
  const broadcast = [];
  c.on('error', (m) => broadcast.push(m));

  c.handle({ id: sent[0].id, type: 'error', code: 'invalid-params', message: 'no such column' });
  await assert.rejects(p, /no such column/);
  assert.equal(broadcast.length, 0, 'a correlated error belongs to its caller');
});

test('a refresh is an event a client can act on', async () => {
  const c = new ControlClient({ send: () => {} });
  const seen = [];
  c.on('refresh', (m) => seen.push(m));
  c.handle({ id: 'r-1', type: 'refresh', ref: { datasourceId: 'positions' }, reason: 'backpressure' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reason, 'backpressure');
});

// ------------------------------------------------- command reply correlation

test('a commandResult resolves its command request, not broadcast as an event', async () => {
  // commandResult was in the EVENTS set, so the reply to a command was emitted
  // as an unsolicited event and the request promise hung forever.
  const sent = [];
  const c = new ControlClient({ send: (m) => sent.push(m) });
  const p = c.command({ datasourceId: 'p' }, 'edit', 'w1', { key: 'k', field: 'f', value: 1 });
  const broadcast = [];
  c.on('commandResult', (m) => broadcast.push(m));

  c.handle({ id: sent[0].id, type: 'commandResult', idempotencyKey: 'w1', outcome: 'applied' });
  const r = await p;
  assert.equal(r.outcome, 'applied', 'the request resolved with the result');
  assert.equal(broadcast.length, 0, 'and it was not also broadcast');
});
