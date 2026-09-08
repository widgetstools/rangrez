import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SsrmMode, toViewSpec, requestSignature, filterModelToOps, ViewCache, pivotFieldsOf } from '../src/modes/ssrm.mjs';

const SEP = String.fromCharCode(1);
const artifact = { keyColumns: ['positionId'], columns: [] };
const col = (id) => ({ id, field: id });

/** Hub-backed dataService stand-in that records view lifecycle. */
function fakeService() {
  const s = {
    opened: [], disposed: [], windows: [],
    openView: async (spec) => { const h = { id: s.opened.length, spec }; s.opened.push(spec); return h; },
    disposeView: async (h) => { s.disposed.push(h.id); },
    readWindow: async (h, range) => {
      s.windows.push({ view: h.id, ...range });
      return { rows: [{ positionId: 'P1' }, { positionId: 'P2' }], rowCount: 20000 };
    },
  };
  return s;
}

const params = (request) => {
  const out = { request, ok: null, failed: false };
  out.success = (r) => { out.ok = r; };
  out.fail = () => { out.failed = true; };
  return out;
};

// ------------------------------------------------- request translation

test('groupKeys become equality filters, one per expanded level', () => {
  const spec = toViewSpec({
    groupKeys: ['Govies', 'Sarah'],
    rowGroupCols: [col('desk'), col('trader'), col('bookName')],
  });
  assert.deepEqual(spec.filter, [
    { column: 'desk', op: 'equals', value: 'Govies' },
    { column: 'trader', op: 'equals', value: 'Sarah' },
  ]);
});

test('only the NEXT group level is grouped, not the whole list', () => {
  // Passing every rowGroupCol returns the fully expanded tree for what is a
  // single node expansion — the classic SSRM translation mistake.
  const spec = toViewSpec({
    groupKeys: ['Govies'],
    rowGroupCols: [col('desk'), col('trader'), col('bookName')],
  });
  assert.deepEqual(spec.groupBy, ['trader'], 'the level below the expanded one');
  assert.equal(spec.depth, 1, 'one level of children');
});

test('at the leaf level there is no grouping at all', () => {
  const spec = toViewSpec({
    groupKeys: ['Govies', 'Sarah'],
    rowGroupCols: [col('desk'), col('trader')],
  });
  assert.equal(spec.groupBy, undefined, 'fully expanded — leaf rows, not groups');
});

test('valueCols become aggregates on the grouped level', () => {
  const spec = toViewSpec({
    groupKeys: [], rowGroupCols: [col('desk')],
    valueCols: [{ id: 'notional', aggFunc: 'sum' }, { id: 'dv01', aggFunc: 'avg' }],
  });
  assert.deepEqual(spec.aggregates, { notional: 'sum', dv01: 'avg' });
});

test('sortModel maps through', () => {
  const spec = toViewSpec({ sortModel: [{ colId: 'px', sort: 'desc' }] });
  assert.deepEqual(spec.sort, [{ column: 'px', dir: 'desc' }]);
});

test('soft-deleted rows are excluded server-side', () => {
  const spec = toViewSpec({}, { softDeleteColumn: '_deleted' });
  assert.deepEqual(spec.filter, [{ column: '_deleted', op: 'notEqual', value: true }]);
});

// ------------------------------------------------- filter translation

test('an empty set filter stays empty, meaning nothing', () => {
  assert.deepEqual(
    filterModelToOps('desk', { filterType: 'set', values: [] }),
    [{ column: 'desk', op: 'in', value: [] }]
  );
});

test('inRange survives as a range, not two guesses', () => {
  assert.deepEqual(
    filterModelToOps('px', { filterType: 'number', type: 'inRange', filter: 1, filterTo: 5 }),
    [{ column: 'px', op: 'inRange', value: 1, valueTo: 5 }]
  );
});

test('AND conditions flatten', () => {
  const out = filterModelToOps('px', {
    filterType: 'number', operator: 'AND',
    conditions: [
      { filterType: 'number', type: 'greaterThan', filter: 1 },
      { filterType: 'number', type: 'lessThan', filter: 9 },
    ],
  });
  assert.equal(out.length, 2);
});

