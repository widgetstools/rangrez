/**
 * Cell-selection persistence across SSRM block loads (Phase 8g, parity §4).
 *
 * ── Why this is needed ────────────────────────────────────────────────────────
 *
 * AG-Grid tracks a cell range by ROW INDEX. In CSRM every row is loaded, so an
 * index is stable and the range survives. In SSRM the grid loads blocks on
 * demand and DISCARDS them as you scroll away (`maxBlocksInCache`), so the row
 * at index 4,200 is a different node — or no node — a moment later. Drag a
 * selection past the viewport and it evaporates: the range's endpoints point at
 * indices whose nodes were recycled.
 *
 * The fix is to anchor the selection to ROW KEYS, which are stable, and to
 * reconcile back to indices whenever blocks (re)load. This module is the pure
 * half: capture a range as keys, and rebuild the index range from keys. It knows
 * nothing about AG-Grid — the grid API is passed in as small functions — so the
 * reconciliation, which is where the bugs live, is testable in Node.
 *
 * ── Two hazards a live feed adds ──────────────────────────────────────────────
 *
 * The blotter is streaming, so `onModelUpdated` fires many times a second. If a
 * restore ran on every one of those, it would clear and re-add the range
 * constantly — which fights an in-progress mouse drag (the range snaps back a
 * tick, so only a few cells ever select) and churns the grid needlessly. Two
 * guards prevent that: never restore while a drag is in progress, and never
 * restore a selection that is already intact.
 *
 * ── The reconcile cases ───────────────────────────────────────────────────────
 *
 *   both endpoints loaded   → restore at their CURRENT indices (which may have
 *                             shifted since capture — that is the whole point)
 *   one endpoint unloaded   → clamp the range to the endpoint still on screen,
 *                             so a partial drag keeps the visible half
 *   both unloaded           → keep the saved keys, restore NOTHING now; they may
 *                             scroll back into a later block load
 */

export class CellSelectionTracker {
  constructor() {
    /** { anchorKey, focusKey, columns:string[] } or null. */
    this.saved = null;
    /** Guards against capturing our own restore as if it were a user action. */
    this.restoring = false;
    this.restores = 0;
    this.partials = 0;
  }

  /**
   * Record the current selection, keyed by row.
   *
   * Called from `cellSelectionChanged`. `range` is the primary cell range;
   * `keyAtIndex(i)` returns the row key at a grid index, or null if that row is
   * not loaded.
   *
   * A change we caused (restore) is ignored: capturing it would let a partial
   * restore overwrite the full selection the user actually made.
   */
  capture(range, keyAtIndex) {
    if (this.restoring) return;
    if (!range || range.startRowIndex == null || range.endRowIndex == null) { this.saved = null; return; }

    const anchorKey = keyAtIndex(range.startRowIndex);
    const focusKey = keyAtIndex(range.endRowIndex);
    if (anchorKey == null && focusKey == null) { this.saved = null; return; }

    this.saved = {
      anchorKey,
      focusKey,
      columns: (range.columns ?? []).map((c) => (typeof c === 'string' ? c : c.getColId?.() ?? c.colId)),
    };
  }

  /**
   * Rebuild the index range from the saved keys.
   *
   * `indexOfKey(key)` returns the current grid index of a row, or -1 if it is not
   * loaded. Returns the range to apply, or null when nothing can be restored yet.
   *
   * @returns {{startRowIndex:number, endRowIndex:number, columns:string[], partial:boolean}|null}
   */
  plan(indexOfKey) {
    if (!this.saved) return null;
    const a = this.saved.anchorKey == null ? -1 : indexOfKey(this.saved.anchorKey);
    const f = this.saved.focusKey == null ? -1 : indexOfKey(this.saved.focusKey);

    // Both gone: hold the keys, restore nothing — they may come back on a later
    // block load, and clearing now would lose the selection for good.
    if (a < 0 && f < 0) return null;

    // One gone: clamp to the endpoint still on screen. A drag whose far end
    // scrolled out keeps its visible half rather than vanishing entirely.
    const start = a < 0 ? f : a;
    const end = f < 0 ? a : f;
    const partial = a < 0 || f < 0;

    return {
      startRowIndex: Math.min(start, end),
      endRowIndex: Math.max(start, end),
      columns: this.saved.columns,
      partial,
    };
  }

