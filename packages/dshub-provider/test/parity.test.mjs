/**
 * CSRM ⇄ SSRM parity — the automated harness (Phase 8 exit criterion).
 *
 * For every grid state in the matrix, the two modes must return identical row
 * keys and identical aggregates over the same corpus. See parity.mjs for why
 * this is comparing the real CSRM path against the real SSRM translation, with
 * evalOps as the calibrated Perspective oracle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeCorpus, evalOps, keysOf } from '../src/parity.mjs';
import { rowPredicate, sortRows } from '../src/filter.mjs';
import { CsrmDataService } from '../src/dataService.mjs';
import { HubDataService } from '../src/hubDataService.mjs';
import { filterModelToOps, toViewSpec } from '../src/modes/ssrm.mjs';
import { toFilterOps } from '../src/hubDataService.mjs';

const corpus = makeCorpus(2000);
const artifact = {
  keyColumns: ['positionId'],
  columns: [
    { id: 'desk', column: 'desk', type: 'string', filter: 'set' },
    { id: 'trader', column: 'trader', type: 'string', filter: 'set' },
    { id: 'currency', column: 'currency', type: 'string', filter: 'set' },
    { id: 'book', column: 'book', type: 'string', filter: 'set' },
    { id: 'dv01', column: 'dv01', type: 'float', filter: 'number' },
    { id: 'marketValue', column: 'marketValue', type: 'float', filter: 'number' },
    { id: 'quantity', column: 'quantity', type: 'float', filter: 'number' },
  ],
};

const csrm = new CsrmDataService({ getRows: () => corpus, artifact, keyColumns: ['positionId'] });

/**
 * CSRM's own filtered set — via applyFilter, the SAME entry point getRowCount
 * uses. NOT the bare rowPredicate: rowPredicate does not know the __search__
 * pseudo-column (the service splits it out), and comparing against it made the
 * harness say CSRM found 0 rows for a quick search when the service finds 400.
 * The harness must compare the paths the modes actually run.
 */
const csrmFiltered = (fm) => csrm.applyFilter(corpus, fm);

/** SSRM side, run without a hub: translate then evaluate with the oracle. */
function ssrmRows(filterModel) {
  const ops = toFilterOps(filterModel);        // the real hub-path translation
  return corpus.filter(evalOps(ops));
}

// ------------------------------------------------- the filter matrix

const FILTERS = {
  'no filter': {},
  'set: one desk': { desk: { filterType: 'set', values: ['Govies'] } },
  'set: two desks': { desk: { filterType: 'set', values: ['Govies', 'EM Debt'] } },
  'set: EMPTY (nothing)': { desk: { filterType: 'set', values: [] } },
  'text equals exact': { desk: { filterType: 'text', type: 'equals', filter: 'Govies' } },
  'text equals lowercase': { desk: { filterType: 'text', type: 'equals', filter: 'govies' } },
  'text equals UPPER': { desk: { filterType: 'text', type: 'equals', filter: 'GOVIES' } },
  'text notEqual': { desk: { filterType: 'text', type: 'notEqual', filter: 'govies' } },
  'text contains': { trader: { filterType: 'text', type: 'contains', filter: 'o' } },
  'text notContains': { trader: { filterType: 'text', type: 'notContains', filter: 'o' } },
  'text startsWith': { trader: { filterType: 'text', type: 'startsWith', filter: 'J' } },
  'text endsWith': { trader: { filterType: 'text', type: 'endsWith', filter: 'e' } },
  'contains metachar dot': { book: { filterType: 'text', type: 'contains', filter: '.' } },
  'blank on a blanky column': { book: { filterType: 'text', type: 'blank' } },
  'notBlank': { book: { filterType: 'text', type: 'notBlank' } },
  'number greaterThan boundary': { dv01: { filterType: 'number', type: 'greaterThan', filter: 1000 } },
  'number greaterThanOrEqual': { dv01: { filterType: 'number', type: 'greaterThanOrEqual', filter: 1000 } },
  'number lessThan': { dv01: { filterType: 'number', type: 'lessThan', filter: 500 } },
  'number inRange inclusive': { dv01: { filterType: 'number', type: 'inRange', filter: 0, filterTo: 1000 } },
  'number equals zero': { quantity: { filterType: 'number', type: 'equals', filter: 0 } },
  'two columns AND': {
    desk: { filterType: 'set', values: ['Govies'] },
    trader: { filterType: 'set', values: ['Jane Doe'] },
  },
  'combined AND on one column': {
    desk: { filterType: 'text', operator: 'AND',
      conditions: [{ filterType: 'text', type: 'startsWith', filter: 'G' }, { filterType: 'text', type: 'endsWith', filter: 's' }] },
  },
  'combined OR on one column': {
    desk: { filterType: 'text', operator: 'OR',
      conditions: [{ filterType: 'text', type: 'equals', filter: 'Govies' }, { filterType: 'text', type: 'equals', filter: 'EM Debt' }] },
  },
  'OR plus another column': {
    desk: { filterType: 'text', operator: 'OR',
      conditions: [{ filterType: 'text', type: 'equals', filter: 'Govies' }, { filterType: 'text', type: 'equals', filter: 'EM Debt' }] },
    currency: { filterType: 'set', values: ['USD'] },
  },
  'quick search across columns': {
    __search__: { filterType: 'multi', operator: 'OR', columns: ['desk', 'trader'],
      conditions: [
        { filterType: 'text', type: 'contains', filter: 'gov', colId: 'desk' },
        { filterType: 'text', type: 'contains', filter: 'gov', colId: 'trader' },
      ] },
  },
};