test('an OR condition becomes one `or` node, not a narrowed AND', () => {
  // Silently dropping a branch would show a trader FEWER rows than they asked
  // for. It used to throw for that reason; it now translates.
  const ops = filterModelToOps('desk', { filterType: 'text', operator: 'OR', conditions: [
    { filterType: 'text', type: 'equals', filter: 'A' },
    { filterType: 'text', type: 'equals', filter: 'B' },
  ] });
  assert.equal(ops.length, 1, 'one node, not two ANDed conditions');
  assert.equal(ops[0].op, 'or');
});

test('an untranslatable filter type throws rather than being dropped', () => {
  assert.throws(
    () => filterModelToOps('x', { filterType: 'text', type: 'regex', filter: '.*' }),
    (e) => e.code === 'unsupported-expression'
  );
});

// ------------------------------------------------- caching

test('the signature ignores the row range, so one view serves every window', () => {
  const base = { groupKeys: [], rowGroupCols: [], sortModel: [] };
  assert.equal(
    requestSignature({ ...base, startRow: 0, endRow: 100 }),
    requestSignature({ ...base, startRow: 100, endRow: 200 }),
    'including the range would make the cache useless'
  );
});

test('the signature distinguishes different queries', () => {
  const a = requestSignature({ groupKeys: ['Govies'], rowGroupCols: [col('desk')] });
  const b = requestSignature({ groupKeys: ['Rates'], rowGroupCols: [col('desk')] });
  assert.notEqual(a, b);
});

test('scrolling within one query reuses the view instead of opening more', async () => {
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const req = { groupKeys: [], rowGroupCols: [], sortModel: [], filterModel: {} };

  await m.getRows(params({ ...req, startRow: 0, endRow: 100 }));
  await m.getRows(params({ ...req, startRow: 100, endRow: 200 }));
  await m.getRows(params({ ...req, startRow: 200, endRow: 300 }));

  assert.equal(svc.opened.length, 1, 'one view for three scroll blocks');
  assert.equal(svc.windows.length, 3);
});

test('eviction DISPOSES, which is the entire point of the cache', async () => {
  // A view per expanded node that is never disposed is the leak that shows up
  // as worker memory growth two weeks into UAT.
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'], maxViews: 2 });

  for (const desk of ['A', 'B', 'C', 'D']) {
    await m.getRows(params({ groupKeys: [desk], rowGroupCols: [col('desk')], sortModel: [] }));
  }
  assert.equal(svc.opened.length, 4);
  assert.equal(svc.disposed.length, 2, 'the two evicted views were disposed');
  assert.equal(m.cache.size, 2, 'bounded');
});

test('destroy disposes everything still cached', async () => {
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  await m.getRows(params({ groupKeys: [], rowGroupCols: [], sortModel: [] }));
  await m.destroy();
  assert.equal(svc.disposed.length, 1);
});

test('the LRU keeps the most recently used, not the most recently added', async () => {
  const disposed = [];
  const c = new ViewCache({ max: 2, dispose: async (v) => disposed.push(v) });
  await c.set('a', 'A'); await c.set('b', 'B');
  c.get('a');                       // refresh 'a'
  await c.set('c', 'C');            // should evict 'b'
  assert.deepEqual(disposed, ['B']);
});

// ------------------------------------------------- row identity

test('a leaf row id is byte-identical to the hub key encoding', () => {
  const m = new SsrmMode({ dataService: fakeService(), artifact, keyColumns: ['book', 'positionId'] });
  const id = m.getRowId({ level: -1, data: { book: 'CMBS', positionId: 'P-1' } });
  assert.equal(id, `r:CMBS${SEP}P-1`);
});

test('a group row id is distinct from any leaf row id', () => {
  // Colliding group and leaf ids makes transactions route to the wrong node.
  const m = new SsrmMode({ dataService: fakeService(), artifact, keyColumns: ['positionId'] });
  const group = m.getRowId({
    level: 0, parentKeys: [], data: { desk: 'Govies' },
    api: { getRowGroupColumns: () => [{ getColId: () => 'desk' }] },
  });
  const leaf = m.getRowId({ level: -1, data: { positionId: 'Govies' } });
  assert.notEqual(group, leaf);
  assert.match(group, /^g:/);
  assert.match(leaf, /^r:/);
});

