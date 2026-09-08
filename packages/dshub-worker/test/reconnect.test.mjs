import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshot, ReconnectDiffer } from '../src/reconnect.mjs';

const row = (k, px, extra = {}) => ({ __key: k, px, ...extra });
const held = (...rows) => new Map(rows.map((r) => [r.__key, r]));

// ------------------------------------------------- the core claim

test('a re-snapshot of unchanged data produces NO transaction', () => {
  // The whole point. Re-pushing 20,000 identical rows makes Perspective report
  // 20,000 changes, which CSRM turns into a full repaint: scroll jumps,
  // selection disturbed, every cell flashing. On a blotter mid-trade that is
  // worse than the disconnect was.
  const before = held(row('a', 1), row('b', 2), row('c', 3));
  const d = diffSnapshot(before, [row('a', 1), row('b', 2), row('c', 3)]);
  assert.deepEqual(d.upserts, []);
  assert.deepEqual(d.removals, []);
  assert.equal(d.unchanged, 3);
});

test('only the rows that actually moved are emitted', () => {
  const before = held(row('a', 1), row('b', 2), row('c', 3));
  const d = diffSnapshot(before, [row('a', 1), row('b', 99), row('c', 3)]);
  assert.deepEqual(d.upserts.map((r) => r.__key), ['b']);
  assert.equal(d.unchanged, 2);
});

test('a new key is an upsert', () => {
  const d = diffSnapshot(held(row('a', 1)), [row('a', 1), row('d', 4)]);
  assert.deepEqual(d.upserts.map((r) => r.__key), ['d']);
});

// ------------------------------------------------- removals

test('a key missing from the re-snapshot is REMOVED', () => {
  // This is the only removal signal a non-soft-delete feed ever gives: an
  // outage can hide a position closing, and on_update never surfaces removals.
  // Missing it leaves a phantom position no update will ever clear.
  const d = diffSnapshot(held(row('a', 1), row('gone', 2)), [row('a', 1)]);
  assert.deepEqual(d.removals.map((r) => r.__key), ['gone']);
});

test('a removal is expressed as the soft-delete flip when there is one', () => {
  // The shape the rest of the system already understands — CSRM turns the flip
  // into an AG-Grid `remove`. Anything else would need a second removal path
  // nothing downstream reads.
  const d = diffSnapshot(held(row('gone', 1)), [], { softDeleteColumn: '_deleted' });
  assert.deepEqual(d.removals, [{ __key: 'gone', _deleted: true }]);
});

test('without a soft-delete column the removal is still typed', () => {
  const d = diffSnapshot(held(row('gone', 1)), []);
  assert.equal(d.removals[0].__op, 'delete');
});

// ------------------------------------------------- comparison correctness

test('a field appearing or disappearing counts as a change', () => {
  assert.equal(diffSnapshot(held(row('a', 1)), [{ __key: 'a', px: 1, extra: 9 }]).upserts.length, 1);
  assert.equal(diffSnapshot(held({ __key: 'a', px: 1, extra: 9 }), [row('a', 1)]).upserts.length, 1);
});

test('two NaNs in a cell are not a change', () => {
  // NaN !== NaN, so a naive compare reports every NaN-bearing row as changed on
  // every reconnect — which for a risk column is most of the book.
  const d = diffSnapshot(held(row('a', NaN)), [row('a', NaN)]);
  assert.equal(d.upserts.length, 0);
});

test('equal Dates are not a change', () => {
  const t = 1_700_000_000_000;
  const d = diffSnapshot(held(row('a', 1, { at: new Date(t) })), [row('a', 1, { at: new Date(t) })]);
  assert.equal(d.upserts.length, 0);
});

test('a row without a key is skipped rather than crashing the diff', () => {
  const d = diffSnapshot(held(row('a', 1)), [row('a', 1), { px: 5 }, null]);
  assert.equal(d.unchanged, 1);
  assert.deepEqual(d.upserts, []);
});

// ------------------------------------------------- the accumulator

function differ(tableRows) {
  const table = held(...tableRows);
  return new ReconnectDiffer({ snapshotOfTable: async () => table, softDeleteColumn: '_deleted' });
}

test('rows are held OUT of the table until the re-snapshot completes', async () => {
  // Writing them as they arrive and diffing afterwards defeats the point: the
  // writes themselves are what cause the repaint.
  const d = differ([row('a', 1)]);
  d.begin();
  d.collect([row('a', 1), row('b', 2)]);
  assert.equal(d.rows.length, 2, 'buffered, not applied');
  const out = await d.end();
  assert.deepEqual(out.upserts.map((r) => r.__key), ['b']);
});

test('the baseline read STARTS at begin, not at end', async () => {
  // By the time the snapshot completes the table may have been written by a
  // racing path; reading then would report no change for rows that changed.
  let table = held(row('a', 1));
  const d = new ReconnectDiffer({ snapshotOfTable: async () => table });
  d.begin();
  table = held(row('a', 99));                 // something else wrote meanwhile
  d.collect([row('a', 99)]);
  const out = await d.end();
  assert.deepEqual(out.upserts.map((r) => r.__key), ['a'], 'still reported against the pre-outage state');
});

test('collect is inert when no reconnect is in progress', () => {
  const d = differ([]);
  assert.equal(d.collect([row('a', 1)]), false);
  assert.equal(d.rows.length, 0);
});

test('abort discards the buffer without emitting', () => {
  const d = differ([row('a', 1)]);
  d.begin();
  d.collect([row('b', 2)]);
  d.abort();
  assert.equal(d.rows.length, 0);
  assert.equal(d.active, false);
});

test('the saving is reported, so the claim is checkable in the console', async () => {
  const d = differ([row('a', 1), row('b', 2), row('c', 3)]);
  d.begin();
  d.collect([row('a', 1), row('b', 2), row('c', 99)]);
  await d.end();
  assert.deepEqual(
    { rows: d.stats.lastRows, upserts: d.stats.lastUpserts, unchanged: d.stats.lastUnchanged },
    { rows: 3, upserts: 1, unchanged: 2 },
  );
});

test('a baseline that cannot be read applies the snapshot WHOLE', async () => {
  // A failed read must not be mistaken for an empty table: diffing against an
  // empty Map marks every existing row as removed and empties the blotter.
  // Repainting is the bad outcome this exists to avoid; deleting the book is a
  // worse one.
  const d = new ReconnectDiffer({ snapshotOfTable: async () => { throw new Error('table gone'); } });
  d.begin();
  d.collect([row('a', 1), row('b', 2)]);
  const out = await d.end();
  assert.equal(out.degraded, true);
  assert.equal(out.upserts.length, 2, 'applied whole');
  assert.deepEqual(out.removals, [], 'and nothing deleted');
});