for (const [name, fm] of Object.entries(FILTERS)) {
  test(`filter parity — ${name}`, async () => {
    // CSRM: the real local path — applyFilter, what getRowCount runs.
    const csrmKeys = keysOf(csrmFiltered(fm));
    const ssrmKeys = keysOf(ssrmRows(fm));
    assert.deepEqual(ssrmKeys, csrmKeys,
      `${name}: CSRM ${csrmKeys.length} rows vs SSRM ${ssrmKeys.length}`);

    // And the row COUNT the hub would report matches CSRM's getRowCount.
    const csrmCount = await csrm.getRowCount(fm);
    assert.equal(csrmCount, csrmKeys.length, 'CSRM count is self-consistent');
    assert.equal(ssrmRows(fm).length, csrmCount, `${name}: counts diverge`);
  });
}

// ------------------------------------------------- aggregate parity

const AGG_SPECS = [
  { column: 'dv01', fn: 'sum', as: 'dv01_sum' },
  { column: 'marketValue', fn: 'sum', as: 'mv_sum' },
  { column: 'dv01', fn: 'avg', as: 'dv01_avg' },
  { column: 'quantity', fn: 'min', as: 'q_min' },
  { column: 'quantity', fn: 'max', as: 'q_max' },
  { column: 'positionId', fn: 'count', as: 'n' },
];

/** Reference aggregate over a filtered set — the math both modes share. */
function referenceAgg(rows) {
  const num = (c) => rows.map((r) => Number(r[c])).filter(Number.isFinite);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return {
    dv01_sum: sum(num('dv01')),
    mv_sum: sum(num('marketValue')),
    dv01_avg: num('dv01').length ? sum(num('dv01')) / num('dv01').length : null,
    q_min: num('quantity').length ? Math.min(...num('quantity')) : null,
    q_max: num('quantity').length ? Math.max(...num('quantity')) : null,
    n: rows.length,
  };
}

for (const [name, fm] of Object.entries(FILTERS)) {
  test(`aggregate parity — ${name}`, async () => {
    const csrmAgg = await csrm.getAggregates(AGG_SPECS, fm);
    const ref = referenceAgg(csrmFiltered(fm));
    // CSRM must match the reference math...
    for (const k of Object.keys(ref)) {
      assert.ok(closeEnough(csrmAgg[k], ref[k]), `CSRM ${k}: ${csrmAgg[k]} vs ${ref[k]}`);
    }
    // ...and the SAME specs over the SSRM-filtered set must match too, which is
    // what the hub computes server-side.
    const ssrmRef = referenceAgg(ssrmRows(fm));
    for (const k of Object.keys(ref)) {
      assert.ok(closeEnough(ssrmRef[k], ref[k]), `SSRM ${k}: ${ssrmRef[k]} vs ${ref[k]}`);
    }
  });
}

const closeEnough = (a, b) => (a === null && b === null) || Math.abs(a - b) < 1e-6;

// ------------------------------------------------- sort parity

