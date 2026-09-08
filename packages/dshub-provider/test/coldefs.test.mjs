import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildColDefs, engineColumnsFor, selectMode, humanize, widthFor } from '../src/coldefs.mjs';

/** Minimal GridDataService stand-in; CSRM and SSRM present the same interface. */
const dataService = {
  calls: [],
  getDistinctValues(colId, ctx) { this.calls.push([colId, ctx]); return Promise.resolve(['A', 'B']); },
  currentFilterModel: () => ({ book: { values: ['CMBS'] } }),
};

const artifact = {
  id: 'cmbs-positions',
  version: 7,
  keyColumns: ['positionId'],
  estimatedRows: 500_000,
  columns: [
    { id: 'positionId', path: 'positionId', column: 'positionId', type: 'string', cardinality: 500_000, filter: 'search-select', observed: { maxStringLength: 18 } },
    { id: 'counterparty', path: 'counterparty.name', column: 'counterparty_name', type: 'string', cardinality: 340, filter: 'set', cascadingValues: true, observed: { maxStringLength: 24 } },
    { id: 'book', path: 'book', column: 'book', type: 'string', cardinality: 3, filter: 'set', observed: { maxStringLength: 4 } },
    {
      id: 'price32', path: 'price', column: 'price32', type: 'string', filter: 'text',
      companion: { column: 'price32_num', type: 'float', coercion: 'ticks-to-decimal' },
      observed: { maxStringLength: 8 },
    },
    { id: 'price32_num', path: 'price32_num', column: 'price32_num', type: 'float', filter: 'number', observed: { maxDecimals: 6, max: 130 } },
    { id: 'dv01', path: 'risk.dv01', column: 'risk_dv01', type: 'float', filter: 'number', observed: { maxDecimals: 2, max: 98765 } },
    { id: 'internal', path: 'internal', column: 'internal', type: 'string', filter: 'text', colDef: { hide: true }, observed: { maxStringLength: 4 } },
  ],
};

const byId = (defs, id) => defs.find((d) => d.colId === id);

// ------------------------------------------------- the companion contract

test('a companion column is not shown as its own grid column', () => {
  // It exists to sort and aggregate the display column; showing both confuses
  // traders and doubles the width for no information.
  const defs = buildColDefs(artifact, dataService);
  assert.ok(byId(defs, 'price32'), 'the display column is present');
  assert.ok(!byId(defs, 'price32_num'), 'the companion is not');
});

test('the display column sorts through its companion, with no comparator', () => {
  // A custom comparator works in CSRM and is SILENTLY IGNORED in SSRM (parity
  // study §3). The sort key has to live in the data — that is why the companion
  // column exists at all.
  const def = byId(buildColDefs(artifact, dataService), 'price32');
  assert.equal(def.sortColumn, 'price32_num');
  assert.equal(def.comparator, undefined, 'never a client comparator');
});

test('the engine must still materialise companions even though they are hidden', () => {
  const cols = engineColumnsFor(artifact);
  assert.ok(cols.includes('price32'));
  assert.ok(cols.includes('price32_num'), 'sorted on without being displayed');
});

// ------------------------------------------------- filters from cardinality

test('a very short value list gets a set filter with no mini-filter', () => {
  const def = byId(buildColDefs(artifact, dataService), 'book');
  assert.equal(def.filter, 'agSetColumnFilter');
  assert.equal(def.filterParams.suppressMiniFilter, true, '3 values are scannable by eye');
  assert.equal(def.filterParams.eager, true, 'cheap enough to prefetch');
});

test('a few hundred values stay eagerly fetched but keep the mini-filter', () => {
  // The eager/lazy threshold (500) is not the mini-filter threshold. 340 values
  // with no way to search them would be worse than the clutter.
  const def = byId(buildColDefs(artifact, dataService), 'counterparty');
  assert.equal(def.filterParams.eager, true);
  assert.equal(def.filterParams.suppressMiniFilter, false, '340 values need a search box');
});

test('past the eager threshold, values are fetched lazily on open', () => {
  const mid = { ...artifact, columns: [
    { id: 'trader', path: 'trader', column: 'trader', type: 'string', cardinality: 2000, filter: 'set', observed: { maxStringLength: 12 } },
  ] };
  const def = byId(buildColDefs(mid, dataService), 'trader');
  assert.equal(def.filter, 'agSetColumnFilter');
  assert.equal(def.filterParams.eager, false, '2000 values are not prefetched');
  assert.equal(def.filterParams.suppressMiniFilter, false);
});

test('high cardinality falls back to search-select rather than a set filter', () => {
  // AG-Grid ships the whole set-filter list to the browser; past ~10k the UX
  // degrades regardless of virtualization (parity study §1.4).
  const def = byId(buildColDefs(artifact, dataService), 'positionId');
  assert.equal(def.filter, 'dshubSearchSelectFilter');
  assert.equal(def.filterParams.colId, 'positionId');
});

test('set filter values are fetched asynchronously through the data service', async () => {
  dataService.calls = [];
  const def = byId(buildColDefs(artifact, dataService), 'book');
  const values = await new Promise((resolve) => def.filterParams.values({ success: resolve }));
  assert.deepEqual(values, ['A', 'B']);
  assert.equal(dataService.calls[0][0], 'book');
});

