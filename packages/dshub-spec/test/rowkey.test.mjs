import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeKey, rowKey, KEY_SEPARATOR } from '../src/rowkey.mjs';

// ------------------------------------------------- the separator itself

test('the separator is really U+0001', () => {
  // The guard against the failure that made this a module. The character is
  // invisible in source, so any tool that touches a file containing it as a
  // literal can silently drop it, leaving join(''). If that happens again, this
  // fails instead of the blotter quietly merging two positions.
  assert.equal(KEY_SEPARATOR.charCodeAt(0), 1);
  assert.equal(KEY_SEPARATOR.length, 1);
});

test('composite keys are actually separated', () => {
  const k = encodeKey({ a: 'x', b: 'y' }, ['a', 'b']);
  assert.ok(k.includes(KEY_SEPARATOR), `"${k}" has no separator — joined with nothing`);
});

test('inputs that concatenate identically produce DIFFERENT keys', () => {
  // The concrete failure: two distinct positions sharing one row id, so updates
  // land on the wrong row and a selection acts on something not picked.
  const a = encodeKey({ book: 'CMBS', id: 'P-1' }, ['book', 'id']);
  const b = encodeKey({ book: 'CMBSP', id: '-1' }, ['book', 'id']);
  assert.notEqual(a, b);
});

// ------------------------------------------------- strict encoding

test('a single key column is not decorated', () => {
  assert.equal(encodeKey({ id: 'P1' }, ['id']), 'P1');
});

test('numbers are stringified, so engine and client keys compare equal', () => {
  assert.equal(encodeKey({ id: 7 }, ['id']), '7');
});

test('an incomplete key is null, not a key built from "undefined"', () => {
  // Keying an unaddressable row on the literal "undefined" merges every such
  // row into one.
  assert.equal(encodeKey({ a: 'x' }, ['a', 'b']), null);
  assert.equal(encodeKey({ a: null }, ['a']), null);
  assert.equal(encodeKey({}, []), null);
});

test('a legitimately empty string is still a key', () => {
  assert.equal(encodeKey({ a: '', b: 'y' }, ['a', 'b']), `${KEY_SEPARATOR}y`);
});

// ------------------------------------------------- grid identity

test('rowKey prefers the __key the hub already computed', () => {
  // Agreeing with the hub by construction beats reimplementing the same rule.
  assert.equal(rowKey({ __key: 'from-hub', a: 'x' }, ['a']), 'from-hub');
});

test('rowKey coerces a numeric __key to a string', () => {
  // AG-Grid compares ids by value; 5 and '5' are different ids.
  assert.equal(rowKey({ __key: 5 }, ['id']), '5');
});

test('rowKey falls back to the columns when there is no __key', () => {
  assert.equal(rowKey({ a: 'x', b: 'y' }, ['a', 'b']), `x${KEY_SEPARATOR}y`);
});

test('rowKey always returns a string, never null', () => {
  // AG-Grid requires an id; null would throw deep inside the grid.
  assert.equal(rowKey({}, ['a']), '');
  assert.equal(typeof rowKey({}, []), 'string');
});
