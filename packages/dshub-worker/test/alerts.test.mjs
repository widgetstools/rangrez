import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertWatcher, alertMessage } from '../src/alerts.mjs';

const rows = (...keys) => keys.map((k) => ({ __key: k, pnl: -1 }));

test('the first feed fires for every already-matching row', () => {
  // A trader subscribing to "PnL < -500k" wants the EXISTING breaches, not just
  // future ones.
  const w = new AlertWatcher();
  const { fired } = w.feed(rows('a', 'b'));
  assert.deepEqual(fired.map((r) => r.__key), ['a', 'b']);
});

test('a row that stays over the line fires ONCE, not every tick', () => {
  // An alert that repeats every tick is noise a trader learns to ignore.
  const w = new AlertWatcher();
  w.feed(rows('a'));
  assert.deepEqual(w.feed(rows('a')).fired, [], 'silent while it stays matched');
  assert.deepEqual(w.feed(rows('a')).cleared, []);
});

test('a row crossing the line fires; coming back clears', () => {
  const w = new AlertWatcher();
  w.feed(rows('a'));
  const t1 = w.feed(rows('a', 'b'));
  assert.deepEqual(t1.fired.map((r) => r.__key), ['b'], 'b just crossed');
  const t2 = w.feed(rows('a'));
  assert.deepEqual(t2.cleared, ['b'], 'b came back inside');
});

test('the fired event carries the whole row, so the alert shows values', () => {
  const w = new AlertWatcher();
  const { fired } = w.feed([{ __key: 'a', pnl: -600000, desk: 'Govies' }]);
  assert.equal(fired[0].pnl, -600000);
  assert.equal(fired[0].desk, 'Govies');
});

test('a row without a key is ignored, not counted as an alert', () => {
  const w = new AlertWatcher();
  assert.deepEqual(w.feed([{ pnl: -1 }]).fired, []);
});

test('activeCount reflects how many rows are currently over the line', () => {
  const w = new AlertWatcher();
  w.feed(rows('a', 'b', 'c'));
  assert.equal(w.activeCount, 3);
  w.feed(rows('a'));
  assert.equal(w.activeCount, 1);
});

test('the wire message names the rule and stamps a time when given', () => {
  const m = alertMessage('r1', { __key: 'a' }, '2026-01-01T00:00:00Z');
  assert.equal(m.type, 'alert');
  assert.equal(m.ruleId, 'r1');
  assert.equal(m.firedAt, '2026-01-01T00:00:00Z');
});
