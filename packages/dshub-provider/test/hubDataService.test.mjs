import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HubDataService } from '../src/hubDataService.mjs';
import { CsrmDataService } from '../src/dataService.mjs';

const artifact = {
  keyColumns: ['positionId'],
  columns: [
    { id: 'positionId', column: 'positionId', type: 'string', filter: 'search-select', cardinality: 500000 },
    { id: 'desk', column: 'desk', type: 'string', filter: 'set', cardinality: 8 },
    { id: 'trader', column: 'trader', type: 'string', filter: 'set', cardinality: 6, cascadingValues: true },
    { id: 'notional', column: 'notional', type: 'float', filter: 'number' },
  ],
};

/**
 * Control stub. Scripted entries are PAYLOADS — the stub wraps them in the
 * result envelope, so a test never has to write `{type:'result', payload:...}`
 * and accidentally double-wrap.
 */
function fakeControl(payloads = {}) {
  const c = {
    sent: [],
    request: async (msg, opts) => {
      c.sent.push(msg);
      const p = payloads[msg.type];
      if (typeof p === 'function') return p(msg, opts);
      return { type: 'result', payload: p ?? null };
    },
  };
  return c;
}

const svc = (control, over = {}) => new HubDataService({
  control, ref: { datasourceId: 'positions' }, artifact, softDeleteColumn: '_deleted', ...over,
});

// ------------------------------------------------- the cardinality guard

test('a set filter on a high-cardinality column is REFUSED, not answered', async () => {
  // Past ~10k values AG-Grid ships the whole list to the browser. The artifact
  // already knows this column is search-select; returning 500k values would be
  // technically correct and practically unusable.
  const s = svc(fakeControl());
  await assert.rejects(
    () => s.getDistinctValues('positionId'),
    (e) => /use searchValues/.test(e.message)
  );
});

test('a low-cardinality column is answered normally', async () => {
  const c = fakeControl({ distinctValues: ['Govies', 'Rates'] });
  assert.deepEqual(await svc(c).getDistinctValues('desk'), ['Govies', 'Rates']);
});

// ------------------------------------------------- caching and stampedes

test('repeat opens inside the TTL hit the cache, not the hub', async () => {
  const c = fakeControl({ distinctValues: ['A'] });
  const s = svc(c);
  await s.getDistinctValues('desk');
  await s.getDistinctValues('desk');
  await s.getDistinctValues('desk');
  assert.equal(c.sent.filter((m) => m.type === 'distinctValues').length, 1);
  assert.equal(s.cache.hits, 2);
});

test('concurrent opens share ONE in-flight request', async () => {
  // Several grids opening the same filter at once must not stampede the hub.
  let resolve;
  const c = fakeControl({ distinctValues: () => new Promise((r) => { resolve = r; }) });
  const s = svc(c);

  const a = s.getDistinctValues('desk');
  const b = s.getDistinctValues('desk');
  const d = s.getDistinctValues('desk');
  assert.equal(c.sent.length, 1, 'one request for three callers');

  resolve({ type: 'result', payload: ['X'] });
  assert.deepEqual(await Promise.all([a, b, d]), [['X'], ['X'], ['X']]);
  assert.equal(s.cache.coalesced, 2);
});

test('a failed load does not poison the cache', async () => {
  let attempt = 0;
  const c = fakeControl({ distinctValues: () => { attempt++; return attempt === 1 ? Promise.reject(new Error('down')) : Promise.resolve({ type: 'result', payload: ['A'] }); } });
  const s = svc(c);
  await assert.rejects(() => s.getDistinctValues('desk'));
  assert.deepEqual(await s.getDistinctValues('desk'), ['A'], 'retry succeeds rather than replaying the failure');
});

test('a filter change invalidates OTHER columns, giving cascading values', async () => {
  // The subtle CSRM behaviour SSRM lacks by default (parity study §1.5).
  const c = fakeControl({ distinctValues: ['A'] });
  const s = svc(c);
  await s.getDistinctValues('desk');
  await s.getDistinctValues('trader');
  assert.equal(c.sent.length, 2);

  s.onFilterChanged('desk');
  await s.getDistinctValues('desk');    // unchanged column keeps its cache
  await s.getDistinctValues('trader');  // must re-query
  assert.equal(c.sent.length, 3);
});