// ------------------------------------------------- failure handling

test('a failed request calls fail(), not an empty success', async () => {
  // An empty success reads as "no data here" and the grid never retries.
  const svc = fakeService();
  svc.openView = async () => { throw new Error('view creation failed'); };
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const p = params({ groupKeys: [], rowGroupCols: [], sortModel: [] });
  await m.getRows(p);

  assert.equal(p.failed, true);
  assert.equal(p.ok, null, 'must not report success with zero rows');
  assert.equal(m.failures, 1);
});

test('success carries the server row count for scrollbar sizing', async () => {
  const m = new SsrmMode({ dataService: fakeService(), artifact, keyColumns: ['positionId'] });
  const p = params({ groupKeys: [], rowGroupCols: [], sortModel: [], startRow: 0, endRow: 100 });
  await m.getRows(p);
  assert.equal(p.ok.rowCount, 20000, 'the grid cannot size its scrollbar without this');
  assert.equal(p.ok.rowData.length, 2);
});

// ------------------------------------------------- grouped result mapping

test('__ROW_PATH__ maps onto the grouped column', async () => {
  // Perspective returns the group value in __ROW_PATH__, not in a field named
  // after the column. Passing it through renders blank group rows.
  const { mapGroupRows } = await import('../src/modes/ssrm.mjs');
  const rows = [
    { __ROW_PATH__: [], marketValue: 999 },            // the root — grand total
    { __ROW_PATH__: ['Govies'], marketValue: 100 },
    { __ROW_PATH__: ['Rates'], marketValue: 200 },
  ];
  assert.deepEqual(mapGroupRows(rows, 'desk'), [
    { __ROW_PATH__: ['Govies'], marketValue: 100, desk: 'Govies' },
    { __ROW_PATH__: ['Rates'], marketValue: 200, desk: 'Rates' },
  ]);
});

test('the ROOT row is dropped, not shown as a sibling group', async () => {
  const { mapGroupRows } = await import('../src/modes/ssrm.mjs');
  const out = mapGroupRows([{ __ROW_PATH__: [], v: 1 }], 'desk');
  assert.deepEqual(out, [], 'the grand total is not a group');
});

test('a nested path takes its LAST segment as the group value', async () => {
  const { mapGroupRows } = await import('../src/modes/ssrm.mjs');
  const out = mapGroupRows([{ __ROW_PATH__: ['Govies', 'Sarah'], v: 1 }], 'trader');
  assert.equal(out[0].trader, 'Sarah', 'the level being expanded, not the parent');
});

test('leaf rows pass through untouched', async () => {
  const { mapGroupRows } = await import('../src/modes/ssrm.mjs');
  const leaves = [{ positionId: 'P1' }, { positionId: 'P2' }];
  assert.deepEqual(mapGroupRows(leaves, undefined), leaves);
  assert.deepEqual(mapGroupRows(leaves, 'desk'), leaves, 'no __ROW_PATH__ means not grouped');
});

test('rowCount excludes the dropped root so the scrollbar is not one row long', async () => {
  const svc = fakeService();
  svc.readWindow = async () => ({
    rows: [{ __ROW_PATH__: [] }, { __ROW_PATH__: ['A'] }, { __ROW_PATH__: ['B'] }],
    rowCount: 3,
  });
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const p = params({ groupKeys: [], rowGroupCols: [col('desk')], sortModel: [] });
  await m.getRows(p);
  assert.equal(p.ok.rowData.length, 2);
  assert.equal(p.ok.rowCount, 2, 'the root is not a row the grid can scroll to');
});

test('a soft-delete column the table lacks is ignored, not pushed to the engine', () => {
  // CSRM tolerates a missing column silently (undefined passes the filter), so
  // the misconfiguration survives to SSRM — where Perspective rejects the whole
  // view with "Invalid column" and every getRows fails, showing one blank row
  // with the cause three layers away.
  const m = new SsrmMode({
    dataService: fakeService(), artifact, keyColumns: ['positionId'], softDeleteColumn: '_deleted',
  });
  assert.equal(m.softDeleteColumn, undefined);
  assert.equal(m.ignoredSoftDelete, true, 'flagged, so diagnostics can surface the misconfiguration');
});

