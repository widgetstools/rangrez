import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CsrmDataService } from '../src/dataService.mjs';
import { rowPredicate, comparator, sortRows, isBlank } from '../src/filter.mjs';

const artifact = {
  id: 'positions', version: 1, keyColumns: ['positionId'],
  columns: [
    { id: 'positionId', column: 'positionId', type: 'string', filter: 'search-select' },
    { id: 'desk', column: 'desk', type: 'string', filter: 'set' },
    { id: 'trader', column: 'trader', type: 'string', filter: 'set' },
    { id: 'notional', column: 'notional', type: 'float', filter: 'number' },
    { id: 'dv01', column: 'dv01', type: 'float', filter: 'number' },
    { id: 'px', column: 'px', type: 'float', filter: 'number' },
    { id: 'internal', column: 'internal', type: 'string', filter: 'text', colDef: { hide: true } },
  ],
};

const DATA = [
  { positionId: 'P1', desk: 'Govies',  trader: 'Sarah', notional: 100, dv01: 10, px: 99.5,  _deleted: false, internal: 'x' },
  { positionId: 'P2', desk: 'Govies',  trader: 'Mike',  notional: 200, dv01: 20, px: 100.25, _deleted: false, internal: 'x' },
  { positionId: 'P3', desk: 'Rates',   trader: 'Sarah', notional: 300, dv01: 30, px: 98.0,  _deleted: false, internal: 'x' },
  { positionId: 'P4', desk: 'Rates',   trader: null,    notional: null, dv01: 40, px: 101.0, _deleted: false, internal: 'x' },
  { positionId: 'P5', desk: '',        trader: 'Mike',  notional: 500, dv01: 50, px: 97.5,  _deleted: false, internal: 'x' },
  { positionId: 'P6', desk: 'Govies',  trader: 'Tom',   notional: 600, dv01: 60, px: 96.0,  _deleted: true,  internal: 'x' },
];

const svc = (rows = DATA) => new CsrmDataService({
  getRows: () => rows, artifact, keyColumns: ['positionId'],
  softDeleteColumn: '_deleted', searchColumns: ['desk', 'trader'],
});

// ------------------------------------------------- soft delete

test('soft-deleted rows are excluded from every answer', async () => {
  // The row is still in the Perspective table — the flag is how a removal
  // reaches the client at all (architecture §8.4) — but it is not data.
  const s = svc();
  assert.equal(await s.getRowCount(), 5, 'P6 is deleted');
  assert.ok(!(await s.getDistinctValues('trader')).includes('Tom'));
});

// ------------------------------------------------- the divergence-prone rules

test('an EMPTY set filter matches nothing, not everything', async () => {
  // AG-Grid means "the user deselected every value". Returning all rows shows a
  // trader the opposite of what they asked for.
  const s = svc();
  assert.equal(await s.getRowCount({ desk: { filterType: 'set', values: [] } }), 0);
});

test('a set filter matches blanks via null, covering both null and empty string', async () => {
  const s = svc();
  // P4 has trader null; P5 has desk ''. Both are "blank".
  assert.equal(await s.getRowCount({ trader: { filterType: 'set', values: [null] } }), 1);
  assert.equal(await s.getRowCount({ desk: { filterType: 'set', values: [null] } }), 1);
});

test('inRange is inclusive at BOTH ends', async () => {
  // Off-by-one here drops boundary rows in one mode and keeps them in the other.
  const s = svc();
  const n = await s.getRowCount({ notional: { filterType: 'number', type: 'inRange', filter: 100, filterTo: 300 } });
  assert.equal(n, 3, 'P1(100), P2(200), P3(300)');
});

test('text filters are case-insensitive, matching AG-Grid defaults', async () => {
  const s = svc();
  assert.equal(await s.getRowCount({ desk: { filterType: 'text', type: 'equals', filter: 'GOVIES' } }), 2);
  assert.equal(await s.getRowCount({ desk: { filterType: 'text', type: 'contains', filter: 'ovie' } }), 2);
});

test('blank and notBlank distinguish correctly', async () => {
  const s = svc();
  assert.equal(await s.getRowCount({ trader: { filterType: 'text', type: 'blank' } }), 1);
  assert.equal(await s.getRowCount({ trader: { filterType: 'text', type: 'notBlank' } }), 4);
});

test('a blank value does not match an ordinary comparison', async () => {
  // Coercing null to 0 would make P4 match `< 50`, which is a silent lie.
  const s = svc();
  const n = await s.getRowCount({ notional: { filterType: 'number', type: 'lessThan', filter: 50 } });
  assert.equal(n, 0, 'null notional must not coerce to 0');
});

