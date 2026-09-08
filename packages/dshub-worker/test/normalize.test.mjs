import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNormalizer, ticksToDecimal, OP } from '../src/normalize.mjs';

const SEP = '';

const datasource = {
  id: 'cmbs-positions',
  keyColumns: ['positionId'],
  opField: { path: 'action', map: { N: 'insert', U: 'update', D: 'delete' } },
  softDelete: { column: '_deleted', reapAfterMs: 60000 },
  flatten: {
    separator: '_',
    maxDepth: 4,
    arrays: { legs: { strategy: 'explode', childTable: 'cmbs-position-legs' } },
  },
  coercions: [{ path: 'price', kind: 'ticks-to-decimal', companion: 'price32_num' }],
};

const n = createNormalizer(datasource, null);

// ------------------------------------------------- the partial-patch contract

test('a partial patch emits ONLY the fields it carried', () => {
  // The single most important behaviour in the normalizer. Emitting the full
  // flattened row with nulls would wipe every untouched column through
  // Perspective's merge semantics (architecture §5.2).
  const { rows } = n.normalize({ positionId: 'P1', action: 'U', risk: { dv01: 1234 } });
  assert.deepEqual(Object.keys(rows[0]).sort(), ['__key', '__op', 'positionId', 'risk_dv01']);
  assert.equal(rows[0].risk_dv01, 1234);
  assert.ok(!('counterparty_name' in rows[0]), 'must not invent absent columns');
});

test('absent and null stay distinguishable', () => {
  const { rows } = n.normalize({ positionId: 'P1', action: 'U', notional: null });
  assert.ok('notional' in rows[0], 'explicit null is present');
  assert.equal(rows[0].notional, null);
  assert.ok(!('spread' in rows[0]), 'absent is absent');
});

test('nested objects flatten with the configured separator, never a dot', () => {
  const { rows } = n.normalize({
    positionId: 'P1', action: 'U',
    counterparty: { name: 'Broker A', lei: 'X1' },
  });
  assert.equal(rows[0].counterparty_name, 'Broker A');
  assert.equal(rows[0].counterparty_lei, 'X1');
});

test('a "." separator is refused outright', () => {
  assert.throws(
    () => createNormalizer({ ...datasource, flatten: { separator: '.' } }, null),
    /separator/
  );
});

// ------------------------------------------------- ops and soft delete

test('op tokens map, and a delete becomes the soft-delete flag flip', () => {
  // Perspective's on_update never surfaces removals (architecture §8.4), so the
  // flag flip IS the delta the provider maps back to a grid removal.
  const { rows } = n.normalize({ positionId: 'P1', action: 'D' });
  assert.equal(rows[0].__op, OP.DELETE);
  assert.equal(rows[0]._deleted, true);
});

test('an insert clears the soft-delete flag, so a re-add resurrects cleanly', () => {
  const { rows } = n.normalize({ positionId: 'P1', action: 'N' });
  assert.equal(rows[0].__op, OP.INSERT);
  assert.equal(rows[0]._deleted, false);
});

test('an unmapped op token fails loudly rather than silently updating', () => {
  assert.throws(() => n.normalize({ positionId: 'P1', action: 'Z' }), /unmapped op token/);
});

test('a message missing its key column is rejected', () => {
  assert.throws(() => n.normalize({ action: 'U', risk: { dv01: 1 } }), /missing key column/);
});

// ------------------------------------------------- FI coercions

test('32nds prices produce a numeric companion, leaving the display string intact', () => {
  const { rows } = n.normalize({ positionId: 'P1', action: 'U', price: '99-16' });
  assert.equal(rows[0].price, '99-16', 'display value stays a string');
  assert.equal(rows[0].price32_num, 99.5, 'companion is numeric');
});

test('ticksToDecimal handles halves, quarters and negatives', () => {
  assert.equal(ticksToDecimal('99-16'), 99.5);
  assert.equal(ticksToDecimal('99-16+'), 99.515625);
  assert.equal(ticksToDecimal('100-00'), 100);
  assert.equal(ticksToDecimal('-2-08'), -2.25);
  assert.equal(ticksToDecimal('not a price'), null);
  assert.equal(ticksToDecimal(99.5), null);
});

test('sorting by the companion orders correctly where the string does not', () => {
  // "100-01" < "99-16" lexically; the whole point of the companion column.
  const prices = ['99-16', '100-01', '99-24'];
  const sorted = [...prices].sort((a, b) => ticksToDecimal(a) - ticksToDecimal(b));
  assert.deepEqual(sorted, ['99-16', '99-24', '100-01']);
});

test('a coercion is skipped when its column is absent from a partial patch', () => {
  const { rows } = n.normalize({ positionId: 'P1', action: 'U', risk: { dv01: 5 } });
  assert.ok(!('price32_num' in rows[0]), 'must not emit a companion for an absent source');
});

// ------------------------------------------------- arrays

test('explode emits sibling-table rows keyed parentKey + index', () => {
  const { rows, children } = n.normalize({
    positionId: 'P1', action: 'U',
    legs: [{ ccy: 'USD', notional: 1e6 }, { ccy: 'EUR', notional: 2e6 }],
  });
  assert.equal(children.length, 1);
  assert.equal(children[0].table, 'cmbs-position-legs');
  assert.equal(children[0].rows.length, 2);
  assert.equal(children[0].rows[0].__key, `P1${SEP}0`);
  assert.equal(children[0].rows[1].ccy, 'EUR');
  assert.ok(!('legs' in rows[0]), 'exploded array does not also land on the parent row');
});

test('an unconfigured array is JSON-stringified rather than dropped', () => {
  const { rows } = n.normalize({ positionId: 'P1', action: 'U', tags: ['a', 'b'] });
  assert.equal(rows[0].tags, '["a","b"]');
});

test('index-pin bounds the arity', () => {
  const pinned = createNormalizer({
    ...datasource,
    flatten: { separator: '_', arrays: { ratings: { strategy: 'index-pin', arity: 2 } } },
  }, null);
  const { rows } = pinned.normalize({ positionId: 'P1', action: 'U', ratings: ['AAA', 'AA', 'A'] });
  assert.equal(rows[0].ratings_0, 'AAA');
  assert.equal(rows[0].ratings_1, 'AA');
  assert.ok(!('ratings_2' in rows[0]), 'arity is a bound, not a suggestion');
});

test('aggregate computes at ingest', () => {
  const agg = createNormalizer({
    ...datasource,
    flatten: {
      separator: '_',
      arrays: { legs: { strategy: 'aggregate', aggregate: 'sum', aggregatePath: 'notional' } },
    },
  }, null);
  const { rows } = agg.normalize({
    positionId: 'P1', action: 'U',
    legs: [{ notional: 1e6 }, { notional: 2e6 }],
  });
  assert.equal(rows[0].legs_sum, 3e6);
});

// ------------------------------------------------- composite keys

test('composite keys join on \\u0001, which cannot appear in data', () => {
  const composite = createNormalizer({ ...datasource, keyColumns: ['book', 'positionId'] }, null);
  const { rows } = composite.normalize({ book: 'CMBS', positionId: 'P-1', action: 'U' });
  assert.equal(rows[0].__key, `CMBS${SEP}P-1`);
  // A '-' separator would collide with the hyphen already inside the id.
  assert.equal(SEP.charCodeAt(0), 1, 'the separator must survive editing');
  assert.ok(rows[0].__key.includes(SEP), 'composite key joined with nothing');
});
