import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CsrmMode } from '../src/modes/csrm.mjs';
const SEP = String.fromCharCode(1); // composite key separator
import { toPerspectiveFilter, toPerspectiveViewConfig, pivotToRows } from '../src/engine.mjs';

const artifact = { keyColumns: ['positionId'], columns: [] };

/** Records what the grid was asked to do. */
function fakeGrid() {
  const g = { rowData: null, transactions: [], options: {} };
  g.setGridOption = (k, v) => { g.options[k] = v; if (k === 'rowData') g.rowData = v; };
  g.applyTransactionAsync = (tx, cb) => { g.transactions.push(tx); cb?.(); };
  return g;
}

/** Engine stub: hands back a window, lets the test push deltas. */
function fakeEngine(initialColumns) {
  let cb = null;
  return {
    createView: async () => ({ id: 'v1' }),
    readWindow: async () => initialColumns,
    onUpdate: (_v, fn) => { cb = fn; return () => { cb = null; }; },
    dispose: async () => {},
    push: (delta) => cb?.(delta),
    get subscribed() { return cb !== null; },
  };
}

const cols = (rows) => {
  const names = [...new Set(rows.flatMap(Object.keys))];
  const out = {};
  for (const n of names) out[n] = rows.map((r) => r[n] ?? null);
  return out;
};

function harness(initial = [{ positionId: 'P1', px: 99.5, _deleted: false }]) {
  const grid = fakeGrid();
  const engine = fakeEngine(cols(initial));
  const latencies = [];
  const mode = new CsrmMode({
    engine, gridApi: grid, artifact, keyColumns: ['positionId'],
    softDeleteColumn: '_deleted', onLatency: (n) => latencies.push(n),
  });
  return { grid, engine, mode, latencies };
}

// ------------------------------------------------- row identity

test('getRowId prefers the hub key, so it is byte-identical to the hub encoding', () => {
  const { mode } = harness();
  assert.equal(mode.getRowId({ data: { __key: 'P1', positionId: 'P1' } }), 'P1');
});

test('a composite key joins on \\u0001, which cannot appear in data', () => {
  const grid = fakeGrid();
  const m = new CsrmMode({ engine: fakeEngine({}), gridApi: grid, artifact, keyColumns: ['book', 'positionId'] });
  assert.equal(m.getRowId({ data: { book: 'CMBS', positionId: 'P-1' } }), `CMBS${SEP}P-1`);
});

// ------------------------------------------------- initial load

test('the first window becomes rowData', async () => {
  const { grid, mode } = harness([
    { positionId: 'P1', px: 99.5, _deleted: false },
    { positionId: 'P2', px: 100.0, _deleted: false },
  ]);
  const n = await mode.start({}, {});
  assert.equal(n, 2);
  assert.equal(grid.rowData.length, 2);
  assert.equal(mode.rowCount(), 2);
});

test('rows already soft-deleted are excluded from the first window', async () => {
  const { grid, mode } = harness([
    { positionId: 'P1', px: 99.5, _deleted: false },
    { positionId: 'P2', px: 100.0, _deleted: true },
  ]);
  await mode.start({}, {});
  assert.equal(grid.rowData.length, 1, 'a deleted row must not load');
  assert.equal(grid.rowData[0].positionId, 'P1');
});

// ------------------------------------------------- deltas

test('an unseen key is an add; a known key is an update', async () => {
  const { grid, engine, mode } = harness();
  await mode.start({}, {});
  engine.push(cols([{ positionId: 'P2', px: 101, _deleted: false }]));
  engine.push(cols([{ positionId: 'P1', px: 98, _deleted: false }]));

  assert.deepEqual(grid.transactions[0].add.map((r) => r.positionId), ['P2']);
  assert.deepEqual(grid.transactions[1].update.map((r) => r.positionId), ['P1']);
});

test('a partial delta MERGES onto the held row rather than replacing it', async () => {
  // Deltas carry only what changed. Replacing wholesale wipes every field the
  // delta omitted — a silent blanking that shows as empty cells.
  const { grid, engine, mode } = harness([{ positionId: 'P1', px: 99.5, dv01: 42, _deleted: false }]);
  await mode.start({}, {});
  engine.push(cols([{ positionId: 'P1', px: 100.25 }]));

  const updated = grid.transactions[0].update[0];
  assert.equal(updated.px, 100.25, 'new value applied');
  assert.equal(updated.dv01, 42, 'untouched field survives');
});

