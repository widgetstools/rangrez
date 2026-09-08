import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CellSelectionTracker } from '../src/cellSelection.mjs';

/**
 * A stand-in for the loaded window: a key->index map the test mutates to
 * simulate blocks unloading and reloading at different offsets.
 */
function grid(loaded) {
  let map = new Map(loaded.map((k, i) => [k, i]));
  return {
    setWindow: (keysInOrder, startIndex = 0) => {
      map = new Map(keysInOrder.map((k, i) => [k, startIndex + i]));
    },
    keyAtIndex: (i) => { for (const [k, idx] of map) if (idx === i) return k; return null; },
    indexOfKey: (k) => (map.has(k) ? map.get(k) : -1),
  };
}
const range = (startRowIndex, endRowIndex, columns) => ({ startRowIndex, endRowIndex, columns });

// ------------------------------------------------- capture keys, not indices

test('a selection is captured by ROW KEY, not by index', () => {
  const g = grid(['a', 'b', 'c', 'd', 'e']);
  const t = new CellSelectionTracker();
  t.capture(range(1, 3, ['px', 'qty']), g.keyAtIndex);
  assert.deepEqual(t.saved, { anchorKey: 'b', focusKey: 'd', columns: ['px', 'qty'] });
});

test('the same logical cells restore at their NEW indices after a scroll', () => {
  // The whole point: the block reloaded at a different offset, and the range
  // must follow the keys, not stay at the old indices.
  const g = grid(['a', 'b', 'c', 'd', 'e']);
  const t = new CellSelectionTracker();
  t.capture(range(1, 3, ['px']), g.keyAtIndex);        // b..d

  g.setWindow(['b', 'c', 'd', 'e', 'f'], 4200);        // scrolled; b is now index 4200
  const applied = [];
  const r = t.restore({ indexOfKey: g.indexOfKey, setCellRange: (x) => applied.push(x) });

  assert.equal(r.restored, true);
  assert.equal(r.partial, false);
  assert.deepEqual(applied[0], { rowStartIndex: 4200, rowEndIndex: 4202, columns: ['px'] });
});

test('a range captured with columns as AG-Grid column objects reads their colIds', () => {
  const g = grid(['a', 'b']);
  const t = new CellSelectionTracker();
  t.capture({ startRowIndex: 0, endRowIndex: 1, columns: [{ getColId: () => 'px' }, { getColId: () => 'qty' }] }, g.keyAtIndex);
  assert.deepEqual(t.saved.columns, ['px', 'qty']);
});

// ------------------------------------------------- the reconcile cases

test('one endpoint unloaded clamps the range to the visible half', () => {
  // A drag whose far end scrolled off keeps its on-screen part rather than
  // vanishing entirely.
  const g = grid(['a', 'b', 'c', 'd', 'e']);
  const t = new CellSelectionTracker();
  t.capture(range(1, 4, ['px']), g.keyAtIndex);        // b..e

  g.setWindow(['a', 'b', 'c'], 0);                     // e unloaded
  const applied = [];
  const r = t.restore({ indexOfKey: g.indexOfKey, setCellRange: (x) => applied.push(x) });

  assert.equal(r.partial, true);
  assert.deepEqual(applied[0], { rowStartIndex: 1, rowEndIndex: 1, columns: ['px'] },
    'clamped to b, the endpoint still on screen');
});

test('both endpoints unloaded restore nothing but KEEP the keys', () => {
  // They may scroll back; clearing now would lose the selection for good.
  const g = grid(['a', 'b', 'c', 'd', 'e']);
  const t = new CellSelectionTracker();
  t.capture(range(1, 3, ['px']), g.keyAtIndex);        // b..d

  g.setWindow(['x', 'y', 'z'], 0);                     // both gone
  const applied = [];
  const r = t.restore({ indexOfKey: g.indexOfKey, setCellRange: (x) => applied.push(x) });
  assert.equal(r.restored, false);
  assert.equal(applied.length, 0, 'nothing applied');
  assert.ok(t.saved, 'but the keys are held');

  // Scroll back — now it restores.
  g.setWindow(['a', 'b', 'c', 'd', 'e'], 0);
  const again = t.restore({ indexOfKey: g.indexOfKey, setCellRange: (x) => applied.push(x) });
  assert.equal(again.restored, true);
  assert.deepEqual(applied[0], { rowStartIndex: 1, rowEndIndex: 3, columns: ['px'] });
});

test('a reversed selection (focus above anchor) is normalized', () => {
  const g = grid(['a', 'b', 'c', 'd', 'e']);
  const t = new CellSelectionTracker();
  t.capture(range(4, 1, ['px']), g.keyAtIndex);        // dragged upward: e..b
  const applied = [];
  t.restore({ indexOfKey: g.indexOfKey, setCellRange: (x) => applied.push(x) });
  assert.deepEqual(applied[0], { rowStartIndex: 1, rowEndIndex: 4, columns: ['px'] });
});