test('a soft-delete column the table HAS is honoured', () => {
  const withFlag = { keyColumns: ['positionId'], columns: [{ id: '_deleted', column: '_deleted', type: 'boolean' }] };
  const m = new SsrmMode({
    dataService: fakeService(), artifact: withFlag, keyColumns: ['positionId'], softDeleteColumn: '_deleted',
  });
  assert.equal(m.softDeleteColumn, '_deleted');
  assert.equal(m.ignoredSoftDelete, false);
});

// ------------------------------------------------- grouped block alignment

/** A grouped view exactly as Perspective returns one: index 0 is the ROOT. */
function groupedService(groups = 500) {
  const view = [{ __ROW_PATH__: [], mv: -1 }];
  for (let i = 0; i < groups; i++) view.push({ __ROW_PATH__: [`G${i}`], mv: i });
  return {
    view,
    opened: [], disposed: [],
    openView: async (spec) => ({ id: 1, spec }),
    disposeView: async (h) => {},
    readWindow: async (_h, { startRow, endRow }) => ({
      rows: view.slice(startRow, endRow ?? view.length),
      rowCount: view.length,
    }),
  };
}

const groupReq = (startRow, endRow) => ({
  startRow, endRow, groupKeys: [], rowGroupCols: [col('desk')],
  valueCols: [], sortModel: [], filterModel: {},
});

test('a grouped block returns a FULL block, not one short', async () => {
  // The root sits at view index 0. Windowing first and dropping it afterwards
  // costs one row per block.
  const svc = groupedService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const p = params(groupReq(0, 100));
  await m.getRows(p);
  assert.equal(p.ok.rowData.length, 100, 'asked for 100 group rows');
  assert.equal(p.ok.rowData[0].desk, 'G0', 'and the first is the first group, not the root');
});

test('grouped blocks tile the row space with no hole and no gap', async () => {
  // The failure this pins: block [0,100) delivered 99 rows, leaving grid index
  // 99 EMPTY and shifting every later block by one, with one group never
  // delivered at all. Four desks hid it; any realistic grouping does not.
  const svc = groupedService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });

  const grid = [];
  for (const [s, e] of [[0, 100], [100, 200], [200, 300]]) {
    const p = params(groupReq(s, e));
    await m.getRows(p);
    p.ok.rowData.forEach((r, i) => { grid[s + i] = r.desk; });
  }

  for (let i = 0; i < 300; i++) {
    assert.equal(grid[i], `G${i}`, `grid row ${i} should be group ${i}`);
  }
});

test('the root is excluded from the reported row count', async () => {
  const svc = groupedService(500);
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const p = params(groupReq(0, 100));
  await m.getRows(p);
  assert.equal(p.ok.rowCount, 500, '500 groups, not the 501 rows the view holds');
});

test('an UNGROUPED block is not offset — there is no root to skip', async () => {
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const p = params({ startRow: 40, endRow: 80, groupKeys: [], rowGroupCols: [], valueCols: [], sortModel: [], filterModel: {} });
  await m.getRows(p);
  assert.deepEqual(
    { startRow: svc.windows.at(-1).startRow, endRow: svc.windows.at(-1).endRow },
    { startRow: 40, endRow: 80 },
  );
  assert.equal(p.ok.rowCount, 20000, 'and the count is untouched');
});

test('a grouped read asks the hub for the OFFSET window', async () => {
  const svc = groupedService();
  const seen = [];
  svc.readWindow = async (_h, r) => { seen.push(r); return { rows: [], rowCount: 501 }; };
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  await m.getRows(params(groupReq(200, 300)));
  assert.deepEqual(seen.at(-1), { startRow: 201, endRow: 301 }, 'the offset belongs on the request');
});

// ------------------------------------------------- eviction safety