test('a soft-delete flag flip becomes a REMOVE transaction', async () => {
  // Perspective's on_update never surfaces a removal (architecture §8.4), so
  // this flip is the only signal that a row is gone.
  const { grid, engine, mode } = harness();
  await mode.start({}, {});
  engine.push(cols([{ positionId: 'P1', _deleted: true }]));

  assert.ok(grid.transactions[0].remove, 'must produce a remove');
  assert.equal(grid.transactions[0].remove[0].positionId, 'P1');
  assert.equal(mode.rowCount(), 0);
  assert.equal(mode.removed, 1);
});

test('deleting a row that was never loaded is a no-op, not a phantom remove', async () => {
  const { grid, engine, mode } = harness();
  await mode.start({}, {});
  engine.push(cols([{ positionId: 'P-unknown', _deleted: true }]));
  assert.equal(grid.transactions.length, 0);
});

test('a re-added row after deletion comes back as an add', async () => {
  const { grid, engine, mode } = harness();
  await mode.start({}, {});
  engine.push(cols([{ positionId: 'P1', _deleted: true }]));
  engine.push(cols([{ positionId: 'P1', px: 97, _deleted: false }]));
  assert.ok(grid.transactions[1].add, 'resurrection is an add, not an update');
  assert.equal(mode.rowCount(), 1);
});

test('one delta with a mix produces a single transaction', async () => {
  // Splitting into three transactions triples the grid's work for no benefit.
  const { grid, engine, mode } = harness([
    { positionId: 'P1', px: 1, _deleted: false },
    { positionId: 'P2', px: 2, _deleted: false },
  ]);
  await mode.start({}, {});
  engine.push(cols([
    { positionId: 'P1', px: 9, _deleted: false },   // update
    { positionId: 'P2', _deleted: true },            // remove
    { positionId: 'P3', px: 3, _deleted: false },    // add
  ]));

  assert.equal(grid.transactions.length, 1);
  const tx = grid.transactions[0];
  assert.equal(tx.update.length, 1);
  assert.equal(tx.remove.length, 1);
  assert.equal(tx.add.length, 1);
});

test('an empty delta produces no transaction at all', async () => {
  const { grid, engine, mode } = harness();
  await mode.start({}, {});
  engine.push(cols([]));
  engine.push({});
  assert.equal(grid.transactions.length, 0);
});

test('latency is measured from delta to applied', async () => {
  const { engine, mode, latencies } = harness();
  await mode.start({}, {});
  engine.push(cols([{ positionId: 'P2', px: 1, _deleted: false }]));
  assert.equal(latencies.length, 1);
  assert.ok(latencies[0] >= 0);
});

test('stop unsubscribes and disposes the view', async () => {
  const { engine, mode } = harness();
  await mode.start({}, {});
  assert.ok(engine.subscribed);
  await mode.stop();
  assert.ok(!engine.subscribed, 'a live subscription after stop is a leak');
});

// ------------------------------------------------- the seam

test('our filter shape translates to Perspective triples', () => {
  assert.deepEqual(
    toPerspectiveFilter([{ column: 'desk', op: 'equals', value: 'Govies' }]),
    [['desk', '==', 'Govies']]
  );
  assert.deepEqual(
    toPerspectiveFilter([{ column: 'px', op: 'blank' }]),
    [['px', 'is null']]
  );
});

test('inRange decomposes into two bounds, since Perspective has no range op', () => {
  assert.deepEqual(
    toPerspectiveFilter([{ column: 'px', op: 'inRange', value: 1, valueTo: 5 }]),
    [['px', '>=', 1], ['px', '<=', 5]]
  );
});

test('an untranslatable operation fails loudly rather than silently dropping', () => {
  // A dropped filter clause shows a trader MORE rows than they asked for.
  assert.throws(() => toPerspectiveFilter([{ column: 'x', op: 'regex', value: '.*' }]), /no Perspective equivalent/);
});

