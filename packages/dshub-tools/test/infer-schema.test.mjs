import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSampler, findUnknownPaths } from '../src/infer-schema.mjs';

/** Sample `n` messages built by `make(i)` and return the inferred artifact. */
function sample(make, n = 50, opts = {}) {
  const s = createSampler({ minNonNullPerLeaf: 20, ...opts });
  for (let i = 0; i < n; i++) s.observe(make(i));
  return { ...s.infer({ datasourceId: 'test' }), progress: s.progress() };
}
const col = (artifact, path) => artifact.columns.find((c) => c.path === path);
const reviewFor = (review, path) => review.filter((r) => r.path === path).map((r) => r.reason);

// ------------------------------------------------- widen, never narrow

test('a column that is whole numbers in the sample is flagged, not silently typed integer', () => {
  // A float column whose sample happens to hold whole numbers becomes an
  // integer and truncates every later value, forever (architecture §4.1).
  const { artifact, review } = sample((i) => ({ id: `P${i}`, qty: i * 10 }));
  assert.equal(col(artifact, 'qty').type, 'integer');
  assert.match(reviewFor(review, 'qty')[0], /whole number/);
});

test('one non-integer anywhere in the sample widens the column to float', () => {
  const { artifact, review } = sample((i) => ({ id: `P${i}`, px: i === 37 ? 1.5 : 2 }));
  assert.equal(col(artifact, 'px').type, 'float');
  assert.deepEqual(reviewFor(review, 'px'), [], 'a confident widening needs no review');
});

// ------------------------------------------------- identifiers stay strings

test('numeric-looking identifiers stay strings', () => {
  // CUSIP / SEDOL / account numbers: turning these into numbers loses leading
  // zeros and precision, and that is a support ticket, not a rounding error.
  const { artifact, review } = sample((i) => ({ id: `P${i}`, account: String(100000 + i) }));
  assert.equal(col(artifact, 'account').type, 'string');
  assert.match(reviewFor(review, 'account')[0], /numeric-looking/);
});

test('a leading zero makes the string case explicit', () => {
  const { artifact, review } = sample((i) => ({ id: `P${i}`, sedol: `0${String(i).padStart(6, '0')}` }));
  assert.equal(col(artifact, 'sedol').type, 'string');
  assert.match(reviewFor(review, 'sedol')[0], /leading zeros/);
});

test('mixed string and number resolves to string, the non-lossy choice', () => {
  const { artifact, review } = sample((i) => ({ id: `P${i}`, ref: i % 2 ? 'A-1' : 42 }));
  assert.equal(col(artifact, 'ref').type, 'string');
  assert.match(reviewFor(review, 'ref')[0], /mixed string and number/);
});

// ------------------------------------------------- all-null and thin samples

test('an all-null column defaults to string and says why', () => {
  // An all-null first batch is not evidence. String is the only type that
  // cannot silently corrupt a later value.
  const { artifact, review } = sample((i) => ({ id: `P${i}`, maturity: null }));
  assert.equal(col(artifact, 'maturity').type, 'string');
  assert.match(reviewFor(review, 'maturity')[0], /never observed non-null/);
});

test('a thinly-observed column is flagged even when the guess looks obvious', () => {
  // First-batch inference is banned in production (§4.1).
  const { artifact, review } = sample((i) => ({ id: `P${i}`, rare: i === 0 ? 1.5 : null }), 50);
  assert.equal(col(artifact, 'rare').type, 'float');
  assert.match(reviewFor(review, 'rare')[0], /only 1 non-null observations/);
});

test('sampling completes on evidence per leaf, not on message count', () => {
  const s = createSampler({ minNonNullPerLeaf: 20 });
  for (let i = 0; i < 1000; i++) s.observe({ id: `P${i}`, rare: i < 5 ? 1 : null });
  const p = s.progress();
  assert.equal(p.complete, false, '1000 messages is not evidence for a rare field');
  assert.deepEqual(p.starved, ['rare']);
});

// ------------------------------------------------- datetime and boolean

test('ISO-8601 becomes datetime only above the threshold, and still needs confirmation', () => {
  const { artifact, review } = sample((i) => ({ id: `P${i}`, ts: `2026-08-31T12:00:0${i % 10}Z` }));
  assert.equal(col(artifact, 'ts').type, 'datetime');
  assert.match(reviewFor(review, 'ts')[0], /confirm before applying/);
});

test('mostly-but-not-quite ISO stays a string', () => {
  const { artifact, review } = sample((i) => ({
    id: `P${i}`, ts: i % 4 === 0 ? 'n/a' : `2026-08-31T12:00:0${i % 10}Z`,
  }));
  assert.equal(col(artifact, 'ts').type, 'string');
  assert.match(reviewFor(review, 'ts')[0], /below the threshold/);
});