test('a view being READ FROM is never evicted out from under the read', async () => {
  // AG-Grid issues block loads concurrently, so a slow read racing a cache
  // insert is an ordinary fast scroll. Disposing mid-read fails the block.
  let release;
  const gate = new Promise((r) => { release = r; });
  const disposed = [];
  let n = 0;
  const svc = {
    openView: async () => ({ id: ++n }),
    disposeView: async (h) => { disposed.push(h.id); },
    readWindow: async (h) => {
      await gate;
      if (disposed.includes(h.id)) throw new Error(`view ${h.id} was disposed mid-read`);
      return { rows: [{ positionId: 'P1' }], rowCount: 1 };
    },
  };
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'], maxViews: 1 });

  const slow = m.getRows(params({ startRow: 0, endRow: 10, groupKeys: [], rowGroupCols: [], valueCols: [], sortModel: [], filterModel: { a: { filterType: 'text', type: 'equals', filter: 'x' } } }));
  // A different signature -> a different view -> pressure to evict the first.
  const other = m.getRows(params({ startRow: 0, endRow: 10, groupKeys: [], rowGroupCols: [], valueCols: [], sortModel: [], filterModel: { a: { filterType: 'text', type: 'equals', filter: 'y' } } }));

  release();
  await Promise.all([slow, other]);
  assert.equal(m.failures, 0, `no block should fail: ${m.lastError?.message ?? ''}`);
});

test('a pinned view is KEPT, and evicted normally once free', async () => {
  // Going briefly over the cap is the right trade against failing a block: the
  // entry is still valid and reusable, so it is skipped rather than condemned.
  const disposed = [];
  const cache = new ViewCache({ max: 1, dispose: async (v) => disposed.push(v.id) });
  const a = { id: 'a' }, b = { id: 'b' };
  await cache.set('k1', a);
  cache.pin(a);
  await cache.set('k2', b);
  assert.deepEqual(disposed, [], 'not while it is being read');
  assert.equal(cache.size, 2, 'briefly over the cap');

  await cache.unpin(a);
  await cache.set('k3', { id: 'c' });
  assert.ok(disposed.includes('a'), 'and reclaimed as soon as it is free');
});

test('nested reads of one view only release on the last unpin', async () => {
  const disposed = [];
  const cache = new ViewCache({ max: 1, dispose: async (v) => disposed.push(v.id) });
  const a = { id: 'a' };
  await cache.set('k1', a);
  cache.pin(a); cache.pin(a);
  await cache.unpin(a);
  await cache.set('k2', { id: 'b' });
  assert.deepEqual(disposed, [], 'one reader is still going');
  await cache.unpin(a);
  await cache.set('k3', { id: 'c' });
  assert.ok(disposed.includes('a'), 'freed only after the last reader');
});

test('destroy defers disposal of a view still being read', async () => {
  const disposed = [];
  const cache = new ViewCache({ max: 5, dispose: async (v) => disposed.push(v.id) });
  const a = { id: 'a' };
  await cache.set('k1', a);
  cache.pin(a);
  await cache.clear();
  assert.deepEqual(disposed, [], 'the read is still in flight');
  await cache.unpin(a);
  assert.deepEqual(disposed, ['a'], 'and it is not leaked either');
});

// ------------------------------------------------- diagnosability

test('a failed block records WHY, not just that it failed', async () => {
  // Every SSRM fault used to look identical from the outside: one blank row.
  const svc = fakeService();
  svc.openView = async () => { throw Object.assign(new Error('Invalid column "_deleted"'), { code: 'invalid-params' }); };
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const p = params({ startRow: 0, endRow: 10, groupKeys: [], rowGroupCols: [] });
  await m.getRows(p);
  assert.equal(p.failed, true);
  assert.match(m.lastError.message, /Invalid column/);
  assert.equal(m.lastError.code, 'invalid-params');
});

// ------------------------------------------------- cache key stability

test('the same filters in a different order hit the SAME cached view', async () => {
  // filterModel key order follows the order the user applied the filters. Under
  // plain JSON.stringify that meant a cache miss and a fresh view for a query
  // already held — and a grouped view costs ~300ms and 3.3x on ingest.
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const base = { startRow: 0, endRow: 10, groupKeys: [], rowGroupCols: [], valueCols: [], sortModel: [] };
  const f1 = { desk: { filterType: 'set', values: ['G'] }, trader: { filterType: 'set', values: ['J'] } };
  const f2 = { trader: { filterType: 'set', values: ['J'] }, desk: { filterType: 'set', values: ['G'] } };

  await m.getRows(params({ ...base, filterModel: f1 }));
  await m.getRows(params({ ...base, filterModel: f2 }));
  assert.equal(svc.opened.length, 1, 'one view, not two');
});

