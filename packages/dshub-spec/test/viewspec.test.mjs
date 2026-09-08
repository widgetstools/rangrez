import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPerspectiveViewConfig } from '../src/viewspec.mjs';

// ------------------------------------------------- case-folded equality

import { toPerspectiveFilterWithExpressions, ciColumn } from '../src/viewspec.mjs';

test('case-insensitive equality becomes a lower() expression', () => {
  // AG-Grid text filters are case-insensitive by default; Perspective's `==` is
  // not. Typing "govies" instead of "Govies" returned 2,502 rows in CSRM and
  // ZERO in SSRM — same grid, same box, opposite answers.
  const { filter, expressions } = toPerspectiveFilterWithExpressions([
    { column: 'desk', op: 'equalsIgnoreCase', value: 'GoViEs' },
  ]);
  assert.deepEqual(expressions, { [ciColumn('desk')]: 'lower("desk")' });
  assert.deepEqual(filter, [[ciColumn('desk'), '==', 'govies']]);
});

test('case-insensitive inequality folds the same way', () => {
  const { filter } = toPerspectiveFilterWithExpressions([
    { column: 'desk', op: 'notEqualIgnoreCase', value: 'Govies' },
  ]);
  assert.deepEqual(filter, [[ciColumn('desk'), '!=', 'govies']]);
});

test('contains/startsWith/endsWith are left alone', () => {
  // Measured, not assumed: Perspective's substring operators are ALREADY
  // case-insensitive, so folding them would be pointless work.
  const { filter, expressions } = toPerspectiveFilterWithExpressions([
    { column: 'desk', op: 'contains', value: 'ovie' },
  ]);
  assert.deepEqual(expressions, {}, 'no expression column needed');
  assert.deepEqual(filter, [['desk', 'contains', 'ovie']]);
});

test('a quoted column name is escaped in the expression', () => {
  const { expressions } = toPerspectiveFilterWithExpressions([
    { column: 'od"d', op: 'equalsIgnoreCase', value: 'x' },
  ]);
  assert.equal(Object.values(expressions)[0], 'lower("od""d")');
});

test('the view config carries the derived expressions', () => {
  // Without this the filter references a column that is not in the schema and
  // Perspective aborts with "Filter column not in schema".
  const cfg = toPerspectiveViewConfig({
    filter: [{ column: 'desk', op: 'equalsIgnoreCase', value: 'govies' }],
  });
  assert.equal(cfg.expressions[ciColumn('desk')], 'lower("desk")');
  assert.deepEqual(cfg.filter, [[ciColumn('desk'), '==', 'govies']]);
});

test('caller-supplied expressions survive alongside derived ones', () => {
  const cfg = toPerspectiveViewConfig({
    expressions: { mine: '1 + 1' },
    filter: [{ column: 'desk', op: 'equalsIgnoreCase', value: 'x' }],
  });
  assert.equal(cfg.expressions.mine, '1 + 1');
  assert.ok(cfg.expressions[ciColumn('desk')]);
});

// ------------------------------------------------- OR via expressions

import { conditionExpression } from '../src/viewspec.mjs';

test('an OR becomes a computed boolean column', () => {
  // Perspective's `filter` array combines with AND and has no OR, so a
  // quick-filter box — "any of these columns contains this text" — cannot be a
  // list of triples. It used to throw, which meant quick search did not work in
  // SSRM at all.
  const cfg = toPerspectiveViewConfig({
    filter: [{ op: 'or', conditions: [
      { column: 'desk', op: 'contains', value: 'gov' },
      { column: 'trader', op: 'contains', value: 'gov' },
    ] }],
  });
  assert.deepEqual(cfg.filter, [['__or_0', '==', true]]);
  assert.match(cfg.expressions.__or_0, / or /);
  assert.match(cfg.expressions.__or_0, /match\(lower\("desk"\)/);
});

test('regex metacharacters in a search box are LITERAL', () => {
  // Measured: an unescaped "." matched all 20,000 rows; escaped it matches the
  // 0 rows that actually contain a dot. A trader typing punctuation is not
  // writing a regex.
  const e = conditionExpression({ column: 'desk', op: 'contains', value: '.' });
  assert.match(e, /\\\./, 'the dot is escaped');
  for (const meta of ['(', ')', '[', ']', '*', '+', '?', '|', '^', '$', '{', '}']) {
    const ex = conditionExpression({ column: 'c', op: 'contains', value: meta });
    assert.match(ex, /\\/, `"${meta}" was not escaped`);
  }
});

test('a quote in the needle cannot break out of the literal', () => {
  const e = conditionExpression({ column: 'c', op: 'contains', value: "o'brien" });
  assert.match(e, /o\\'brien/);
});

test('negation uses `== false`, which is what Perspective accepts', () => {
  // `not(x)` parses but fails type resolution — it produced "inputs do not
  // resolve to a valid expression" against the real engine.
  assert.match(conditionExpression({ column: 'c', op: 'notContains', value: 'x' }), /== false$/);
  assert.match(conditionExpression({ column: 'c', op: 'notBlank' }), /== false$/);
  assert.doesNotMatch(conditionExpression({ column: 'c', op: 'notContains', value: 'x' }), /\bnot\(/);
});

test('anchors distinguish startsWith, endsWith and contains', () => {
  assert.match(conditionExpression({ column: 'c', op: 'startsWith', value: 'g' }), /'\^g\.\*'/);
  assert.match(conditionExpression({ column: 'c', op: 'endsWith', value: 'g' }), /'\.\*g\$'/);
  assert.match(conditionExpression({ column: 'c', op: 'contains', value: 'g' }), /'\.\*g\.\*'/);
});

test('text comparison is case-folded in the expression path too', () => {
  const e = conditionExpression({ column: 'c', op: 'equals', value: 'GoViEs' });
  assert.match(e, /lower\("c"\) == 'govies'/);
});

test('an empty set inside an OR matches nothing, not everything', () => {
  assert.equal(conditionExpression({ column: 'c', op: 'in', value: [] }), 'false');
});

test('an untranslatable op inside an OR throws rather than silently passing', () => {
  assert.throws(
    () => conditionExpression({ column: 'c', op: 'vibesLike', value: 'x' }),
    (e) => e.code === 'unsupported-expression',
  );
});

test('several ORs get distinct expression columns', () => {
  const cfg = toPerspectiveViewConfig({
    filter: [
      { op: 'or', conditions: [{ column: 'a', op: 'contains', value: '1' }] },
      { op: 'or', conditions: [{ column: 'b', op: 'contains', value: '2' }] },
    ],
  });
  assert.deepEqual(cfg.filter.map((f) => f[0]), ['__or_0', '__or_1']);
});