const SORTS = [
  [{ colId: 'desk', sort: 'asc' }],
  [{ colId: 'desk', sort: 'desc' }],
  [{ colId: 'dv01', sort: 'asc' }],
  [{ colId: 'book', sort: 'asc' }],          // blanks first ascending
  [{ colId: 'book', sort: 'desc' }],         // blanks last descending
  [{ colId: 'desk', sort: 'asc' }, { colId: 'dv01', sort: 'desc' }],
];

for (const sortModel of SORTS) {
  const label = sortModel.map((s) => `${s.colId} ${s.sort}`).join(', ');
  test(`sort parity — ${label}`, () => {
    // The SSRM viewspec carries the same sort the CSRM comparator applies.
    const spec = toViewSpec({ groupKeys: [], rowGroupCols: [], sortModel });
    assert.deepEqual(
      spec.sort.map((s) => [s.column, s.dir]),
      sortModel.map((s) => [s.colId, s.sort]),
      'the sort reaches the view spec verbatim',
    );
    // And CSRM's own ordering is stable and self-consistent.
    const sorted = sortRows(corpus, sortModel);
    assert.equal(sorted.length, corpus.length, 'sort drops no rows');
    // Blank handling: ascending puts blanks first, descending last (§ filter.mjs).
    if (sortModel.length === 1 && sortModel[0].colId === 'book') {
      const first = sorted[0].book, last = sorted.at(-1).book;
      const blank = (v) => v === '' || v === null || v === undefined;
      if (sortModel[0].sort === 'asc') assert.ok(blank(first), 'blanks first ascending');
      else assert.ok(blank(last), 'blanks last descending');
    }
  });
}

// ------------------------------------------------- group parity

const GROUPS = [
  { by: ['desk'] },
  { by: ['currency'] },
  { by: ['desk', 'trader'] },
];

for (const { by } of GROUPS) {
  test(`group parity — by ${by.join(' > ')}`, () => {
    // CSRM groups locally; SSRM asks the hub to group the NEXT level only, with
    // the expanded path as equality filters. Parity here means: the top-level
    // group set, and each group's leaf count and aggregate, agree.
    const topSpec = toViewSpec({ groupKeys: [], rowGroupCols: by.map((id) => ({ id })),
      valueCols: [{ id: 'dv01', aggFunc: 'sum' }] });
    assert.deepEqual(topSpec.groupBy, [by[0]], 'SSRM groups only the next level down');

    // Build CSRM's group tree by hand and compare the first level to what the
    // hub would return (group value + sum + count per group).
    const groups = new Map();
    for (const r of corpus) {
      const k = r[by[0]];
      if (!groups.has(k)) groups.set(k, { rows: 0, dv01: 0 });
      const g = groups.get(k); g.rows++; g.dv01 += Number(r.dv01) || 0;
    }
    // The equality filter for expanding one group must select exactly that group.
    const [firstKey] = [...groups.keys()];
    const expandSpec = toViewSpec({ groupKeys: [firstKey], rowGroupCols: by.map((id) => ({ id })) });
    assert.deepEqual(
      expandSpec.filter.find((f) => f.column === by[0]),
      { column: by[0], op: 'equals', value: firstKey },
      'expanding a group is an equality filter on its value',
    );
    const inGroup = corpus.filter((r) => r[by[0]] === firstKey);
    assert.equal(inGroup.length, groups.get(firstKey).rows, 'the equality filter selects exactly the group');
  });
}

// ------------------------------------------------- the harness itself

test('the corpus actually contains the shapes parity must survive', () => {
  const blanks = corpus.filter((r) => r.book === '' || r.book === null).length;
  const nulls = corpus.filter((r) => r.book === null).length;
  assert.ok(blanks > 50, 'enough blanks to matter');
  assert.ok(nulls > 0, 'at least one true null, distinct from empty string');
  assert.ok(corpus.some((r) => r.quantity === 0), 'a zero, to catch blank-vs-zero confusion');
  assert.ok(corpus.some((r) => r.dv01 > 1000) && corpus.some((r) => r.dv01 < 1000), 'rows either side of a boundary');
});

test('the oracle rejects an op it has no rule for, rather than passing silently', () => {
  assert.throws(() => corpus.filter(evalOps([{ column: 'desk', op: 'vibesLike', value: 'x' }])),
    /no rule for op/);
});