  /**
   * Reconcile: compute the plan and apply it through the grid functions.
   *
   * @param {object} api
   * @param {(key:string)=>number} api.indexOfKey
   * @param {(range:object)=>void}  api.setCellRange   replace the current range
   * @returns {{restored:boolean, partial:boolean}}
   */
  restore({ indexOfKey, setCellRange }) {
    const p = this.plan(indexOfKey);
    if (!p) return { restored: false, partial: false };

    this.restoring = true;
    try {
      setCellRange({
        rowStartIndex: p.startRowIndex,
        rowEndIndex: p.endRowIndex,
        columns: p.columns,
      });
    } finally {
      this.restoring = false;
    }
    this.restores += 1;
    if (p.partial) this.partials += 1;
    return { restored: true, partial: p.partial };
  }

  /**
   * Is the CURRENT on-screen range already the saved selection?
   *
   * The restore must be a no-op on a live tick that did not disturb the range —
   * without this, every feed update clears and re-adds the range, which fights an
   * in-progress mouse drag and makes selection feel sluggish and capped. Only a
   * genuine loss (a scrolled-away block) should trigger a rebuild.
   */
  isIntact(currentRange, keyAtIndex) {
    if (!this.saved) return true;
    if (!currentRange || currentRange.startRowIndex == null) return false;
    const a = keyAtIndex(currentRange.startRowIndex);
    const f = keyAtIndex(currentRange.endRowIndex);
    return (a === this.saved.anchorKey && f === this.saved.focusKey)
      || (a === this.saved.focusKey && f === this.saved.anchorKey);
  }

  /** A user cleared the selection (e.g. clicked a single cell then away). */
  clear() { this.saved = null; }
}

/**
 * Wire the tracker to an AG-Grid API. Kept out of the class so the class stays
 * engine-free; this is the ~30 lines that touch AG-Grid.
 *
 * @param {object} gridApi
 * @param {(data:object)=>string} getRowKey  row data -> stable key
 * @returns {{tracker, onCellSelectionChanged, onBlocksLoaded, bindDrag, isDragging}}
 */
export function attachCellSelection(gridApi, getRowKey) {
  const tracker = new CellSelectionTracker();
  /**
   * True while the user is dragging a range. Restoring mid-drag would clear the
   * range the user is actively extending, snapping it back a tick — the cause of
   * the "only a few cells select" bug. Driven by native mouse events on the grid
   * body, because AG-Grid's drag events are for columns/rows, not cell ranges.
   */
  let dragging = false;

  const keyAtIndex = (i) => {
    const node = gridApi.getDisplayedRowAtIndex?.(i);
    return node?.data ? getRowKey(node.data) : null;
  };
  const indexOfKey = (key) => {
    let found = -1;
    gridApi.forEachNode?.((node) => {
      if (found === -1 && node?.data && getRowKey(node.data) === key) found = node.rowIndex ?? -1;
    });
    return found;
  };
  const currentRange = () => {
    const r = (gridApi.getCellRanges?.() ?? [])[0];
    return r && { startRowIndex: r.startRow?.rowIndex, endRowIndex: r.endRow?.rowIndex };
  };

  const onCellSelectionChanged = () => {
    const ranges = gridApi.getCellRanges?.() ?? [];
    const r = ranges[0];
    tracker.capture(r && {
      startRowIndex: r.startRow?.rowIndex,
      endRowIndex: r.endRow?.rowIndex,
      columns: r.columns,
    }, keyAtIndex);
  };

  const onBlocksLoaded = () => {
    if (dragging) return;                                          // never fight a live drag
    if (tracker.isIntact(currentRange(), keyAtIndex)) return;      // and never churn a fine selection
    tracker.restore({
      indexOfKey,
      setCellRange: (range) => {
        gridApi.clearCellSelection?.();
        gridApi.addCellRange?.(range);
      },
    });
  };

  /** Bind drag tracking to the grid's root element (call after createGrid). */
  const bindDrag = (el) => {
    if (!el) return;
    el.addEventListener('mousedown', () => { dragging = true; }, true);
    // mouseup can land off-grid (drag released elsewhere), so listen on the window.
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      onCellSelectionChanged();     // capture the final range the drag produced
      onBlocksLoaded();             // reconcile once, now the drag is done
    }, true);
  };

  return { tracker, onCellSelectionChanged, onBlocksLoaded, bindDrag, isDragging: () => dragging };
}
