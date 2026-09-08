import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Registry, cacheKey, canonicalParams, supersetServes,
  MemoryBudgetExceeded, RowLimitExceeded,
} from '../src/registry.mjs';

const ds = (over = {}) => ({
  id: 'cmbs-positions',
  estimatedRows: 100_000,
  columnCount: 160,
  lifecycle: { idleTeardownMs: 300_000 },
  ...over,
});

test('param order does not change the cache key', () => {
  // Otherwise identical requests open two upstream subscriptions.
  assert.equal(
    cacheKey('d', { book: 'CMBS', ccy: 'USD' }),
    cacheKey('d', { ccy: 'USD', book: 'CMBS' })
  );
  assert.notEqual(canonicalParams({ book: 'CMBS' }), canonicalParams({ book: 'RMBS' }));
});

test('two subscribers with identical params share one table', () => {
  const r = new Registry();
  const a = r.acquire(ds(), { book: 'CMBS' });
  const b = r.acquire(ds(), { book: 'CMBS' });
  assert.equal(a, b);
  assert.equal(a.refs, 2);
  assert.equal(r.stats().tables, 1);
});

// ------------------------------------------------- superset sharing

test('a superset table serves a narrower subscriber', () => {
  // The claim that makes "one stop shop" real: book=* holds everything and
  // book=CMBS gets a filtered view of it (architecture §6).
  const r = new Registry();
  const shared = ds({ sharing: { strategy: 'superset', supersetParams: { book: '*' } } });
  const a = r.acquire(shared, { book: 'CMBS' });
  const b = r.acquire(shared, { book: 'RMBS' });
  assert.equal(a, b, 'both resolve to the one superset table');
  assert.equal(r.stats().tables, 1);
  assert.equal(a.refs, 2);
});

test('a non-wildcard param must still match exactly', () => {
  // Otherwise a subscriber silently receives a table built for another slice.
  assert.equal(supersetServes({ book: '*', region: 'EMEA' }, { book: 'CMBS', region: 'EMEA' }), true);
  assert.equal(supersetServes({ book: '*', region: 'EMEA' }, { book: 'CMBS', region: 'APAC' }), false);
});

test('a transport param the superset never wildcards still has to match', () => {
  // clientId/rate are not sharing dimensions; they decide what the upstream
  // subscription actually asks for. Ignoring them would hand a subscriber a
  // table fed by someone else's trigger.
  const entry = { clientId: 'trd1', rate: 2000, desk: '*' };
  assert.equal(supersetServes(entry, { clientId: 'trd1', rate: 2000, desk: 'Govies' }), true);
  assert.equal(supersetServes(entry, { clientId: 'trd1', rate: 2000, desk: 'Rates' }), true);
  assert.equal(supersetServes(entry, { clientId: 'trd2', rate: 2000, desk: 'Govies' }), false);
  assert.equal(supersetServes(entry, { clientId: 'trd1', rate: 500, desk: 'Govies' }), false);
});

test('without superset sharing, different params get different tables', () => {
  const r = new Registry();
  r.acquire(ds(), { book: 'CMBS' });
  r.acquire(ds(), { book: 'RMBS' });
  assert.equal(r.stats().tables, 2);
});

// ------------------------------------------------- admission (§6.2)

test('a subscription that cannot fit the ceiling is refused BEFORE creation', () => {
  // Refusing up front beats discovering it mid-snapshot, when the memory is
  // already spent and the tab is already in trouble.
  const r = new Registry({ processCeilingBytes: 100_000_000 });
  let created = 0;
  assert.throws(
    () => r.acquire(ds({ estimatedRows: 500_000, columnCount: 160 }), {}, () => { created++; }),
    MemoryBudgetExceeded
  );
  assert.equal(created, 0, 'the table must not be constructed');
  assert.equal(r.stats().tables, 0);
});

