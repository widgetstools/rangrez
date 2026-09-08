import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubscriberFlow, rungForLag, mergeDeltas } from '../src/flow.mjs';
import { RUNG } from '../src/stats.mjs';

const delta = (keys, px) => ({
  type: 'rowDelta',
  columns: { __key: keys, px: px ?? keys.map(() => 1) },
  rows: keys.length,
});

const flow = (over = {}) => {
  let t = 0;
  const f = new SubscriberFlow({ limit: 10, conflateMs: 100, stuckMs: 2000, now: () => t, ...over });
  f.advance = (ms) => { t += ms; };
  return f;
};

// ------------------------------------------------- the rungs

test('the ladder climbs with lag and each rung is cheaper than the last', () => {
  assert.equal(rungForLag(0, 10), RUNG.NONE);
  assert.equal(rungForLag(4, 10), RUNG.CONFLATING);
  assert.equal(rungForLag(8, 10), RUNG.SNAPSHOT_REFRESH);
  assert.equal(rungForLag(10, 10), RUNG.DISCONNECTING);
});

test('a subscriber keeping up stays on the bottom rung', () => {
  const f = flow();
  for (let i = 0; i < 50; i++) {
    const v = f.offer(delta(['a']));
    assert.equal(v.action, 'send');
    f.onAck(v.message.seq);
  }
  assert.equal(f.rung, RUNG.NONE);
  assert.equal(f.lag, 0);
});

// ------------------------------------------------- silence is slowness

test('a subscriber that never acks still degrades', () => {
  // An older client that does not implement `ack` would otherwise sit at lag 0
  // forever, and the ladder would be dead code against exactly the clients most
  // likely to be out of date.
  const f = flow();
  const rungs = new Set();
  for (let i = 0; i < 40; i++) { rungs.add(f.offer(delta(['a'])).rung); f.advance(200); }
  assert.ok(rungs.has(RUNG.CONFLATING));
  assert.ok(rungs.has(RUNG.SNAPSHOT_REFRESH));
  assert.ok(rungs.has(RUNG.DISCONNECTING), 'and is eventually dropped');
});

// ------------------------------------------------- conflating

test('conflating holds deltas and emits at most one per interval', () => {
  const f = flow();
  while (f.rung !== RUNG.CONFLATING) f.offer(delta(['a']));
  const before = f.sentSeq;

  const held = [];
  for (let i = 0; i < 5; i++) held.push(f.offer(delta([`k${i}`])).action);
  assert.ok(held.every((a) => a === 'hold'), 'nothing sent within the interval');

  f.advance(100);
  const v = f.offer(delta(['k9']));
  assert.equal(v.action, 'send');
  assert.equal(f.sentSeq, before + 1, 'one message for six deltas');
});

test('conflation keeps the LAST value per key', () => {
  // Only correct because a delta is a whole row image keyed by __key; partial
  // patches would silently lose fields here.
  const merged = mergeDeltas([
    delta(['a', 'b'], [1, 1]),
    delta(['a'], [2]),
  ]);
  const i = merged.columns.__key.indexOf('a');
  assert.equal(merged.columns.px[i], 2, 'later write wins');
  assert.equal(merged.rows, 2, 'and b survives');
});

test('merging nothing yields nothing, not an empty message', () => {
  assert.equal(mergeDeltas([]), null);
});

// ------------------------------------------------- snapshot refresh

test('at the refresh rung it stops sending rows entirely', () => {
  // More row data — merged or not — cannot help a consumer that has stopped
  // consuming row data.
  const f = flow();
  let v;
  do { v = f.offer(delta(['a'])); f.advance(200); } while (v.rung !== RUNG.SNAPSHOT_REFRESH);
  assert.equal(v.action, 'refresh');
  assert.equal(f.pending.length, 0, 'and the backlog is discarded');
});

test('refresh is sent ONCE, not on every delta', () => {
  const f = flow();
  let v;
  do { v = f.offer(delta(['a'])); f.advance(200); } while (v.rung !== RUNG.SNAPSHOT_REFRESH);
  const again = f.offer(delta(['a']));
  assert.equal(again.action, 'hold', 'a refresh storm is its own backpressure problem');
});

test('a subscriber that catches up returns to normal delivery', () => {
  const f = flow();
  let v;
  do { v = f.offer(delta(['a'])); f.advance(200); } while (v.rung !== RUNG.SNAPSHOT_REFRESH);
  f.onAck(f.sentSeq);                       // caught up
  const next = f.offer(delta(['a']));
  assert.equal(next.rung, RUNG.NONE);
  assert.equal(next.action, 'send');
});

// ------------------------------------------------- dropping

test('a subscriber stuck at the refresh rung is eventually dropped', () => {
  // Lag alone cannot indict it: once the hub stops sending rows, sentSeq stops
  // advancing and lag FREEZES. Without a time-based escalation a wedged tab
  // holds its subscription, its view and its share of the ceiling forever.
  const f = flow();
  let v, guard = 0;
  do {
    v = f.offer(delta(['a']));
    f.advance(200);
    if (++guard > 1000) throw new Error('ladder never reached its last rung');
  } while (v.action !== 'drop');
  assert.equal(v.rung, RUNG.DISCONNECTING);
});

test('a subscriber that keeps acking is never dropped for being stuck', () => {
  // The escalation must fire on lack of PROGRESS, not on elapsed time.
  const f = flow({ stuckMs: 500 });
  for (let i = 0; i < 200; i++) {
    const v = f.offer(delta(['a']));
    if (v.message) f.onAck(v.message.seq);
    f.advance(100);
    assert.notEqual(v.action, 'drop', `dropped a healthy subscriber at iteration ${i}`);
  }
});

