import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WriteManager, STATUS } from '../src/writePath.mjs';

function make(over = {}) {
  let t = 0;
  const sent = [];
  const wm = new WriteManager({ send: (c) => sent.push(c), timeoutMs: 1000, now: () => t, ...over });
  wm.advance = (ms) => { t += ms; };
  wm.sent = sent;
  return wm;
}

// ------------------------------------------------- optimistic apply

test('submit applies optimistically and sends a command with an idempotency key', () => {
  const wm = make();
  const { idempotencyKey, value } = wm.submit({ ref: { datasourceId: 'p' }, key: 'POS-1', field: 'note', value: 'watch', currentValue: '' });
  assert.equal(value, 'watch', 'the caller shows this immediately');
  assert.equal(wm.overlay('POS-1', 'note'), 'watch', 'and it overlays the cell');
  assert.equal(wm.status('POS-1', 'note'), STATUS.PENDING);
  assert.equal(wm.sent[0].type, 'command');
  assert.equal(wm.sent[0].idempotencyKey, idempotencyKey);
  assert.equal(wm.sent[0].payload.value, 'watch');
});

test('a cell with no pending write has no overlay and no status', () => {
  const wm = make();
  assert.equal(wm.overlay('POS-9', 'note'), undefined);
  assert.equal(wm.status('POS-9', 'note'), null);
});

// ------------------------------------------------- confirm

test('an echo carrying our value CONFIRMS and clears the marker', () => {
  const wm = make();
  wm.submit({ ref: {}, key: 'POS-1', field: 'note', value: 'watch', currentValue: '' });
  const out = wm.reconcileEcho('POS-1', { note: 'watch' });
  assert.equal(out[0].status, STATUS.CONFIRMED);
  assert.equal(wm.status('POS-1', 'note'), null, 'marker cleared');
  assert.equal(wm.overlay('POS-1', 'note'), undefined, 'the feed value now shows');
});

test('applied result keeps the marker pending until the echo lands', () => {
  // The hub accepting the command is not the same as the value being confirmed;
  // the server may still adjust it.
  const wm = make();
  const { idempotencyKey } = wm.submit({ ref: {}, key: 'POS-1', field: 'px', value: 101, currentValue: 100 });
  const r = wm.onResult({ idempotencyKey, outcome: 'applied' });
  assert.equal(r.action, 'await-echo');
  assert.equal(wm.status('POS-1', 'px'), STATUS.PENDING, 'still pending until the echo');
  wm.reconcileEcho('POS-1', { px: 101 });
  assert.equal(wm.status('POS-1', 'px'), null);
});

// ------------------------------------------------- diverge

test('an echo with a DIFFERENT value diverges; authoritative wins silently', () => {
  // The server adjusted the order; the real value is not an error, it is the
  // answer, and the feed already delivered it.
  const wm = make();
  wm.submit({ ref: {}, key: 'POS-1', field: 'px', value: 101, currentValue: 100 });
  const out = wm.reconcileEcho('POS-1', { px: 100.5 });
  assert.equal(out[0].status, STATUS.DIVERGED);
  assert.equal(wm.status('POS-1', 'px'), null, 'marker cleared — the feed value stands');
});

// ------------------------------------------------- reject

test('a rejected result rolls the cell back and surfaces it', () => {
  // A silently-dropped order is the one failure a trader must never have.
  const wm = make();
  const { idempotencyKey } = wm.submit({ ref: {}, key: 'POS-1', field: 'note', value: 'sell', currentValue: 'hold' });
  const r = wm.onResult({ idempotencyKey, outcome: 'rejected', detail: 'desk closed' });
  assert.equal(r.action, 'rolled-back');
  assert.deepEqual(r.restore, { key: 'POS-1', field: 'note', value: 'hold' });
  assert.equal(wm.status('POS-1', 'note'), null);
});

// ------------------------------------------------- timeout

test('an unreconciled write times out and rolls back', () => {
  // The ambiguous case the idempotency key exists for: it MIGHT have applied,
  // so the display rolls back but a retry cannot double-apply.
  const wm = make();
  wm.submit({ ref: {}, key: 'POS-1', field: 'note', value: 'x', currentValue: '' });
  assert.deepEqual(wm.tick(), [], 'not yet');
  wm.advance(1500);
  const restored = wm.tick();
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0], { key: 'POS-1', field: 'note', value: '', idempotencyKey: restored[0].idempotencyKey });
  assert.equal(wm.timedOut, 1);
});