// ------------------------------------------------- view lifecycle

test('openView / readWindow / disposeView round-trip', async () => {
  const c = fakeControl({
    openView: { viewId: 'v1' },
    readWindow: { columns: { positionId: ['P1', 'P2'], notional: [1, 2] }, rowCount: 20000 },
    disposeView: { disposed: true },
  });
  const s = svc(c);

  const h = await s.openView({ groupBy: ['desk'] });
  assert.equal(h.viewId, 'v1');

  const { rows, rowCount } = await s.readWindow(h, { startRow: 0, endRow: 2 });
  assert.equal(rowCount, 20000, 'the grid needs this to size its scrollbar');
  assert.deepEqual(rows, [{ positionId: 'P1', notional: 1 }, { positionId: 'P2', notional: 2 }]);

  await s.disposeView(h);
  assert.ok(c.sent.some((m) => m.type === 'disposeView' && m.viewId === 'v1'));
});

// ------------------------------------------------- streaming

test('scanAll streams batches rather than buffering the whole result', async () => {
  const c = fakeControl({
    scan: (msg, opts) => {
      opts.onPartial({ block: { positionId: ['P1', 'P2'] } });
      opts.onPartial({ block: { positionId: ['P3'] } });
      return { type: 'result', payload: { rows: 3 } };
    },
  });
  const seen = [];
  await svc(c).scanAll({}, (batch) => seen.push(batch.length));
  assert.deepEqual(seen, [2, 1]);
});

test('exportAll produces CSV with hidden columns dropped', async () => {
  const c = fakeControl({
    scan: (msg, opts) => { opts.onPartial({ block: { positionId: ['P1'], desk: ['Govies'], trader: ['S'], notional: [1] } }); return { type: 'result', payload: {} }; },
  });
  const out = await svc(c).exportAll('csv', {});
  const text = typeof out === 'string' ? out : await out.text();
  assert.ok(text.startsWith('positionId,desk,trader,notional'));
  assert.ok(text.includes('P1,Govies,S,1'));
});

// ------------------------------------------------- selection

test('selection stays a predicate — resolving to keys would drop unloaded rows', async () => {
  const out = await svc(fakeControl()).resolveSelection({ selectAll: true, toggledNodes: ['P1'] }, {});
  assert.equal(out.selectAll, true);
  assert.deepEqual(out.toggledNodes, ['P1']);
  assert.equal(out.resolvedServerSide, true);
  assert.ok(!('keys' in out), 'a key list cannot represent rows that were never loaded');
});

// ------------------------------------------------- the parity contract

test('both implementations satisfy the SAME eleven-method contract', () => {
  // The whole point of the parity layer: blotter code never branches on mode.
  const hub = svc(fakeControl());
  const csrm = new CsrmDataService({ getRows: () => [], artifact, keyColumns: ['positionId'] });

  for (const m of [
    'getDistinctValues', 'searchValues', 'getRowCount', 'getAggregates', 'search',
    'exportAll', 'copyAll', 'scanAll', 'snapshotForChart', 'rankOf', 'resolveSelection',
  ]) {
    assert.equal(typeof hub[m], 'function', `HubDataService is missing ${m}`);
    assert.equal(typeof csrm[m], 'function', `CsrmDataService is missing ${m}`);
  }
  assert.equal(csrm.mode, 'csrm');
  assert.equal(hub.mode, 'ssrm');
});

test('search returns the same FilterModel shape in both modes', () => {
  const hub = svc(fakeControl(), { searchColumns: ['desk'] });
  const csrm = new CsrmDataService({ getRows: () => [], artifact, keyColumns: ['positionId'], searchColumns: ['desk'] });
  assert.deepEqual(hub.search('abc'), csrm.search('abc'));
});