test('a ViewSpec maps onto Perspective view config', () => {
  const cfg = toPerspectiveViewConfig({
    groupBy: ['desk'], aggregates: { notional: 'sum' },
    sort: [{ column: 'px', dir: 'desc' }],
    filter: [{ column: 'desk', op: 'equals', value: 'Rates' }],
  });
  assert.deepEqual(cfg.group_by, ['desk']);
  assert.deepEqual(cfg.sort, [['px', 'desc']]);
  assert.deepEqual(cfg.filter, [['desk', '==', 'Rates']]);
});

test('an empty ViewSpec produces an empty config, not undefined keys', () => {
  assert.deepEqual(toPerspectiveViewConfig({}), {});
});

test('pivotToRows inverts a columnar block', () => {
  assert.deepEqual(
    pivotToRows({ a: [1, 2], b: ['x', 'y'] }),
    [{ a: 1, b: 'x' }, { a: 2, b: 'y' }]
  );
  assert.deepEqual(pivotToRows({}), []);
});

test('reading before the snapshot completes yields an empty grid, not an error', async () => {
  // The failure mode that makes this worth guarding: an empty table scans
  // cleanly and the blotter comes up blank with everything looking healthy.
  // The provider must gate its first read on `state: live`.
  const { grid, mode } = harness([]);
  const n = await mode.start({}, {});
  assert.equal(n, 0);
  assert.deepEqual(grid.rowData, [], 'silently empty — no error to notice');
});

test('depth is NOT passed to Perspective as a config field', () => {
  // It is exposed as the set_depth() method; passing it through the view config
  // fails with "unknown field". The caller applies it after creation.
  const cfg = toPerspectiveViewConfig({ groupBy: ['desk'], depth: 1 });
  assert.deepEqual(cfg.group_by, ['desk']);
  assert.ok(!('depth' in cfg), 'depth must not reach the view config');
});

// ------------------------------------------------- the snapshot/subscribe race

test('updates arriving DURING the snapshot read are not lost', async () => {
  // `on_update` only delivers what happens after registration. Registering
  // after the read drops every tick that lands while the window is being read
  // and pivoted — at 2,000 rows/sec over a 20k-row pivot, hundreds of rows left
  // showing stale values until they happen to tick again.
  const grid = fakeGrid();
  let cb = null;
  let releaseRead;
  const readGate = new Promise((r) => { releaseRead = r; });

  const engine = {
    createView: async () => ({ id: 'v1' }),
    readWindow: async () => {
      // The delta lands mid-read, which is exactly when it is lost.
      cb?.({ positionId: ['P1'], px: [101.5], _deleted: [false] });
      await readGate;
      return cols([{ positionId: 'P1', px: 99.5, _deleted: false }]);
    },
    onUpdate: (_v, fn) => { cb = fn; return () => { cb = null; }; },
    dispose: async () => {},
  };

  const m = new CsrmMode({ engine, gridApi: grid, artifact, keyColumns: ['positionId'], softDeleteColumn: '_deleted' });
  const started = m.start({});
  releaseRead();
  await started;

  assert.equal(m.bufferedAtStart, 1, 'the mid-read delta was captured, not dropped');
  assert.equal(m.rows.get('P1').px, 101.5, 'and the grid holds the newer price');
});

test('a delta that predates the snapshot is harmless when replayed', async () => {
  // At-least-once is the right bias: re-applying a value the snapshot already
  // has is a no-op, whereas at-most-once loses ticks.
  const grid = fakeGrid();
  let cb = null;
  const engine = {
    createView: async () => ({ id: 'v1' }),
    readWindow: async () => {
      cb?.({ positionId: ['P1'], px: [99.5], _deleted: [false] });   // same value
      return cols([{ positionId: 'P1', px: 99.5, _deleted: false }]);
    },
    onUpdate: (_v, fn) => { cb = fn; return () => { cb = null; }; },
    dispose: async () => {},
  };
  const m = new CsrmMode({ engine, gridApi: grid, artifact, keyColumns: ['positionId'], softDeleteColumn: '_deleted' });
  await m.start({});
  assert.equal(m.rows.size, 1, 'no phantom duplicate row');
  assert.equal(m.rows.get('P1').px, 99.5);
});