test('sort PRECEDENCE still distinguishes requests', () => {
  // Array order is meaningful and must survive the stabilisation.
  assert.notEqual(
    requestSignature({ sortModel: [{ colId: 'a' }, { colId: 'b' }] }),
    requestSignature({ sortModel: [{ colId: 'b' }, { colId: 'a' }] }),
  );
});

// ------------------------------------------------- live updates

function refreshHarness() {
  const timers = [];
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const gridApi = { refreshes: [], refreshServerSide: (o) => gridApi.refreshes.push(o) };
  let handler = null;
  const control = { on: (t, fn) => { if (t === 'rowDelta') handler = fn; return () => { handler = null; }; } };
  const off = m.attach(control, gridApi, { setTimer: (fn) => { timers.push(fn); return timers.length; } });
  return { m, gridApi, timers, fire: () => handler?.(), off, get handler() { return handler; } };
}

test('SSRM refreshes loaded blocks when the data changes', async () => {
  // SSRM has no delta path — the grid owns its blocks, so re-fetching them is
  // the only way to show new values. Without this the blotter renders its
  // opening snapshot and never changes again.
  const h = refreshHarness();
  h.fire();
  await h.timers[0]();
  assert.equal(h.gridApi.refreshes.length, 1);
});

test('the refresh does NOT purge, so the grid does not blank on every tick', async () => {
  const h = refreshHarness();
  h.fire();
  await h.timers[0]();
  assert.equal(h.gridApi.refreshes[0].purge, false);
});

test('a burst of deltas coalesces into one refresh', async () => {
  // Each refresh re-reads every loaded block, so this is the expensive way to
  // be live and the interval is the throttle.
  const h = refreshHarness();
  for (let i = 0; i < 200; i++) h.fire();
  assert.equal(h.timers.length, 1, 'one timer armed for 200 deltas');
  await h.timers[0]();
  assert.equal(h.gridApi.refreshes.length, 1, 'one refresh, not 200');
});

test('a delta after a refresh arms a fresh timer', async () => {
  const h = refreshHarness();
  h.fire();
  await h.timers[0]();
  h.fire();
  assert.equal(h.timers.length, 2, 'coalescing must not latch off permanently');
});

test('destroy stops the live subscription', async () => {
  const h = refreshHarness();
  await h.m.destroy();
  assert.equal(h.handler, null, 'a live subscription after teardown is a leak');
});

// ------------------------------------------------- quick search

test('quick search becomes an OR across the searched COLUMNS', () => {
  // `searchFilterModel` produces one entry whose conditions each name their own
  // column. Treating `__search__` as a column asked the engine for a column
  // that does not exist; before that it threw on the OR. Either way quick
  // search did not work in SSRM at all.
  const ops = filterModelToOps('__search__', {
    filterType: 'multi', operator: 'OR', columns: ['desk', 'trader'],
    conditions: [
      { filterType: 'text', type: 'contains', filter: 'gov', colId: 'desk' },
      { filterType: 'text', type: 'contains', filter: 'gov', colId: 'trader' },
    ],
  });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'or');
  assert.deepEqual(ops[0].conditions.map((c) => c.column), ['desk', 'trader']);
  assert.ok(ops[0].conditions.every((c) => c.op === 'contains'));
});

test('an empty search contributes no filter at all', () => {
  assert.deepEqual(filterModelToOps('__search__', { conditions: [] }), []);
});

test('quick search reaches the view spec', () => {
  const spec = toViewSpec({
    groupKeys: [], rowGroupCols: [],
    filterModel: { __search__: { operator: 'OR', conditions: [
      { filterType: 'text', type: 'contains', filter: 'gov', colId: 'desk' },
    ] } },
  });
  assert.equal(spec.filter[0].op, 'or');
});

// ------------------------------------------------- pivot