// ------------------------------------------------- self-restore guard

test('the restore does NOT overwrite the saved selection', () => {
  // restore() sets a cell range, which fires cellSelectionChanged in the real
  // grid. If that re-captured, a partial restore would shrink the selection
  // permanently. The guard prevents it.
  const g = grid(['a', 'b', 'c', 'd', 'e']);
  const t = new CellSelectionTracker();
  t.capture(range(1, 4, ['px']), g.keyAtIndex);        // b..e
  g.setWindow(['a', 'b', 'c'], 0);                     // e off screen

  t.restore({
    indexOfKey: g.indexOfKey,
    setCellRange: () => {
      // Simulate AG-Grid firing the change handler mid-restore.
      t.capture(range(1, 1, ['px']), g.keyAtIndex);
    },
  });
  assert.equal(t.saved.focusKey, 'e', 'the far endpoint is still remembered');
});

test('a genuine user selection after a restore DOES update the saved keys', () => {
  const g = grid(['a', 'b', 'c', 'd', 'e']);
  const t = new CellSelectionTracker();
  t.capture(range(1, 3, ['px']), g.keyAtIndex);
  t.restore({ indexOfKey: g.indexOfKey, setCellRange: () => {} });
  // restoring flag is cleared after restore returns; a real user event now lands.
  t.capture(range(0, 0, ['qty']), g.keyAtIndex);
  assert.deepEqual(t.saved, { anchorKey: 'a', focusKey: 'a', columns: ['qty'] });
});

// ------------------------------------------------- edge cases

test('an empty selection clears the saved state', () => {
  const g = grid(['a', 'b']);
  const t = new CellSelectionTracker();
  t.capture(range(0, 1, ['px']), g.keyAtIndex);
  t.capture(null, g.keyAtIndex);
  assert.equal(t.saved, null);
});

test('capturing a range over rows that are not loaded saves nothing', () => {
  const g = grid(['a', 'b']);
  const t = new CellSelectionTracker();
  t.capture(range(50, 60, ['px']), g.keyAtIndex);      // indices with no nodes
  assert.equal(t.saved, null);
});

test('restore with no saved selection is a no-op', () => {
  const t = new CellSelectionTracker();
  const r = t.restore({ indexOfKey: () => 5, setCellRange: () => { throw new Error('should not apply'); } });
  assert.equal(r.restored, false);
});

test('the tracker counts restores and partials for diagnostics', () => {
  const g = grid(['a', 'b', 'c']);
  const t = new CellSelectionTracker();
  t.capture(range(0, 2, ['px']), g.keyAtIndex);        // a..c
  t.restore({ indexOfKey: g.indexOfKey, setCellRange: () => {} });      // full
  g.setWindow(['a', 'b'], 0);
  t.restore({ indexOfKey: g.indexOfKey, setCellRange: () => {} });      // partial (c gone)
  assert.equal(t.restores, 2);
  assert.equal(t.partials, 1);
});

// ------------------------------------------------- live-feed churn guard

test('isIntact returns true when the current range already covers the saved keys', () => {
  const g = grid(['a', 'b', 'c', 'd', 'e']);
  const t = new CellSelectionTracker();
  t.capture(range(1, 3, ['px']), g.keyAtIndex);        // b..d
  assert.equal(t.isIntact({ startRowIndex: 1, endRowIndex: 3 }, g.keyAtIndex), true);
});

test('isIntact is order-independent — an upward drag still counts as intact', () => {
  const g = grid(['a', 'b', 'c', 'd', 'e']);
  const t = new CellSelectionTracker();
  t.capture(range(1, 3, ['px']), g.keyAtIndex);        // b..d
  assert.equal(t.isIntact({ startRowIndex: 3, endRowIndex: 1 }, g.keyAtIndex), true, 'd..b is the same range');
});

test('isIntact is false when a block scrolled away and the endpoints moved', () => {
  const g = grid(['a', 'b', 'c', 'd', 'e']);
  const t = new CellSelectionTracker();
  t.capture(range(1, 3, ['px']), g.keyAtIndex);        // b..d
  g.setWindow(['b', 'c', 'd'], 4200);                  // b is now at 4200, not 1
  assert.equal(t.isIntact({ startRowIndex: 1, endRowIndex: 3 }, g.keyAtIndex), false,
    'indices 1..3 now hold different keys, so the selection was lost');
});

test('with no saved selection isIntact is trivially true (nothing to protect)', () => {
  const g = grid(['a']);
  const t = new CellSelectionTracker();
  assert.equal(t.isIntact({ startRowIndex: 0, endRowIndex: 0 }, g.keyAtIndex), true);
});
