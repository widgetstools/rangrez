/**
 * Row identity must be the SAME across every layer that computes it.
 *
 * The hub mints `__key` in normalize.mjs; CsrmMode computes it for AG-Grid's
 * getRowId; CsrmDataService computes it for rankOf and resolveSelection; SsrmMode
 * computes it for leaf row ids. Four places, and they had drifted — three used
 * U+0001 and one joined with nothing, so rankOf never matched and the hub and
 * the grid disagreed about which row was which.
 *
 * These tests compare the layers against each other rather than against a
 * hardcoded string, so they keep holding if the encoding is ever deliberately
 * changed — and fail the moment one layer changes alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CsrmMode } from '../src/modes/csrm.mjs';
import { SsrmMode } from '../src/modes/ssrm.mjs';
import { CsrmDataService } from '../src/dataService.mjs';
import { createNormalizer } from '../../dshub-worker/src/normalize.mjs';

const KEY_COLUMNS = ['book', 'positionId'];
const artifact = { keyColumns: KEY_COLUMNS, columns: [] };

const ROWS = [
  { book: 'CMBS', positionId: 'P-1', px: 1 },
  { book: 'CMBSP', positionId: '-1', px: 2 },   // concatenates to the same string
  { book: 'Govies', positionId: 'P-2', px: 3 },
];

const csrmMode = () => new CsrmMode({
  engine: {}, gridApi: {}, artifact, keyColumns: KEY_COLUMNS,
});
const svc = () => new CsrmDataService({
  getRows: () => ROWS, artifact, keyColumns: KEY_COLUMNS,
});
const ssrmMode = () => new SsrmMode({
  dataService: {}, artifact, keyColumns: KEY_COLUMNS,
});

test('CsrmMode and CsrmDataService agree on every row', () => {
  // They disagreed: the grid produced a separated key and the data service
  // produced a concatenated one, so rankOf compared two encodings and never
  // matched — ensureIndexVisible silently did nothing on any composite key.
  const a = csrmMode(), b = svc();
  for (const row of ROWS) {
    assert.equal(a.keyOf(row), b.keyOf(row), `disagreement on ${JSON.stringify(row)}`);
  }
});

test('SsrmMode leaf ids use the same encoding, just namespaced', () => {
  const a = csrmMode(), s = ssrmMode();
  for (const row of ROWS) {
    assert.equal(s.getRowId({ data: row, level: -1 }), `r:${a.keyOf(row)}`);
  }
});

test("the provider reproduces the hub's __key exactly", () => {
  // The parity study's requirement: byte-identical, or transactions do not
  // route. This is the pairing that actually matters, because one side is in
  // the worker and the other is in the page.
  const normalize = createNormalizer(
    { id: 'positions', keyColumns: KEY_COLUMNS, flatten: { separator: '_', maxDepth: 4 } },
    artifact,
  );
  const mode = csrmMode();
  for (const row of ROWS) {
    const { rows: [normalized] } = normalize.normalize(row);
    assert.equal(
      normalized.__key, mode.keyOf(row),
      `hub minted "${normalized.__key}" but the grid computes "${mode.keyOf(row)}"`,
    );
  }
});

test('rows that concatenate alike stay distinct at every layer', () => {
  const [a, b] = ROWS;
  for (const [name, keyOf] of [
    ['CsrmMode', (r) => csrmMode().keyOf(r)],
    ['CsrmDataService', (r) => svc().keyOf(r)],
    ['SsrmMode', (r) => ssrmMode().getRowId({ data: r, level: -1 })],
  ]) {
    assert.notEqual(keyOf(a), keyOf(b), `${name} collapses two distinct positions into one row`);
  }
});

test('rankOf finds a row by the key the GRID produced', () => {
  // The end-to-end symptom of the drift, stated as the behaviour a caller
  // actually depends on.
  const s = svc(), mode = csrmMode();
  const target = ROWS[1];
  return s.rankOf(mode.keyOf(target), {}).then((rank) => {
    assert.equal(rank, 1, 'rankOf returned null — the two encodings disagree again');
  });
});

test('resolveSelection selects the row the grid pointed at', () => {
  const s = svc(), mode = csrmMode();
  return s.resolveSelection({ toggledNodes: [mode.keyOf(ROWS[1])] }, {}).then((sel) => {
    assert.equal(sel.count, 1);
    assert.deepEqual(sel.keys, [mode.keyOf(ROWS[1])]);
  });
});
