import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateMeter, Histogram, DatasourceStats, rungFor, RUNG } from '../src/stats.mjs';

test('a rate meter reports zero after the feed stops', () => {
  // A cumulative counter over uptime keeps looking healthy ten minutes after
  // the feed died. The window is the point.
  let now = 0;
  const m = new RateMeter({ windowMs: 5000, now: () => now });
  for (let i = 0; i < 10; i++) { m.mark(100); now += 100; }
  assert.ok(m.perSec() > 0);

  now += 10_000;
  assert.equal(m.perSec(), 0, 'silence must read as zero, not as the old average');
  assert.equal(m.total, 1000, 'the cumulative total is still available');
});

test('latency is a histogram, because an average hides the tail', () => {
  const h = new Histogram();
  for (let i = 0; i < 99; i++) h.record(10);
  h.record(900);                       // the one a trader actually notices
  const p = h.percentiles();
  assert.equal(p.p50, 10);
  assert.equal(p.max, 900);
  assert.ok(p.p99 >= 10, 'the tail is visible');
  const mean = (99 * 10 + 900) / 100;
  assert.ok(mean < 20, `an average of ${mean}ms would hide the 900ms outlier`);
});

test('an empty histogram reports null rather than a fake zero', () => {
  assert.equal(new Histogram().percentiles(), null);
});

test('the backpressure rung climbs with queue load', () => {
  assert.equal(rungFor(0, 1000), RUNG.NONE);
  assert.equal(rungFor(500, 1000), RUNG.CONFLATING);
  assert.equal(rungFor(800, 1000), RUNG.SNAPSHOT_REFRESH);
  assert.equal(rungFor(1000, 1000), RUNG.DISCONNECTING);
});

test('a failure keeps the error that explains it', () => {
  // A later transition must not erase why the datasource failed.
  let now = 0;
  const s = new DatasourceStats({ datasourceId: 'positions', now: () => now });
  s.onState('failed', 'expected 20000 rows, received 412');
  now = 5000;
  s.onState('connecting');
  assert.match(s.lastError.message, /received 412/);
  assert.equal(s.state, 'connecting', 'current state moves on');
});

test('conflation ratio reflects the window, and 1.0 is a real answer', () => {
  let now = 0;
  const s = new DatasourceStats({ datasourceId: 'x', now: () => now });
  s.onMessage(100); s.onFlush(100);
  assert.equal(s.conflationRatio, 1, 'no conflation achieved — worth seeing, not a bug');

  const s2 = new DatasourceStats({ datasourceId: 'y', now: () => now });
  s2.onMessage(100); s2.onFlush(10);
  assert.equal(s2.conflationRatio, 0.1);
});

test('a snapshot answers the questions support actually asks', () => {
  let now = 0;
  const s = new DatasourceStats({ datasourceId: 'positions', now: () => now });
  s.onMessage(50); s.onFlush(50, 12);
  s.onState('live');
  const snap = s.snapshot({ subscribers: 3, openViews: 2 });

  for (const k of ['state', 'msgsInPerSec', 'rowsInPerSec', 'rowsOutPerSec',
                   'conflationRatio', 'latency', 'backpressureRung', 'lastError',
                   'subscribers', 'openViews', 'dropped']) {
    assert.ok(k in snap, `missing "${k}" — a question that could not be answered`);
  }
  assert.equal(snap.latency.p50, 12);
});