test('an echo just before the timeout wins the race — no rollback', () => {
  const wm = make();
  wm.submit({ ref: {}, key: 'POS-1', field: 'note', value: 'x', currentValue: '' });
  wm.advance(900);
  wm.reconcileEcho('POS-1', { note: 'x' });     // confirmed at 900ms
  wm.advance(500);                               // now past 1000ms
  assert.deepEqual(wm.tick(), [], 'a confirmed write does not time out');
});

// ------------------------------------------------- supersede

test('a second edit to the same cell supersedes the first', () => {
  const wm = make();
  wm.submit({ ref: {}, key: 'POS-1', field: 'note', value: 'first', currentValue: '' });
  wm.submit({ ref: {}, key: 'POS-1', field: 'note', value: 'second', currentValue: '' });
  assert.equal(wm.overlay('POS-1', 'note'), 'second', 'only the latest shows');
  assert.equal(wm.pendingCount, 1, 'the superseded write no longer counts as pending');
});

test('an echo confirming a superseded write does not resurrect it', () => {
  const wm = make();
  wm.submit({ ref: {}, key: 'POS-1', field: 'note', value: 'first', currentValue: '' });
  wm.submit({ ref: {}, key: 'POS-1', field: 'note', value: 'second', currentValue: '' });
  wm.reconcileEcho('POS-1', { note: 'second' });
  assert.equal(wm.status('POS-1', 'note'), null);
  assert.equal(wm.overlay('POS-1', 'note'), undefined);
});

// ------------------------------------------------- isolation

test('an echo on one field leaves a pending write on another field alone', () => {
  const wm = make();
  wm.submit({ ref: {}, key: 'POS-1', field: 'note', value: 'x', currentValue: '' });
  wm.reconcileEcho('POS-1', { px: 102 });        // a live tick on a different field
  assert.equal(wm.status('POS-1', 'note'), STATUS.PENDING, 'the note edit is untouched');
});

test('an echo on a different row does not touch this row', () => {
  const wm = make();
  wm.submit({ ref: {}, key: 'POS-1', field: 'note', value: 'x', currentValue: '' });
  wm.reconcileEcho('POS-2', { note: 'x' });
  assert.equal(wm.status('POS-1', 'note'), STATUS.PENDING);
});

// ------------------------------------------------- retry safety

test('the idempotency key is stable per write and echoed in the command', () => {
  const wm = make();
  const { idempotencyKey } = wm.submit({ ref: {}, key: 'POS-1', field: 'note', value: 'x', currentValue: '' });
  assert.equal(wm.sent[0].idempotencyKey, idempotencyKey, 'so a hub can dedup a retry');
});

test('an idempotent duplicate result is treated like applied — await the echo', () => {
  const wm = make();
  const { idempotencyKey } = wm.submit({ ref: {}, key: 'POS-1', field: 'note', value: 'x', currentValue: '' });
  assert.equal(wm.onResult({ idempotencyKey, outcome: 'duplicate' }).action, 'await-echo');
  assert.equal(wm.status('POS-1', 'note'), STATUS.PENDING);
});

// ------------------------------------------------- housekeeping

test('prune drops settled writes but keeps pending ones', () => {
  const wm = make();
  wm.submit({ ref: {}, key: 'POS-1', field: 'a', value: 1, currentValue: 0 });
  const { idempotencyKey } = wm.submit({ ref: {}, key: 'POS-2', field: 'b', value: 2, currentValue: 0 });
  wm.onResult({ idempotencyKey, outcome: 'rejected' });     // POS-2 settled
  wm.prune();
  assert.equal(wm.writes.size, 1, 'the settled write is gone');
  assert.equal(wm.status('POS-1', 'a'), STATUS.PENDING, 'the pending one remains');
});

test('a result for an unknown key is ignored, not an error', () => {
  const wm = make();
  assert.equal(wm.onResult({ idempotencyKey: 'never-seen', outcome: 'applied' }).action, 'ignored');
});
