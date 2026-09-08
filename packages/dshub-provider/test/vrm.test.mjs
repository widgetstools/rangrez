import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VrmMode } from '../src/modes/vrm.mjs';

const artifact = { keyColumns: ['positionId'], columns: [] };

/** Tree service: one view, expand/collapse changes the row count. */
function fakeService({ rows = 100 } = {}) {
  const s = {
    opened: 0, disposed: 0, reads: [], expands: [],
    rowCount: rows,
    openView: async (spec) => { s.opened++; s.spec = spec; return { viewId: 'v1' }; },
    disposeView: async () => { s.disposed++; },
    readWindow: async (_h, { startRow, endRow }) => {
      s.reads.push([startRow, endRow]);
      const out = [];
      for (let i = startRow; i < Math.min(endRow, s.rowCount); i++) {
        out.push({ __ROW_PATH__: i === 0 ? [] : [`G${i}`], v: i });
      }
      return { rows: out, rowCount: s.rowCount };
    },
    expandRow: async (_h, index, collapse) => {
      s.expands.push([index, collapse]);
      s.rowCount += collapse ? -10 : 10;
      return { rowCount: s.rowCount };
    },
  };
  return s;
}

/** IViewportDatasourceParams stand-in. */
function fakeParams() {
  const p = { rowCounts: [], blocks: [] };
  p.setRowCount = (n, keep) => p.rowCounts.push([n, keep]);
  p.setRowData = (block) => p.blocks.push(block);
  p.getRow = () => null;
  return p;
}

async function harness(over = {}) {
  const svc = fakeService(over.service ?? {});
  const params = fakeParams();
  const m = new VrmMode({
    dataService: svc, artifact,
    viewSpec: { groupBy: ['desk'], aggregates: { notional: 'sum' }, depth: 1 },
    bufferRows: 5, ...over,
  });
  const ds = m.datasource();
  ds.init(params);
  await new Promise((r) => setTimeout(r, 0));   // let start() settle
  return { svc, params, m, ds };
}

// ------------------------------------------------- the core claim

test('VRM opens exactly ONE view for the whole tree', async () => {
  // This is the entire argument against SSRM, which opens one per expanded
  // node. A grouped view costs ~300ms to create and 3.3x on ingest throughput.
  const { svc, m } = await harness();
  await m.setViewportRange(0, 20);
  await m.setViewportRange(20, 40);
  await m.toggle(1);
  await m.setViewportRange(40, 60);

  assert.equal(svc.opened, 1, 'one view, however much the user scrolls or expands');
});

test('expanding mutates that one view in place', async () => {
  const { svc, m } = await harness();
  await m.toggle(3);
  assert.deepEqual(svc.expands, [[3, false]], 'expand by ROW INDEX');
  assert.equal(svc.opened, 1, 'no new view for the expansion');
});

// ------------------------------------------------- viewport mechanics

test('rows are delivered by ABSOLUTE INDEX, not as an array', async () => {
  const { params, m } = await harness();
  await m.setViewportRange(30, 40);
  const block = params.blocks.at(-1);
  assert.ok(!Array.isArray(block), 'setRowData takes an index map');
  assert.ok(block[30], 'keyed by absolute row index');
  assert.equal(block[30].__index, 30);
});

test('a buffer either side avoids a round trip on every small scroll', async () => {
  const { svc, m } = await harness();
  svc.reads.length = 0;
  await m.setViewportRange(50, 60);
  const [start, end] = svc.reads.at(-1);
  assert.ok(start < 50 && end > 61, `buffered: read ${start}-${end} for viewport 50-60`);
});

test('the buffer is clamped to the real bounds', async () => {
  const { svc, m } = await harness();
  svc.reads.length = 0;
  await m.setViewportRange(0, 5);
  const [start] = svc.reads.at(-1);
  assert.equal(start, 0, 'never negative');
});

// ------------------------------------------------- row count correctness

test('expanding updates the row count BEFORE refilling', async () => {
  // Leaving it stale lets the grid scroll into indices that no longer exist.
  const { params, m } = await harness();
  const before = params.rowCounts.length;
  await m.toggle(2);
  assert.ok(params.rowCounts.length > before);
  assert.equal(params.rowCounts.at(-1)[0], 110, 'grew by the expansion');
});

test('collapsing shrinks the count again', async () => {
  // Direction is taken from the row, so the caller passes what it rendered —
  // which is exactly what the tree cell renderer does on click.
  const { params, m } = await harness();
  await m.toggle(2, { __expanded: false });   // expand
  assert.equal(params.rowCounts.at(-1)[0], 110);
  await m.toggle(2, { __expanded: true });    // collapse
  assert.equal(params.rowCounts.at(-1)[0], 100);
});

test('no cached row ever disagrees with its own index after a toggle', async () => {
  // Every index below a toggle shifts. The invariant that matters is that the
  // cache never holds a row under a key that is no longer its position.
  const { m } = await harness();
  await m.setViewportRange(0, 20);
  await m.toggle(2, { __expanded: false });
  await m.setViewportRange(0, 20);

  for (const [key, row] of m.rowsByIndex) {
    assert.equal(row.__index, key, `cached row at ${key} claims index ${row.__index}`);
  }
});

test('toggle direction comes from the ROW, not from remembered state', async () => {
  // Perspective's tree arrives fully expanded, so a Set that starts empty
  // disagrees with reality and the first click expands an expanded node.
  const { svc, m } = await harness();
  const out = await m.toggle(1, { __expanded: true });
  assert.equal(out.collapsed, true);
  assert.deepEqual(svc.expands.at(-1), [1, true], 'collapse, because the row was expanded');

  const out2 = await m.toggle(1, { __expanded: false });
  assert.equal(out2.collapsed, false);
  assert.deepEqual(svc.expands.at(-1), [1, false]);
});

