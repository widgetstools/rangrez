/**
 * View-leak test (Phase 8 exit criterion).
 *
 * "500 expand/collapse cycles and 50 filter opens return the hub's open-view
 * count to baseline." SSRM holds one view per expanded node and VRM mutates one
 * view, so a missed disposal does not crash — it accretes. The parity study
 * names this as the failure that shows up two weeks into UAT, invisible until
 * the process ceiling is hit. This proves the count comes back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SsrmMode, ViewCache } from '../src/modes/ssrm.mjs';
import { VrmMode } from '../src/modes/vrm.mjs';

const artifact = { keyColumns: ['positionId'], columns: [] };

/** A dataService that COUNTS live views — open increments, dispose decrements. */
function countingService({ groups = 20 } = {}) {
  const s = {
    open: 0, everOpened: 0, everDisposed: 0,
    async openView(spec) { s.open++; s.everOpened++; return { id: s.everOpened, spec }; },
    async disposeView() { s.open--; s.everDisposed++; },
    async readWindow(_h, { startRow = 0, endRow }) {
      const view = [{ __ROW_PATH__: [], mv: 0 }];
      for (let i = 0; i < groups; i++) view.push({ __ROW_PATH__: [`G${i}`], mv: i });
      const rows = view.slice(startRow, endRow ?? view.length);
      return { rows, rowCount: view.length };
    },
    async expandRow(_h, index, collapse) {
      // VRM mutates ONE view in place — expanding must not open another.
      return { rowCount: groups + 1 + (collapse ? -5 : 5) };
    },
  };
  return s;
}

const gridParams = () => {
  const p = { rowCounts: [], blocks: [] };
  p.setRowCount = (n, keep) => p.rowCounts.push([n, keep]);
  p.setRowData = (b) => p.blocks.push(b);
  p.getRow = () => null;
  return p;
};

// ------------------------------------------------- SSRM filter opens

test('50 distinct filter opens leave NO views behind', async () => {
  // Each filter is a different request signature -> a different view. With a
  // bounded cache, opening 50 past a cap of, say, 12 must dispose the excess as
  // it evicts, and clearing the cache must dispose the rest. Baseline is 0.
  const svc = countingService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'], maxViews: 12 });
  const req = (i) => ({
    request: { startRow: 0, endRow: 100, groupKeys: [], rowGroupCols: [],
      valueCols: [], sortModel: [], filterModel: { desk: { filterType: 'text', type: 'equals', filter: `D${i}` } } },
    success() {}, fail() {},
  });

  for (let i = 0; i < 50; i++) await m.getRows(req(i));
  assert.ok(svc.open <= 12, `over cap: ${svc.open} views held`);
  assert.ok(svc.everDisposed >= 50 - 12, 'the excess was disposed as it evicted');

  await m.destroy();
  assert.equal(svc.open, 0, `leaked ${svc.open} views after teardown`);
});

test('re-opening the SAME filter reuses one view, never a second', async () => {
  const svc = countingService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'], maxViews: 12 });
  const same = () => ({
    request: { startRow: 0, endRow: 100, groupKeys: [], rowGroupCols: [], valueCols: [], sortModel: [],
      filterModel: { desk: { filterType: 'text', type: 'equals', filter: 'Govies' } } },
    success() {}, fail() {},
  });
  for (let i = 0; i < 30; i++) await m.getRows(same());
  assert.equal(svc.everOpened, 1, `opened ${svc.everOpened} views for one query`);
  await m.destroy();
  assert.equal(svc.open, 0);
});

// ------------------------------------------------- VRM expand/collapse cycles

test('500 expand/collapse cycles hold exactly ONE view throughout', async () => {
  // VRM's entire economic argument. A cycle that opened a view would be 500
  // leaked views by the end.
  const svc = countingService();
  const m = new VrmMode({
    dataService: svc, artifact,
    viewSpec: { groupBy: ['desk'], aggregates: { mv: 'sum' }, depth: 1 },
    bufferRows: 5,
  });
  m.datasource().init(gridParams());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(svc.open, 1, 'one view for the tree');

  for (let i = 0; i < 500; i++) {
    await m.toggle(1, { __expanded: false });    // expand
    await m.toggle(1, { __expanded: true });     // collapse
  }
  assert.equal(svc.open, 1, `held ${svc.open} views after 500 cycles`);
  assert.equal(svc.everOpened, 1, 'and never opened a second one');

  await m.destroy();
  assert.equal(svc.open, 0, 'disposed on teardown');
});

// ------------------------------------------------- the cache primitive

test('ViewCache disposes exactly the views it evicts, and clear() drains it', async () => {
  let live = 0;
  const cache = new ViewCache({ max: 5, dispose: async () => { live--; } });
  for (let i = 0; i < 40; i++) { live++; await cache.set(`k${i}`, { id: i }); }
  assert.equal(cache.size, 5, 'bounded');
  assert.equal(live, 5, `${live} live after 40 inserts past a cap of 5`);
  await cache.clear();
  assert.equal(live, 0, 'clear disposed the survivors');
  assert.equal(cache.size, 0);
});

test('a pinned view is not disposed until the read finishes, then it IS', async () => {
  // The subtle leak: deferring disposal of a view being read must not become
  // never disposing it.
  let live = 0;
  const cache = new ViewCache({ max: 1, dispose: async () => { live--; } });
  live++; await cache.set('a', { id: 'a' });
  const a = cache.get('a'); cache.pin(a);
  live++; await cache.set('b', { id: 'b' });     // wants to evict 'a', but it is pinned
  assert.equal(live, 2, 'both held while a is read');
  await cache.unpin(a);
  live++; await cache.set('c', { id: 'c' });     // now a can go
  assert.equal(live, 1, 'a was reclaimed once free');
  await cache.clear();
  assert.equal(live, 0);
});

test('a stress of interleaved opens and clears never ends above baseline', async () => {
  let live = 0;
  const cache = new ViewCache({ max: 8, dispose: async () => { live--; } });
  for (let round = 0; round < 20; round++) {
    for (let i = 0; i < 25; i++) { live++; await cache.set(`r${round}-${i}`, { round, i }); }
    if (round % 4 === 3) { await cache.clear(); assert.equal(live, 0, `round ${round}: ${live} leaked`); }
  }
  await cache.clear();
  assert.equal(live, 0, 'baseline restored');
});