test('Y/N becomes boolean only because the observed value set is exactly that', () => {
  const { artifact, review } = sample((i) => ({ id: `P${i}`, active: i % 2 ? 'Y' : 'N' }));
  assert.equal(col(artifact, 'active').type, 'boolean');
  assert.match(reviewFor(review, 'active')[0], /truncated sample/);
});

test('a third value stops it being a boolean', () => {
  const { artifact } = sample((i) => ({ id: `P${i}`, status: ['Y', 'N', 'MAYBE'][i % 3] }));
  assert.equal(col(artifact, 'status').type, 'string');
});

// ------------------------------------------------- cardinality -> filter

test('low cardinality gets a set filter, high cardinality gets search-select', () => {
  const { artifact } = sample((i) => ({
    id: `P${i}`,                       // 50 distinct
    book: ['CMBS', 'RMBS', 'ABS'][i % 3],
  }), 50);
  assert.equal(col(artifact, 'book').filter, 'set');
  assert.ok(artifact.setFilterColumns.includes('book'));
});

test('cardinality past the cap switches to search-select and says why', () => {
  const s = createSampler({ minNonNullPerLeaf: 1 });
  for (let i = 0; i < 20_050; i++) s.observe({ cusip: `CUSIP${i}` });
  const { artifact, review } = s.infer({ datasourceId: 'big' });
  assert.equal(col(artifact, 'cusip').filter, 'search-select');
  assert.match(reviewFor(review, 'cusip').join(' '), /ship the whole list to the browser/);
});

test('numbers get a number filter regardless of cardinality', () => {
  const { artifact } = sample((i) => ({ id: `P${i}`, px: i + 0.5 }));
  assert.equal(col(artifact, 'px').filter, 'number');
});

// ------------------------------------------------- provenance and review gate

test('the artifact records its provenance and is unreviewed by default', () => {
  const { artifact } = sample((i) => ({ id: `P${i}` }), 30);
  assert.equal(artifact.inferredFrom.messageCount, 30);
  assert.equal(artifact.inferredFrom.minNonNullPerLeaf, 20);
  assert.ok(!('reviewedBy' in artifact), 'an artifact is not reviewed until a human says so');
});

test('observed evidence is retained so a reviewer can judge rather than trust', () => {
  const { artifact } = sample((i) => ({ id: `P${i}`, px: i + 0.25 }));
  const px = col(artifact, 'px').observed;
  assert.equal(px.min, 0.25);
  assert.equal(px.maxDecimals, 2);
  assert.ok(px.samples.length > 0);
});

// ------------------------------------------------- schema evolution

test('an unknown path is reported, never silently added', () => {
  // Perspective cannot add a column to a live table; evolution is a rebuild
  // through the admin flow (architecture §4.4).
  const { artifact } = sample((i) => ({ id: `P${i}`, px: i + 0.5 }));
  const unknown = findUnknownPaths({ id: 'P1', px: 1.5, newField: 'surprise' }, artifact);
  assert.deepEqual(unknown, ['newField']);
});

test('nested unknown paths are found too', () => {
  const { artifact } = sample((i) => ({ id: `P${i}`, risk: { dv01: i } }));
  const unknown = findUnknownPaths({ id: 'P1', risk: { dv01: 1, cs01: 2 } }, artifact);
  assert.deepEqual(unknown, ['risk.cs01']);
});

test('a near-unique column is treated as unbounded, not as low-cardinality', () => {
  // Observed cardinality cannot exceed the sample size. 200 messages make a
  // 500k-distinct positionId look like cardinality 200 — and a set filter on
  // that ships half a million values to the browser in production.
  const { artifact, review } = sample((i) => ({ positionId: `P${i}` }), 200);
  const c = col(artifact, 'positionId');
  assert.equal(c.filter, 'search-select', 'must not earn a set filter from a censored sample');
  assert.match(reviewFor(review, 'positionId').join(' '), /cannot bound the real cardinality/);
  assert.ok(!artifact.setFilterColumns.includes('positionId'));
});

test('a genuinely low-cardinality column is unaffected', () => {
  const { artifact } = sample((i) => ({ book: ['CMBS', 'RMBS', 'ABS'][i % 3] }), 200);
  assert.equal(col(artifact, 'book').filter, 'set');
});

test('the ratio needs enough evidence before it fires', () => {
  // With 5 observations everything looks unique; that is not a signal.
  const { artifact } = sample((i) => ({ code: `C${i}` }), 5, { minNonNullPerLeaf: 1 });
  assert.equal(col(artifact, 'code').filter, 'set');
});