test('expandRow reaches the hub and returns the new row count', async () => {
  // The VRM mechanism. Expanding changes the length of the flat list the
  // viewport indexes into, so the count must come back with it.
  const c = fakeControl({ openView: { viewId: 'v1' }, expandRow: { rowCount: 120 } });
  const s = svc(c);
  const h = await s.openView({ groupBy: ['desk'] });
  const out = await s.expandRow(h, 3, false);

  assert.equal(out.rowCount, 120);
  const sent = c.sent.find((m) => m.type === 'expandRow');
  assert.deepEqual(
    { viewId: sent.viewId, index: sent.index, collapse: sent.collapse },
    { viewId: 'v1', index: 3, collapse: false }
  );
});

test('collapse is passed through explicitly, not inferred', async () => {
  const c = fakeControl({ openView: { viewId: 'v1' }, expandRow: { rowCount: 9 } });
  const s = svc(c);
  const h = await s.openView({});
  await s.expandRow(h, 1, true);
  assert.equal(c.sent.find((m) => m.type === 'expandRow').collapse, true);
});

// ------------------------------------------------- one filter translator

import { toFilterOps } from '../src/hubDataService.mjs';
import { filterModelToOps } from '../src/modes/ssrm.mjs';

test('a combined AND filter is TRANSLATED, not silently dropped', () => {
  // This returned [] — no filter. The grid rows were filtered correctly while
  // the row count, aggregates, export and copy-all reported over the whole
  // dataset. A trader exporting "my filtered view" got everything.
  const ops = toFilterOps({
    desk: {
      filterType: 'text', operator: 'AND',
      conditions: [
        { filterType: 'text', type: 'startsWith', filter: 'G' },
        { filterType: 'text', type: 'endsWith', filter: 's' },
      ],
    },
  });
  assert.equal(ops.length, 2);
  assert.deepEqual(ops.map((o) => o.op), ['startsWith', 'endsWith']);
});

test('an OR is translated, not refused', () => {
  // It used to throw, because Perspective's filter array has no OR. It now
  // becomes one `or` node that the view translation turns into a computed
  // boolean column — so an ordinary two-condition filter works.
  const ops = toFilterOps({ desk: { filterType: 'text', operator: 'OR', conditions: [
    { filterType: 'text', type: 'equals', filter: 'A' },
    { filterType: 'text', type: 'equals', filter: 'B' },
  ] } });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'or');
  assert.equal(ops[0].conditions.length, 2);
});

test('a genuinely untranslatable filter still THROWS rather than returning no filter', () => {
  // The invariant that matters is unchanged: loudly unsupported is recoverable,
  // quietly wrong about a book is not.
  assert.throws(
    () => toFilterOps({ desk: { filterType: 'text', type: 'vibesLike', filter: 'A' } }),
    (e) => e.code === 'unsupported-expression',
  );
});

test('quick search is translated on the COUNT path too', () => {
  // The count/aggregate/export path and the rows path are different callers.
  // Special-casing __search__ in only one of them is what made the grid and the
  // status bar disagree before.
  const ops = toFilterOps({ __search__: {
    filterType: 'multi', operator: 'OR', columns: ['desk', 'trader'],
    conditions: [
      { filterType: 'text', type: 'contains', filter: 'gov', colId: 'desk' },
      { filterType: 'text', type: 'contains', filter: 'gov', colId: 'trader' },
    ],
  } });
  assert.equal(ops[0].op, 'or');
  assert.deepEqual(ops[0].conditions.map((c) => c.column), ['desk', 'trader']);
});

test('text equality is translated case-insensitively, matching CSRM', () => {
  const ops = toFilterOps({ desk: { filterType: 'text', type: 'equals', filter: 'Govies' } });
  assert.deepEqual(ops, [{ column: 'desk', op: 'equalsIgnoreCase', value: 'Govies' }]);
});

test('the count path and the rows path translate a filter identically', () => {
  // The two used to be separate implementations. Comparing them against each
  // other is what keeps them from drifting again.
  const model = {
    desk: { filterType: 'text', type: 'equals', filter: 'Govies' },
    dv01: { filterType: 'number', type: 'greaterThan', filter: 10 },
  };
  const viaCount = toFilterOps(model);
  const viaRows = Object.entries(model).flatMap(([c, m]) => filterModelToOps(c, m));
  assert.deepEqual(viaCount, viaRows);
});