test('pivot maps to splitBy', () => {
  // requestSignature already keyed the cache on pivotCols and pivotMode, but
  // nothing READ them — so two pivots built identical views and a pivoted grid
  // was served unpivoted data. Silently wrong rather than unsupported.
  const spec = toViewSpec({
    groupKeys: [], rowGroupCols: [col('desk')], pivotMode: true,
    pivotCols: [col('currency')], valueCols: [{ id: 'marketValue', aggFunc: 'sum' }],
  });
  assert.deepEqual(spec.splitBy, ['currency']);
});

test('pivot restricts the columns before splitting', () => {
  // Perspective splits every column it is given: an unrestricted pivot of this
  // corpus produced 2,612 columns instead of 15, all of them materialised.
  const spec = toViewSpec({
    groupKeys: [], rowGroupCols: [col('desk')], pivotMode: true,
    pivotCols: [col('currency')],
    valueCols: [{ id: 'marketValue', aggFunc: 'sum' }, { id: 'dv01', aggFunc: 'sum' }],
  });
  assert.deepEqual(spec.columns, ['marketValue', 'dv01']);
});

test('pivotMode off means no split, whatever pivotCols says', () => {
  const spec = toViewSpec({
    groupKeys: [], rowGroupCols: [col('desk')], pivotMode: false, pivotCols: [col('currency')],
  });
  assert.equal(spec.splitBy, undefined);
});

test('pivot result fields are read from the DATA', () => {
  // The set of splits is whatever values actually occur; computing it would
  // mean knowing every currency in the book before reading it.
  const fields = pivotFieldsOf([
    { __ROW_PATH__: ['Govies'], 'AUD|marketValue': 1, 'CAD|marketValue': 2 },
    { __ROW_PATH__: ['EM Debt'], 'AUD|marketValue': 3, 'USD|marketValue': 4 },
  ]);
  assert.deepEqual(fields.sort(), ['AUD|marketValue', 'CAD|marketValue', 'USD|marketValue']);
});

test('the tree path is never a pivot field', () => {
  assert.deepEqual(pivotFieldsOf([{ __ROW_PATH__: ['x'], plain: 1 }]), []);
});

// ------------------------------------------------- quick filter plumbing

test('the quick filter reaches getRows even though it is not a grid column', async () => {
  // AG-Grid's setFilterModel silently ignores entries for columns that do not
  // exist, so a `__search__` pseudo-column never arrives in the request and the
  // grid stays unfiltered with no error anywhere. CSRM does not hit this
  // because it filters rows itself.
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  m.setSearch({ __search__: { operator: 'OR', conditions: [
    { filterType: 'text', type: 'contains', filter: 'gov', colId: 'desk' },
  ] } });

  await m.getRows(params({ startRow: 0, endRow: 10, groupKeys: [], rowGroupCols: [], filterModel: {} }));
  const spec = svc.opened.at(-1);
  assert.ok(spec.filter.some((f) => f.op === 'or'), 'the search reached the view spec');
});

test('two different searches do not share a cached view', async () => {
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const req = () => params({ startRow: 0, endRow: 10, groupKeys: [], rowGroupCols: [], filterModel: {} });

  m.setSearch({ __search__: { operator: 'OR', conditions: [{ filterType: 'text', type: 'contains', filter: 'a', colId: 'desk' }] } });
  await m.getRows(req());
  m.setSearch({ __search__: { operator: 'OR', conditions: [{ filterType: 'text', type: 'contains', filter: 'b', colId: 'desk' }] } });
  await m.getRows(req());

  assert.equal(svc.opened.length, 2, 'a different search is a different view');
});

test('clearing the search restores the unfiltered spec', async () => {
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  m.setSearch({ __search__: { operator: 'OR', conditions: [{ filterType: 'text', type: 'contains', filter: 'a', colId: 'desk' }] } });
  await m.getRows(params({ startRow: 0, endRow: 10, groupKeys: [], rowGroupCols: [], filterModel: {} }));
  m.setSearch(null);
  await m.getRows(params({ startRow: 0, endRow: 10, groupKeys: [], rowGroupCols: [], filterModel: {} }));
  assert.equal(svc.opened.at(-1).filter.some((f) => f.op === 'or'), false);
});