test('__expanded is derived from whether the NEXT row is deeper', async () => {
  const svc = fakeService();
  svc.readWindow = async () => ({
    rows: [
      { __ROW_PATH__: [] },                    // root, next is deeper -> expanded
      { __ROW_PATH__: ['A'] },                 // next is same depth -> collapsed
      { __ROW_PATH__: ['B'] },
      { __ROW_PATH__: ['B', 'x'] },
    ],
    rowCount: 4,
  });
  const params = fakeParams();
  const m = new VrmMode({ dataService: svc, artifact, viewSpec: { groupBy: ['desk', 'trader'] }, bufferRows: 0 });
  m.datasource().init(params);
  await new Promise((r) => setTimeout(r, 0));
  await m.setViewportRange(0, 4);

  const block = params.blocks.at(-1);
  assert.equal(block[0].__expanded, true, 'root, followed by a deeper row');
  assert.equal(block[1].__expanded, false, 'followed by a sibling');
  assert.equal(block[2].__expanded, true, 'followed by its child');
});

// ------------------------------------------------- tree shape

test('expandable rows are those ABOVE the deepest group level', async () => {
  // A path is expandable while it is SHORTER than the number of group levels.
  // With groupBy:['desk'] the root ([]) can be expanded to reveal the desks,
  // and a desk (['Govies']) is already the deepest level — there is nothing
  // below it in this tree, so it renders without a caret.
  const { params, m } = await harness();
  await m.setViewportRange(0, 10);
  const block = params.blocks.at(-1);
  assert.equal(block[0].__isLeaf, false, 'the root is expandable');
  assert.equal(block[1].__isLeaf, true, 'a desk is the deepest level with one group column');
});

test('a second group level makes the first level expandable', async () => {
  const { params, m } = await harness({
    viewSpec: { groupBy: ['desk', 'trader'], aggregates: {}, depth: 1 },
  });
  await m.setViewportRange(0, 10);
  const block = params.blocks.at(-1);
  assert.equal(block[1].__isLeaf, false, 'a desk now has traders beneath it');
});

// ------------------------------------------------- live updates

test('an upstream change refreshes ONLY the visible window', async () => {
  // The point of VRM: the server knows what is on screen, so it pushes only
  // that rather than invalidating whole blocks.
  const { svc, m } = await harness();
  await m.setViewportRange(40, 50);
  svc.reads.length = 0;

  await m.refreshViewport();
  const ranges = svc.reads.filter(([s, e]) => e - s > 1);
  assert.equal(ranges.length, 1, 'one window read');
  const [start, end] = ranges[0];
  assert.ok(start <= 40 && end >= 51, 'covers the viewport, not the whole table');
  assert.ok(end - start < 100, 'and not the whole table');
});

test('a row-count change from upstream keeps rendered rows', async () => {
  const { svc, params, m } = await harness();
  await m.setViewportRange(0, 10);
  svc.rowCount = 150;
  await m.refreshViewport();
  const [count, keep] = params.rowCounts.at(-1);
  assert.equal(count, 150);
  assert.equal(keep, true, 'keepRenderedRows — otherwise the grid blinks on every tick');
});

// ------------------------------------------------- lifecycle

test('destroy disposes the view', async () => {
  const { svc, ds } = await harness();
  await ds.destroy();
  assert.equal(svc.disposed, 1);
});

test('the datasource satisfies the IViewportDatasource contract', async () => {
  const { ds } = await harness();
  assert.equal(typeof ds.init, 'function');
  assert.equal(typeof ds.setViewportRange, 'function');
  assert.equal(typeof ds.destroy, 'function');
});

// ------------------------------------------------- live updates, coalesced

test('many deltas coalesce into ONE window read', async () => {
  // At ~2,000 rows/sec a refresh per delta would issue thousands of reads a
  // second and starve the engine. One per interval shows the same picture.
  const timers = [];
  const { svc, m } = await harness({ setTimer: (fn) => { timers.push(fn); return timers.length; }, refreshMs: 100 });
  await m.setViewportRange(0, 40);
  svc.reads.length = 0;

  for (let i = 0; i < 500; i++) m.onUpstreamChange();
  assert.equal(timers.length, 1, 'one timer armed for 500 deltas');

  await timers[0]();
  const windows = svc.reads.filter(([s, e]) => e - s > 1);
  assert.equal(windows.length, 1, 'one window read, not 500');
});

test('a refresh reads the VIEWPORT, never the whole table', async () => {
  const timers = [];
  const { svc, m } = await harness({ setTimer: (fn) => { timers.push(fn); return timers.length; } });
  await m.setViewportRange(40, 60);
  svc.reads.length = 0;

  m.onUpstreamChange();
  await timers[0]();
  const [start, end] = svc.reads.filter(([s, e]) => e - s > 1)[0];
  assert.ok(start <= 40 && end >= 61, 'covers the viewport');
  assert.ok(end - start <= 40 + 2 * m.bufferRows + 1, `and little else: ${start}-${end}`);
});

test('a later delta after a refresh arms a fresh timer', async () => {
  const timers = [];
  const { m } = await harness({ setTimer: (fn) => { timers.push(fn); return timers.length; } });
  m.onUpstreamChange();
  await timers[0]();
  m.onUpstreamChange();
  assert.equal(timers.length, 2, 'coalescing must not latch off permanently');
});

test('attach subscribes to rowDelta and detach stops it', async () => {
  const { m } = await harness();
  let handler = null;
  const control = { on: (type, fn) => { if (type === 'rowDelta') handler = fn; return () => { handler = null; }; } };
  const off = m.attach(control);
  assert.equal(typeof handler, 'function');
  off();
  assert.equal(handler, null, 'a live subscription after teardown is a leak');
});