test('the ceiling accounts across tables, not per table', () => {
  // A per-table guard alone cannot stop several tables from exhausting the
  // address space — the gap this closes.
  const r = new Registry({ processCeilingBytes: 2_500_000_000 });
  const mid = ds({ estimatedRows: 20_000, columnCount: 372 }); // ~238 MB each, measured shape
  for (const book of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) r.acquire(mid, { book });
  assert.equal(r.stats().tables, 10, 'ten tables of this size fit');
  assert.throws(() => r.acquire(mid, { book: 'K' }), MemoryBudgetExceeded);
});

test('a single 500k-row table of real width does NOT fit the browser ceiling', () => {
  // Measured: ~30-42 bytes/cell (phase-0-findings.md §8). At 372 columns a
  // 500k-row table projects to ~6 GB against a ~3.8 GB browser cap. This is the
  // sidecar's case, and the test exists so the limit is asserted rather than
  // discovered by a trader.
  const r = new Registry({ processCeilingBytes: 2_500_000_000 });
  assert.throws(
    () => r.acquire(ds({ estimatedRows: 500_000, columnCount: 372, lifecycle: {} }), {}),
    MemoryBudgetExceeded
  );
});

test('the same row count at the architecture\'s assumed width still does not fit', () => {
  // 500k x 160 projects to ~2.56 GB — under the raw ceiling but over a budget
  // that must also hold the engine, the grid and the page.
  const r = new Registry({ processCeilingBytes: 2_500_000_000 });
  assert.throws(
    () => r.acquire(ds({ estimatedRows: 500_000, columnCount: 160, lifecycle: {} }), {}),
    MemoryBudgetExceeded
  );
});

test('lifecycle.maxRows still guards a single oversized table', () => {
  const r = new Registry();
  assert.throws(
    () => r.acquire(ds({ estimatedRows: 900_000, lifecycle: { maxRows: 800_000 } }), {}),
    RowLimitExceeded
  );
});

test('the refusal carries a typed code the provider can act on', () => {
  const r = new Registry({ processCeilingBytes: 1 });
  try {
    r.acquire(ds(), {});
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.code, 'memory-ceiling-exceeded');
  }
});

// ------------------------------------------------- lifecycle

test('the last release arms idle teardown rather than tearing down at once', () => {
  // Closing and reopening a blotter must not force a re-snapshot.
  const timers = [];
  const r = new Registry({ setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  r.acquire(ds(), { book: 'CMBS' });
  r.release('cmbs-positions', { book: 'CMBS' });

  assert.equal(r.stats().tables, 1, 'still present, awaiting the timer');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 300_000);

  timers[0].fn();
  assert.equal(r.stats().tables, 0);
});

test('re-acquiring during the idle window cancels teardown', () => {
  let cleared = 0;
  const r = new Registry({ setTimer: () => 't', clearTimer: () => { cleared++; } });
  r.acquire(ds(), { book: 'CMBS' });
  r.release('cmbs-positions', { book: 'CMBS' });
  const again = r.acquire(ds(), { book: 'CMBS' });
  assert.equal(cleared, 1);
  assert.equal(again.refs, 1);
  assert.equal(again.teardownTimer, null);
});

test('a prewarmed table is never torn down', () => {
  const timers = [];
  const r = new Registry({ setTimer: (fn) => { timers.push(fn); return timers.length; } });
  r.acquire(ds({ lifecycle: { prewarm: true, idleTeardownMs: 1000 } }), {});
  r.release('cmbs-positions', {});
  assert.equal(timers.length, 0, 'no teardown timer for a prewarmed table');
  assert.equal(r.stats().tables, 1);
});

test('only unreferenced non-prewarm tables are eviction candidates', () => {
  const r = new Registry({ setTimer: () => 't' });
  r.acquire(ds({ id: 'a' }), {});
  r.acquire(ds({ id: 'b' }), {});
  r.acquire(ds({ id: 'c', lifecycle: { prewarm: true } }), {});
  r.release('b', {});
  r.release('c', {});

  const names = r.evictionCandidates().map((e) => e.datasourceId);
  assert.deepEqual(names, ['b'], 'referenced and prewarmed tables are not candidates');
});