test('combined AND/OR conditions on one column', async () => {
  const s = svc();
  const model = {
    notional: {
      filterType: 'number', operator: 'OR',
      conditions: [
        { filterType: 'number', type: 'lessThan', filter: 150 },
        { filterType: 'number', type: 'greaterThan', filter: 450 },
      ],
    },
  };
  assert.equal(await s.getRowCount(model), 2, 'P1(100) and P5(500)');
});

test('columns combine with AND', async () => {
  const s = svc();
  const n = await s.getRowCount({
    desk: { filterType: 'set', values: ['Govies'] },
    trader: { filterType: 'set', values: ['Sarah'] },
  });
  assert.equal(n, 1);
});

// ------------------------------------------------- sorting

test('blanks are the smallest value, so the direction moves them', async () => {
  // AG-Grid's default comparator treats a missing value as smaller than every
  // other, and the direction then inverts the whole comparison — blanks are not
  // pinned to one end. "Nulls always last" is the convention in some other
  // grids; implementing that would put CSRM and SSRM one row apart on every
  // column containing a blank.
  const asc = sortRows(DATA.slice(0, 5), [{ colId: 'notional', sort: 'asc' }]);
  assert.equal(asc[0].positionId, 'P4', 'blank first ascending');
  const desc = sortRows(DATA.slice(0, 5), [{ colId: 'notional', sort: 'desc' }]);
  assert.equal(desc.at(-1).positionId, 'P4', 'blank last descending');
});

test('string collation is numeric-aware, so Item 9 precedes Item 10', () => {
  const out = ['Item 10', 'Item 9', 'Item 1'].sort(comparator);
  assert.deepEqual(out, ['Item 1', 'Item 9', 'Item 10']);
});

// ------------------------------------------------- distinct values

test('distinct values are sorted and de-duplicated, with blanks as null', async () => {
  const s = svc();
  assert.deepEqual(await s.getDistinctValues('desk'), [null, 'Govies', 'Rates']);
});

test('cascading values narrow the list using the OTHER columns filters', async () => {
  // The subtle CSRM behaviour SSRM does not have by default (parity §1.5).
  const s = svc();
  const all = await s.getDistinctValues('trader');
  const narrowed = await s.getDistinctValues('trader', { desk: { filterType: 'set', values: ['Govies'] } });
  assert.ok(all.includes('Sarah') && all.includes('Mike'));
  assert.deepEqual(narrowed, ['Mike', 'Sarah'], 'only Govies traders');
});

test('searchValues does prefix matching for the high-cardinality path', async () => {
  const s = svc();
  assert.deepEqual(await s.searchValues('positionId', 'P1'), ['P1']);
  assert.equal((await s.searchValues('trader', 'S')).length, 1);
});

// ------------------------------------------------- aggregates

test('built-in aggregates', async () => {
  const s = svc();
  const out = await s.getAggregates([
    { column: 'notional', fn: 'sum', as: 'total' },
    { column: 'dv01', fn: 'avg', as: 'avgDv01' },
    { column: 'notional', fn: 'max', as: 'biggest' },
    { column: 'positionId', fn: 'count', as: 'n' },
  ]);
  assert.equal(out.total, 1100);
  assert.equal(out.biggest, 500);
  assert.equal(out.n, 5);
  assert.equal(out.avgDv01, 30);
});

test('weighted average uses the sum decomposition, matching the hub', async () => {
  // Perspective has no native weighted mean; the hub answers with
  // sum(w*x)/sum(w). Doing the same here keeps the two modes numerically
  // identical rather than merely close.
  const s = svc();
  const out = await s.getAggregates([{ column: 'px', fn: 'weightedAvg', weight: 'dv01', as: 'wap' }]);
  const rows = DATA.filter((r) => !r._deleted);
  const expect = rows.reduce((a, r) => a + r.px * r.dv01, 0) / rows.reduce((a, r) => a + r.dv01, 0);
  assert.ok(Math.abs(out.wap - expect) < 1e-9);
});

test('aggregates respect the filter', async () => {
  const s = svc();
  const out = await s.getAggregates(
    [{ column: 'notional', fn: 'sum', as: 'total' }],
    { desk: { filterType: 'set', values: ['Govies'] } }
  );
  assert.equal(out.total, 300, 'P1 + P2 only');
});

test('an unsupported aggregate fails loudly', async () => {
  const s = svc();
  await assert.rejects(() => s.getAggregates([{ column: 'px', fn: 'stddev' }]), /unsupported aggregate/);
});