test('a buffered delta for a NEW row becomes an add, not an update', async () => {
  const grid = fakeGrid();
  let cb = null;
  const engine = {
    createView: async () => ({ id: 'v1' }),
    readWindow: async () => {
      cb?.({ positionId: ['P2'], px: [50], _deleted: [false] });
      return cols([{ positionId: 'P1', px: 99.5, _deleted: false }]);
    },
    onUpdate: (_v, fn) => { cb = fn; return () => { cb = null; }; },
    dispose: async () => {},
  };
  const m = new CsrmMode({ engine, gridApi: grid, artifact, keyColumns: ['positionId'], softDeleteColumn: '_deleted' });
  await m.start({});
  assert.deepEqual(grid.transactions.at(-1).add?.map((r) => r.positionId), ['P2']);
});

test('a failed snapshot read leaves no subscription behind', async () => {
  const grid = fakeGrid();
  let cb = null;
  const engine = {
    createView: async () => ({ id: 'v1' }),
    readWindow: async () => { throw new Error('table went away'); },
    onUpdate: (_v, fn) => { cb = fn; return () => { cb = null; }; },
    dispose: async () => {},
  };
  const m = new CsrmMode({ engine, gridApi: grid, artifact, keyColumns: ['positionId'] });
  await assert.rejects(() => m.start({}), /table went away/);
  assert.equal(cb, null, 'a live subscription after a failed start is a leak');
});

// ------------------------------------------------- restart correctness

test('stop() clears the mirror, so a restart re-adds rather than updates', async () => {
  // The mirror decides add-vs-update. Carried into a restart it claims rows the
  // grid no longer holds are known, so they go out as updates — and an update
  // against a node that does not exist is a silent no-op. The rows never appear.
  const { mode, grid } = harness([{ positionId: 'P1', px: 1, _deleted: false }]);
  await mode.start({});
  await mode.stop();
  assert.equal(mode.rows.size, 0, 'mirror dropped');

  await mode.start({});
  assert.equal(grid.rowData.length, 1, 'and the restart genuinely repopulates');
  assert.equal(mode.rows.get('P1').px, 1);
});

// ------------------------------------------------- key misconfiguration

test('duplicate row ids in the snapshot are counted, not swallowed', async () => {
  // keyColumns naming a non-unique column collapses the dataset. AG-Grid
  // surfaces it as an opaque duplicate-node error much later, if at all.
  const { mode } = harness([
    { positionId: 'P1', desk: 'Govies', px: 1 },
    { positionId: 'P2', desk: 'Govies', px: 2 },
  ]);
  mode.keyColumns = ['desk'];
  await mode.start({});
  assert.equal(mode.duplicateKeys, 1, 'the collision is reported');
});

// ------------------------------------------------- backpressure acks

test('the ack reports rows actually IN the grid, not merely received', async () => {
  // applyTransactionAsync batches across frames. Acking on receipt would report
  // progress the grid has not made — exactly the lie the hub's ladder exists to
  // detect.
  const grid = fakeGrid();
  const applyQueue = [];
  grid.applyTransactionAsync = (tx, cb) => { grid.transactions.push(tx); applyQueue.push(cb); };

  const engine = fakeEngine(cols([{ positionId: 'P1', px: 1 }]));
  const acked = [];
  const m = new CsrmMode({
    engine, gridApi: grid, artifact, keyColumns: ['positionId'],
    onApplied: (seq) => acked.push(seq),
  });
  await m.start({});

  engine.push({ ...cols([{ positionId: 'P1', px: 2 }]), seq: 7 });
  assert.deepEqual(acked, [], 'not acked while the transaction is still queued');

  applyQueue.forEach((cb) => cb());
  assert.deepEqual(acked, [7], 'acked once the grid applied it');
});

test('a delta with no seq is applied without acking', async () => {
  // `notify`-mode and legacy deltas carry no sequence; acking a fabricated one
  // would let a wedged tab claim progress it never made.
  const { mode, engine, grid } = harness();
  await mode.start({});
  const acked = [];
  mode.onApplied = (s) => acked.push(s);
  engine.push(cols([{ positionId: 'P1', px: 3 }]));
  assert.deepEqual(acked, []);
  assert.ok(grid.transactions.length > 0, 'but the row still landed');
});