test('setting the same search twice does not purge the grid twice', async () => {
  // A purge discards every loaded block; doing it on an unchanged filter is a
  // free full refetch.
  const refreshes = [];
  const m = new SsrmMode({ dataService: fakeService(), artifact, keyColumns: ['positionId'] });
  const api = { refreshServerSide: (o) => refreshes.push(o) };
  const model = { __search__: { operator: 'OR', conditions: [{ filterType: 'text', type: 'contains', filter: 'a', colId: 'desk' }] } };
  m.setSearch(model, api);
  m.setSearch({ ...model }, api);
  assert.equal(refreshes.length, 1);
});

test('the grid filter and the quick filter combine', async () => {
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  m.setSearch({ __search__: { operator: 'OR', conditions: [{ filterType: 'text', type: 'contains', filter: 'gov', colId: 'desk' }] } });
  await m.getRows(params({
    startRow: 0, endRow: 10, groupKeys: [], rowGroupCols: [],
    filterModel: { trader: { filterType: 'set', values: ['Jane Doe'] } },
  }));
  const spec = svc.opened.at(-1);
  assert.ok(spec.filter.some((f) => f.op === 'or'), 'search present');
  assert.ok(spec.filter.some((f) => f.op === 'in'), 'and the column filter too');
});

// ------------------------------------------------- group-aggregate deltas (8e)

test('a groupDelta refreshes only the changed routes, not the whole tree', () => {
  // The Phase 8e win: three desks ticking is ONE root refresh, not a full
  // re-read of every loaded block.
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const refreshes = [];
  const gridApi = { refreshServerSide: (o) => refreshes.push(o) };
  let group = null;
  const control = { on: (t, fn) => { if (t === 'groupDelta') group = fn; return () => {}; } };
  m.attach(control, gridApi, { setTimer: () => ({}) });

  group({ type: 'groupDelta', changed: [
    { path: ['Govies'] }, { path: ['EM Debt'] }, { path: ['HY Credit'] },
  ] });

  assert.equal(refreshes.length, 1, 'sibling changes collapse to one refresh');
  assert.deepEqual(refreshes[0].route, [], 'of their shared parent, the root');
  assert.equal(refreshes[0].purge, false, 'in place, no blank');
});

test('a deep group change refreshes its parent route only', () => {
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const refreshes = [];
  let group = null;
  const control = { on: (t, fn) => { if (t === 'groupDelta') group = fn; return () => {}; } };
  m.attach(control, { refreshServerSide: (o) => refreshes.push(o) }, { setTimer: () => ({}) });

  group({ type: 'groupDelta', changed: [{ path: ['Govies', 'Jane'] }] });
  assert.deepEqual(refreshes.map((r) => r.route), [['Govies']]);
});

test('groupDelta and the coarse rowDelta refresh coexist', () => {
  // Group aggregates get the surgical path; leaf-level changes still fall back
  // to the timed full refresh.
  const svc = fakeService();
  const m = new SsrmMode({ dataService: svc, artifact, keyColumns: ['positionId'] });
  const timers = [];
  const refreshes = [];
  let row = null, group = null;
  const control = { on: (t, fn) => { if (t === 'rowDelta') row = fn; if (t === 'groupDelta') group = fn; return () => {}; } };
  m.attach(control, { refreshServerSide: (o) => refreshes.push(o) }, { setTimer: (fn) => { timers.push(fn); return timers.length; } });

  group({ type: 'groupDelta', changed: [{ path: ['Govies'] }] });
  assert.equal(refreshes.length, 1, 'group delta fired immediately');
  row();                                          // a leaf tick
  assert.equal(timers.length, 1, 'leaf change armed the coarse timer, not an immediate refresh');
});

test('detaching stops both delta subscriptions', () => {
  const m = new SsrmMode({ dataService: fakeService(), artifact, keyColumns: ['positionId'] });
  let rowH = 1, grpH = 1;
  const control = { on: (t) => (t === 'rowDelta' ? () => { rowH = null; } : () => { grpH = null; }) };
  const off = m.attach(control, {}, { setTimer: () => ({}) });
  off();
  assert.equal(rowH, null); assert.equal(grpH, null);
});