test('an ack can never claim more than was sent', () => {
  // A malicious or buggy client must not be able to hide its own lag.
  const f = flow();
  f.offer(delta(['a']));
  f.onAck(999999);
  assert.equal(f.ackedSeq, f.sentSeq);
  assert.equal(f.lag, 0);
});

test('acks cannot go backwards', () => {
  const f = flow();
  for (let i = 0; i < 3; i++) f.offer(delta(['a']));
  f.onAck(3);
  f.onAck(1);
  assert.equal(f.ackedSeq, 3);
});

test('a non-numeric ack is ignored rather than corrupting the lag', () => {
  const f = flow();
  f.offer(delta(['a']));
  f.onAck('lots');
  assert.equal(f.ackedSeq, 0);
});

// ------------------------------------------------- the conflated envelope

test('a conflated message is still a rowDelta the client can route', () => {
  // `mergeDeltas` returns bare {columns, rows}. Sending that lost `type`, `id`
  // and `ref`, so the client matched it to no event type and no pending
  // request, counted it as a late reply and DISCARDED it — the middle rung of
  // the ladder did nothing at all while looking healthy from the hub's side.
  const f = flow();
  const envelope = { id: 'd-positions', type: 'rowDelta', ref: { datasourceId: 'positions' } };
  const d = (k) => ({ ...envelope, columns: { __key: [k], px: [1] }, rows: 1 });

  while (f.rung !== RUNG.CONFLATING) f.offer(d('a'));
  f.offer(d('b'));
  f.advance(100);
  const v = f.offer(d('c'));

  assert.equal(v.action, 'send');
  assert.equal(v.message.type, 'rowDelta', 'without this the client drops it');
  assert.equal(v.message.id, 'd-positions');
  assert.deepEqual(v.message.ref, { datasourceId: 'positions' });
  assert.ok(v.message.columns, 'and it still carries the merged rows');
  assert.ok(v.message.seq > 0, 'and a sequence to acknowledge');
});

test('an uncoalesced delta keeps its envelope too', () => {
  const f = flow();
  const v = f.offer({ id: 'd-x', type: 'rowDelta', ref: { datasourceId: 'p' }, columns: { __key: ['a'] }, rows: 1 });
  assert.equal(v.message.type, 'rowDelta');
  assert.equal(v.message.id, 'd-x');
});

// ------------------------------------------------- the grace period

test('a never-acking client visits EVERY rung, refresh included', () => {
  // The grace period measures time spent AT the refresh rung, not time since
  // the last ack. Measuring from the last ack looks equivalent and is not: a
  // client that never acks has lastProgressAt frozen at construction, so by the
  // time its lag reaches the refresh threshold the grace period has already
  // elapsed and it escalates in the same call — skipping the refresh rung for
  // exactly the client the ladder exists to catch.
  let t = 0;
  const f = new SubscriberFlow({ limit: 500, conflateMs: 250, stuckMs: 30_000, now: () => t });
  const d = { id: 'd', type: 'rowDelta', ref: {}, columns: { __key: ['a'], px: [1] }, rows: 1 };

  const visited = [];
  let refreshes = 0;
  for (let i = 0; i < 4000; i++) {
    const v = f.offer(d);
    if (v.action === 'refresh') refreshes++;
    if (visited.at(-1) !== v.rung) visited.push(v.rung);
    if (v.action === 'drop') break;
    t += 160;                                    // ~6 deltas/sec, the real feed rate
  }

  assert.deepEqual(visited, [RUNG.NONE, RUNG.CONFLATING, RUNG.SNAPSHOT_REFRESH, RUNG.DISCONNECTING]);
  assert.equal(refreshes, 1, 'told to re-read exactly once before being dropped');
});

test('the drop comes a grace period AFTER the refresh, not before it', () => {
  let t = 0;
  const f = new SubscriberFlow({ limit: 500, conflateMs: 250, stuckMs: 30_000, now: () => t });
  const d = { id: 'd', type: 'rowDelta', ref: {}, columns: { __key: ['a'] }, rows: 1 };
  let refreshAt = null, dropAt = null;
  for (let i = 0; i < 4000; i++) {
    const v = f.offer(d);
    if (v.action === 'refresh') refreshAt ??= t;
    if (v.action === 'drop') { dropAt = t; break; }
    t += 160;
  }
  assert.ok(refreshAt !== null && dropAt !== null);
  assert.ok(dropAt - refreshAt >= 30_000, `only ${dropAt - refreshAt}ms of grace`);
});

test('recovering from the refresh rung restarts the grace period', () => {
  // Otherwise a subscriber that stumbles once carries the clock forever and is
  // dropped on its next hiccup regardless of how healthy it was in between.
  let t = 0;
  const f = new SubscriberFlow({ limit: 10, conflateMs: 0, stuckMs: 5_000, now: () => t });
  const d = { id: 'd', type: 'rowDelta', ref: {}, columns: { __key: ['a'] }, rows: 1 };

  let v;
  do { v = f.offer(d); t += 100; } while (v.rung !== RUNG.SNAPSHOT_REFRESH);
  assert.equal(f.refreshEnteredAt !== null, true);

  f.onAck(f.sentSeq);                            // caught up
  assert.equal(f.refreshEnteredAt, null, 'clock cleared');

  t += 60_000;                                   // a long healthy period
  assert.notEqual(f.offer(d).action, 'drop', 'not dropped for old history');
});