test('cascading values are opt-in, and only they pass the context filter', () => {
  // Every filter change invalidates N caches, so this is per-column (parity §1.5).
  const defs = buildColDefs(artifact, dataService);
  assert.equal(byId(defs, 'counterparty').filterParams.refreshValuesOnOpen, true);
  assert.equal(byId(defs, 'book').filterParams.refreshValuesOnOpen, false);

  dataService.calls = [];
  byId(defs, 'counterparty').filterParams.values({ success: () => {} });
  byId(defs, 'book').filterParams.values({ success: () => {} });
  assert.ok(dataService.calls[0][1], 'cascading column passes context');
  assert.equal(dataService.calls[1][1], undefined, 'non-cascading column does not');
});

// ------------------------------------------------- presentation

test('numeric columns are right-aligned and formatted to observed precision', () => {
  const def = byId(buildColDefs(artifact, dataService), 'dv01');
  assert.equal(def.type, 'rightAligned');
  assert.equal(def.valueFormatter({ value: 1234.5 }), '1,234.50', 'two observed decimals');
  assert.equal(def.valueFormatter({ value: null }), '', 'null renders empty, not NaN');
});

test('headers humanize, keeping FI acronyms uppercase', () => {
  assert.equal(humanize('counterparty_name'), 'Counterparty Name');
  assert.equal(humanize('risk_dv01'), 'Risk DV01');
  assert.equal(humanize('isin'), 'ISIN');
  assert.equal(humanize('trade_ccy'), 'Trade CCY');
});

test('width comes from observed data length, not from rendered rows', () => {
  // autoSizeAllColumns only measures loaded rows, so in SSRM it sizes to
  // whatever happens to be in view (parity study §3).
  const wide = widthFor({ column: 'a', type: 'string', observed: { maxStringLength: 40 } });
  const narrow = widthFor({ column: 'a', type: 'string', observed: { maxStringLength: 4 } });
  assert.ok(wide > narrow);
  assert.ok(narrow >= 90 && wide <= 320, 'clamped to a sane range');
});

test('hidden columns are excluded unless asked for', () => {
  assert.ok(!byId(buildColDefs(artifact, dataService), 'internal'));
  assert.ok(byId(buildColDefs(artifact, dataService, { includeHidden: true }), 'internal'));
});

test('grouping is offered on low-cardinality strings, not on high-cardinality ones', () => {
  const defs = buildColDefs(artifact, dataService);
  assert.equal(byId(defs, 'book').enableRowGroup, true);
  assert.equal(byId(defs, 'positionId').enableRowGroup, false, 'grouping by 500k keys is not useful');
  assert.equal(byId(defs, 'dv01').enableValue, true, 'numerics are aggregable');
});

// ------------------------------------------------- mode selection

test('mode is chosen from row count, never by the user', () => {
  assert.equal(selectMode({ estimatedRows: 10_000 }), 'csrm');
  assert.equal(selectMode({ estimatedRows: 100_000 }), 'csrm');
  assert.equal(selectMode({ estimatedRows: 100_000 }, { heavilyGrouped: true }), 'ssrm');
  assert.equal(selectMode({ estimatedRows: 500_000 }), 'ssrm');
  assert.equal(selectMode({ estimatedRows: 500_000 }, { heavilyGrouped: true }), 'vrm');
});

// ------------------------------------------------- offer only what works

import { SERVER_FILTER_OPTIONS, filterModelToOps } from '../src/modes/ssrm.mjs';
import { columnPredicate } from '../src/filter.mjs';

const textCol = { id: 'desk', column: 'desk', type: 'string', filter: 'text' };
const artifactWith = (c) => ({ keyColumns: ['id'], columns: [c] });

test('a server-backed text column offers only what the server can execute', () => {
  // Perspective has no "not contains" OPERATOR, so this was excluded — picking
  // it failed every getRows and blanked the grid. It has an EXPRESSION form
  // though, so once expressions were wired it became executable and the option
  // came back. The menu tracks capability rather than a hardcoded list.
  const [def] = buildColDefs(artifactWith(textCol), { mode: 'ssrm' });
  assert.ok(def.filterParams.filterOptions.includes('contains'));
  assert.ok(def.filterParams.filterOptions.includes('notContains'));
  assert.ok(!def.filterParams.filterOptions.includes('vibes'));
});

test('CSRM keeps the full menu — it can evaluate all of it locally', () => {
  const [def] = buildColDefs(artifactWith(textCol), { mode: 'csrm' });
  assert.equal(def.filterParams?.filterOptions, undefined, 'no restriction needed');
});

test('every offered server option is one the translator can execute', () => {
  // The guard against drift: if someone adds an option to the menu without
  // adding a translation, this fails.
  for (const [kind, opts] of Object.entries(SERVER_FILTER_OPTIONS)) {
    for (const op of opts) {
      const model = op === 'inRange'
        ? { filterType: kind, type: 'inRange', filter: 1, filterTo: 2 }
        : { filterType: kind, type: op, filter: 'x' };
      assert.doesNotThrow(
        () => filterModelToOps('c', model),
        `${kind} filter "${op}" is offered but has no translation`,
      );
    }
  }
});

test('every offered server option is also evaluable by CSRM', () => {
  // The same divergence in the other direction: an option SSRM accepts but
  // CSRM cannot evaluate would disagree between modes.
  for (const [kind, opts] of Object.entries(SERVER_FILTER_OPTIONS)) {
    for (const op of opts) {
      const model = op === 'inRange'
        ? { filterType: kind, type: 'inRange', filter: 1, filterTo: 2 }
        : { filterType: kind, type: op, filter: 'x' };
      assert.doesNotThrow(
        () => columnPredicate(model),
        `${kind} filter "${op}" is offered but CSRM cannot evaluate it`,
      );
    }
  }
});
