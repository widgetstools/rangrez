import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenPreview, compareStrategies, warningsFor } from '../src/flattenPreview.mjs';

const raw = () => ({
  positionId: 'P1', price: 101.5,
  legs: [{ rate: 1 }, { rate: 2 }, { rate: 3 }],
  nested: { a: { b: 7 } },
});
const ds = (arrays = {}) => ({
  id: 't', keyColumns: ['positionId'],
  flatten: { separator: '_', maxDepth: 4, arrays },
});
const cols = (p) => p.columns.map((c) => c.column);

// ------------------------------------------------- it runs the REAL normalizer

test('the preview is produced by the same normalizer the worker uses', () => {
  // A preview that agrees with itself and disagrees with production is worse
  // than no preview.
  const p = flattenPreview(raw(), ds({ legs: { strategy: 'index-pin' } }));
  assert.equal(p.error, null);
  assert.deepEqual(cols(p), ['legs_0_rate', 'legs_1_rate', 'legs_2_rate', 'nested_a_b', 'positionId', 'price']);
  assert.equal(p.key, 'P1', 'and the key it would actually be stored under');
});

test('nested objects are flattened with the configured separator', () => {
  const p = flattenPreview(raw(), { ...ds(), flatten: { separator: '__', maxDepth: 4, arrays: {} } });
  assert.ok(cols(p).includes('nested__a__b'), cols(p).join(', '));
});

test('a separator the normalizer forbids is explained, not silently accepted', () => {
  // `.` is rejected because raw paths may legally contain dots (§5.2), and the
  // editor must say so rather than produce columns that cannot be addressed.
  const p = flattenPreview(raw(), { ...ds(), flatten: { separator: '.', maxDepth: 4, arrays: {} } });
  assert.match(p.error, /separator/);
});

// ------------------------------------------------- the comparison is the point

test('the four strategies produce visibly different schemas', () => {
  // Seeing index-pin produce a column per element beside aggregate producing
  // one is what makes the choice obvious.
  const out = Object.fromEntries(compareStrategies(raw(), ds(), 'legs').map((r) => [r.strategy, r]));
  assert.equal(out['index-pin'].columns, 6);
  assert.equal(out.aggregate.columns, 4);
  assert.equal(out['json-string'].columns, 4);
  assert.equal(out.explode.columns, 3);
  assert.equal(out.explode.childRows, 3, 'and it multiplies rows, not columns');
});

test('every compared strategy is one the schema actually allows', () => {
  // Comparing invented strategies would render an error column and teach the
  // user nothing.
  for (const r of compareStrategies(raw(), ds(), 'legs')) {
    assert.equal(r.error, null, `${r.strategy} is not a real strategy`);
  }
});

// ------------------------------------------------- the warnings that matter

test('index-pin without an arity is flagged as sample-dependent', () => {
  // The width comes from whatever message you happened to look at: 3 columns
  // today, and the 4th leg silently dropped tomorrow.
  const p = flattenPreview(raw(), ds({ legs: { strategy: 'index-pin' } }));
  assert.ok(p.warnings.some((w) => /no arity/.test(w)));
});

test('a message exceeding a pinned arity says how many rows would be DROPPED', () => {
  const p = flattenPreview(raw(), ds({ legs: { strategy: 'index-pin', arity: 2 } }));
  assert.ok(p.warnings.some((w) => /1 would be DROPPED/.test(w)), p.warnings.join(' | '));
});

test('an empty array warns that inference from this sample would miss it', () => {
  const p = flattenPreview({ ...raw(), legs: [] }, ds({ legs: { strategy: 'index-pin' } }));
  assert.ok(p.warnings.some((w) => /miss them entirely/.test(w)));
});

test('explode warns that one message becomes several rows', () => {
  const p = flattenPreview(raw(), ds({ legs: { strategy: 'explode', childTable: 'legs' } }));
  assert.ok(p.warnings.some((w) => /3 child rows/.test(w)));
});

test('json-string warns that the column is not sortable as data', () => {
  const p = flattenPreview(raw(), ds({ legs: { strategy: 'json-string' } }));
  assert.ok(p.warnings.some((w) => /not sortable/.test(w)));
});

test('a key column the message does not produce is flagged', () => {
  // Otherwise it surfaces as rows that append instead of updating.
  const d = { ...ds(), keyColumns: ['tradeId'] };
  const p = flattenPreview(raw(), d);
  assert.ok(p.warnings.some((w) => /Key column\(s\) not produced/.test(w)));
});

test('no key columns at all is flagged', () => {
  const p = flattenPreview(raw(), { ...ds(), keyColumns: [] });
  assert.ok(p.warnings.some((w) => /No key columns/.test(w)));
});

// ------------------------------------------------- failure is explained

test('a non-object message is refused with a reason', () => {
  assert.match(flattenPreview('just a string', ds()).error, /JSON object/);
});

test('an unknown strategy surfaces the normalizer error verbatim', () => {
  const p = flattenPreview(raw(), ds({ legs: { strategy: 'vibes' } }));
  assert.match(p.error, /unknown array strategy/);
  assert.deepEqual(p.columns, [], 'and nothing misleading is rendered');
});

test('warnings never throw on a payload that does not match the config', () => {
  // The preview exists to be used on messages that are wrong.
  assert.doesNotThrow(() => warningsFor({}, ds({ legs: { strategy: 'index-pin' } }), []));
});