// ------------------------------------------------- search

test('search returns a FilterModel, not filtered rows', async () => {
  // SSRM has no quick filter at all, so the identical call must work there.
  const s = svc();
  const model = s.search('sarah');
  assert.ok(model.__search__, 'a model, not rows');
  assert.equal(await s.getRowCount(model), 2, 'Sarah has P1 and P3');
});

test('search covers only the configured column subset', async () => {
  const s = svc();
  // 'P1' appears in positionId, which is NOT in searchColumns.
  assert.equal(await s.getRowCount(s.search('P1')), 0);
  assert.equal(await s.getRowCount(s.search('P1', ['positionId'])), 1);
});

test('empty search text matches everything', async () => {
  const s = svc();
  assert.equal(await s.getRowCount(s.search('')), 5);
});

// ------------------------------------------------- whole-dataset ops

test('exportAll produces CSV with correct escaping and hidden columns dropped', async () => {
  const s = svc();
  const csv = await s.exportAll('csv', {});
  const text = typeof csv === 'string' ? csv : await csv.text();
  assert.ok(!text.includes('internal'), 'hidden columns are excluded');
  assert.ok(text.startsWith('positionId,desk,trader,notional,dv01,px'));
  assert.equal(text.trim().split('\n').length, 6, 'header + 5 rows');
});

test('CSV escapes commas, quotes and newlines', async () => {
  const s = svc([{ positionId: 'P1', desk: 'A,B', trader: 'say "hi"', notional: 1, dv01: 1, px: 1, _deleted: false }]);
  const text = await s.exportAll('csv', {});
  const body = (typeof text === 'string' ? text : await text.text()).split('\n')[1];
  assert.ok(body.includes('"A,B"'));
  assert.ok(body.includes('"say ""hi"""'));
});

test('copyAll is tab-separated for spreadsheet paste', async () => {
  const s = svc();
  const out = await s.copyAll({});
  assert.ok(out.split('\n')[0].includes('\t'));
});

test('scanAll batches every row, replacing forEachNode', async () => {
  const s = svc();
  const seen = [];
  await s.scanAll({}, (batch) => seen.push(batch.length), { batchRows: 2 });
  assert.deepEqual(seen, [2, 2, 1]);
});

test('exportAll and scanAll honour the view filter and sort', async () => {
  const s = svc();
  const view = { filter: { desk: { filterType: 'set', values: ['Govies'] } }, sort: [{ colId: 'notional', sort: 'desc' }] };
  const seen = [];
  await s.scanAll(view, (b) => seen.push(...b));
  assert.deepEqual(seen.map((r) => r.positionId), ['P2', 'P1']);
});

// ------------------------------------------------- navigation and selection

test('rankOf gives the index under the current sort and filter', async () => {
  const s = svc();
  const view = { sort: [{ colId: 'notional', sort: 'desc' }] };
  assert.equal(await s.rankOf('P5', view), 0, 'largest notional first');
  assert.equal(await s.rankOf('P1', view), 3);
});

test('rankOf returns null for a key that is not in the view', async () => {
  const s = svc();
  assert.equal(await s.rankOf('P6', {}), null, 'soft-deleted');
  assert.equal(await s.rankOf('nope', {}), null);
});

test('selection resolves as predicate-plus-exceptions, not a row list', async () => {
  // Any action on an SSRM selection must send the predicate, because select-all
  // spans rows that were never loaded (parity study §2.5).
  const s = svc();
  const all = await s.resolveSelection({ selectAll: true, toggledNodes: ['P1'] }, {});
  assert.equal(all.selectAll, true);
  assert.equal(all.count, 4, 'everything except the toggled exception');
  assert.ok(!all.keys.includes('P1'));

  const some = await s.resolveSelection({ selectAll: false, toggledNodes: ['P1', 'P3'] }, {});
  assert.deepEqual(some.keys.sort(), ['P1', 'P3']);
});

test('the service exposes its mode so diagnostics can report it', () => {
  assert.equal(svc().mode, 'csrm');
});

test('every method named in the parity study is implemented', () => {
  // parity study §6 / architecture §8.5 list eleven methods. A missing one is a
  // place blotter code would have to branch on mode.
  const s = svc();
  for (const m of [
    'getDistinctValues', 'searchValues', 'getRowCount', 'getAggregates', 'search',
    'exportAll', 'copyAll', 'scanAll', 'snapshotForChart', 'rankOf', 'resolveSelection',
  ]) {
    assert.equal(typeof s[m], 'function', `${m} is missing`);
  }
});
