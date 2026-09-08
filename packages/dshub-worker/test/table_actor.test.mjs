import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TableActor, mergeBatch, toColumnar, STATE } from '../src/table_actor.mjs';

/** Duck-typed Perspective table: records the column blocks it was handed. */
const fakeTable = () => {
  const blocks = [];
  return { blocks, update: (b) => blocks.push(b) };
};

// ------------------------------------------------- dedupe must MERGE

test('two partial patches for one key merge instead of replacing', () => {
  // A dv01 recalc and a price tick in the same batch must both survive.
  // Replacing wholesale silently drops the earlier patch's fields.
  const merged = mergeBatch([
    { __key: 'P1', __op: 'update', risk_dv01: 1234 },
    { __key: 'P1', __op: 'update', price: '99-16' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].risk_dv01, 1234, 'earlier patch field must survive');
  assert.equal(merged[0].price, '99-16');
});

test('later values win per field', () => {
  const merged = mergeBatch([
    { __key: 'P1', __op: 'update', price: '99-16' },
    { __key: 'P1', __op: 'update', price: '99-24' },
  ]);
  assert.equal(merged[0].price, '99-24');
});

test('an update after a delete merges its fields but leaves the row deleted', () => {
  // Deliberately NOT absorbing. Suppressing the update would make the result
  // depend on where the batch boundary fell, which the convergence test forbids.
  // The soft-delete flag carries the delete state; only an insert clears it.
  const merged = mergeBatch([
    { __key: 'P1', __op: 'delete', _deleted: true },
    { __key: 'P1', __op: 'update', price: '99-16' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]._deleted, true, 'still deleted');
  assert.equal(merged[0].price, '99-16', 'field still applied');
});

test('an insert after a delete resurrects the row', () => {
  const merged = mergeBatch([
    { __key: 'P1', __op: 'delete', _deleted: true },
    { __key: 'P1', __op: 'insert', _deleted: false, price: '99-16' },
  ]);
  assert.equal(merged[0]._deleted, false);
});

test('distinct keys are not conflated', () => {
  const merged = mergeBatch([
    { __key: 'P1', __op: 'update', price: 1 },
    { __key: 'P2', __op: 'update', price: 2 },
  ]);
  assert.equal(merged.length, 2);
});

// ------------------------------------------------- columnar grouping

test('homogeneous rows collapse to a single columnar block', () => {
  const blocks = toColumnar([
    { __key: 'P1', __op: 'update', price: 1 },
    { __key: 'P2', __op: 'update', price: 2 },
  ]);
  assert.equal(blocks.length, 1, 'a batch of like ticks is one block');
  assert.deepEqual(blocks[0].price, [1, 2]);
  assert.deepEqual(blocks[0].__key, ['P1', 'P2']);
});

test('heterogeneous partial rows split into one block per column signature', () => {
  // Columnar requires equal-length arrays, so partial patches touching
  // different fields cannot share a block. Padding with null would wipe
  // untouched columns through the merge — the bug this grouping exists to avoid.
  const blocks = toColumnar([
    { __key: 'P1', __op: 'update', price: 1 },
    { __key: 'P2', __op: 'update', risk_dv01: 9 },
  ]);
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    const lengths = Object.values(b).map((a) => a.length);
    assert.ok(lengths.every((l) => l === lengths[0]), 'every column in a block is equal length');
    assert.ok(!('null' in b));
  }
  assert.ok(!blocks.some((b) => 'price' in b && 'risk_dv01' in b), 'signatures must not be merged');
});

test('__op is control metadata and never reaches the table', () => {
  const blocks = toColumnar([{ __key: 'P1', __op: 'update', price: 1 }]);
  assert.ok(!('__op' in blocks[0]));
  assert.ok('__key' in blocks[0]);
});

// ------------------------------------------------- snapshot atomicity

test('a row-count mismatch fails rather than going live', () => {
  // The worst outcome in this system is a trader acting on a partial book.
  const states = [];
  const a = new TableActor({ table: fakeTable(), onState: (s, d) => states.push([s, d]) });
  a.transition(STATE.CONNECTING);
  a.beginSnapshot('buffer');
  const ok = a.endSnapshot({ expectedRows: 500000, actualRows: 412331 });

  assert.equal(ok, false);
  assert.equal(a.state, STATE.FAILED);
  assert.match(states.at(-1)[1], /expected 500000 rows, received 412331/);
});

test('a matching row count goes live and applies the buffered updates', () => {
  const table = fakeTable();
  const a = new TableActor({ table });
  a.transition(STATE.CONNECTING);
  a.beginSnapshot('buffer');

  // Updates arriving mid-snapshot are held, not applied.
  a.push([{ __key: 'P1', __op: 'update', price: 1 }]);
  assert.equal(table.blocks.length, 0, 'nothing reaches the table during a snapshot');

  assert.equal(a.endSnapshot({ expectedRows: 1, actualRows: 1 }), true);
  assert.equal(a.state, STATE.LIVE);
  assert.equal(table.blocks.length, 1, 'buffered updates apply on completion');
});

test('buffered updates are keyed last-write-wins on completion', () => {
  const table = fakeTable();
  const a = new TableActor({ table });
  a.transition(STATE.CONNECTING);
  a.beginSnapshot('buffer');
  a.push([{ __key: 'P1', __op: 'update', price: 1 }]);
  a.push([{ __key: 'P1', __op: 'update', price: 2 }]);
  a.endSnapshot();

  assert.equal(table.blocks.length, 1);
  assert.deepEqual(table.blocks[0].price, [2], 'one row, latest value');
});

// ------------------------------------------------- state machine

test('illegal transitions throw rather than corrupting the published state', () => {
  const a = new TableActor({ table: fakeTable() });
  assert.throws(() => a.transition(STATE.LIVE), /illegal state transition idle -> live/);
});

test('stale is reachable from live and recovers without passing through failed', () => {
  const a = new TableActor({ table: fakeTable() });
  a.transition(STATE.CONNECTING);
  a.transition(STATE.SNAPSHOTTING);
  a.transition(STATE.LIVE);
  a.transition(STATE.STALE);      // upstream lost; keep serving cache
  a.transition(STATE.RECOVERING); // failover is a recovery, not a failure
  a.transition(STATE.LIVE);
  assert.equal(a.state, STATE.LIVE);
});

// ------------------------------------------------- backpressure

test('a full queue refuses the push rather than growing without bound', () => {
  const a = new TableActor({ table: fakeTable(), queueLimit: 2, batch: { maxRows: 1000 } });
  a.transition(STATE.CONNECTING);
  assert.equal(a.push([{ __key: 'P1', __op: 'update' }, { __key: 'P2', __op: 'update' }]), true);
  assert.equal(a.push([{ __key: 'P3', __op: 'update' }]), false, 'over the bound');
  assert.equal(a.dropped, 1);
});

test('a batch flushes once maxRows is reached, without waiting for the timer', () => {
  const table = fakeTable();
  const a = new TableActor({ table, batch: { maxRows: 3, maxMs: 60_000 } });
  a.transition(STATE.CONNECTING);
  for (let i = 0; i < 3; i++) a.push([{ __key: `P${i}`, __op: 'update', price: i }]);
  assert.equal(table.blocks.length, 1, 'flushed on row count, not on the 60s timer');
});

test('conflation ratio reports the compression dedupe achieved', () => {
  const a = new TableActor({ table: fakeTable(), batch: { maxRows: 1000, maxMs: 60_000 } });
  a.transition(STATE.CONNECTING);
  for (let i = 0; i < 10; i++) a.push([{ __key: 'P1', __op: 'update', price: i }]);
  a.flush();
  assert.equal(a.rowsIn, 10);
  assert.equal(a.rowsOut, 1, '10 ticks on one key collapse to 1 write');
  assert.equal(a.conflationRatio, 0.1);
});

test('endSnapshot AWAITS an async engine before going live', async () => {
  // Perspective's update is async. Transitioning while writes are in flight
  // publishes `live` to a provider that then reads an EMPTY table — with no
  // error, because nothing failed.
  let resolveWrite;
  const table = { update: () => new Promise((r) => { resolveWrite = r; }) };

  const states = [];
  const a = new TableActor({ table, onState: (s) => states.push(s) });
  a.transition(STATE.CONNECTING);
  a.beginSnapshot('buffer');
  a.push([{ __key: 'P1', __op: 'update', px: 1 }]);

  const done = a.endSnapshot();
  assert.ok(typeof done.then === 'function', 'async engines yield a promise');
  assert.ok(!states.includes(STATE.LIVE), 'not live while the write is pending');

  resolveWrite();
  assert.equal(await done, true);
  assert.equal(a.state, STATE.LIVE, 'live only after the write settles');
});

test('a synchronous engine still transitions immediately', () => {
  const a = new TableActor({ table: { update: () => {} } });
  a.transition(STATE.CONNECTING);
  a.beginSnapshot('buffer');
  a.push([{ __key: 'P1', __op: 'update' }]);
  assert.equal(a.endSnapshot(), true, 'no promise for a sync engine');
  assert.equal(a.state, STATE.LIVE);
});

test('an engine wrapper that swallows its promise defeats the live gate', () => {
  // Regression: the worker wrapped `t.update(block)` in a block body, returning
  // undefined. flush() then had nothing to await and endSnapshot transitioned
  // synchronously — the async gate was correct but bypassed at the last link.
  let settled = false;
  const swallowing = { update: (b) => { Promise.resolve().then(() => { settled = true; }); } };
  const a = new TableActor({ table: swallowing });
  a.transition(STATE.CONNECTING);
  a.beginSnapshot('buffer');
  a.push([{ __key: 'P1', __op: 'update' }]);

  const done = a.endSnapshot();
  assert.equal(typeof done, 'boolean', 'a swallowed promise looks synchronous');
  assert.equal(a.state, STATE.LIVE);
  assert.equal(settled, false, 'and the write has NOT actually completed');
});
