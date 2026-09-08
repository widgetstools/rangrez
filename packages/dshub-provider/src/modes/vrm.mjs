/**
 * VRM mode — viewport row model.
 *
 * The server knows exactly which rows are on screen. AG-Grid hands us a range;
 * we fill it by absolute index. There are no blocks, no per-node stores and no
 * routes — the grid indexes into ONE flat list.
 *
 * ── Why this mode exists here (architecture §8.2, Phase 0) ────────────────────
 *
 * Perspective's expanded tree ALREADY IS that flat list: `__ROW_PATH__` comes
 * back as [[], ["ABS"], ["ABS","Broker 10"], …] with stable contiguous indices,
 * `set_depth` controls levels, and expand/collapse take a row index. That is
 * exactly what setViewportRange wants, so the impedance mismatch is close to
 * zero.
 *
 * The economics against SSRM, measured at the size that matters (findings §17,
 * 500k x 160 — the 20k numbers this originally quoted did not survive):
 *
 *   grouped view creation   ~2.5 SECONDS   per expanded node
 *   50 grouped views        +1,055 MB      on a 1,184 MB table
 *
 * The ingest-throughput argument is retracted: at 500k, holding 50 views costs
 * 1.05x, not the 3.3x measured at 20k. What actually disqualifies SSRM for
 * grouped views is a multi-second stall on every expand and a gigabyte of view
 * memory against a ~3.8 GB ceiling.
 *
 * SSRM holds one such view PER EXPANDED NODE, continuously. VRM holds ONE for
 * the whole tree. That is the entire argument.
 *
 * VRM's own reads are ~12 ms warm but ~495 ms for the FIRST read of a fresh
 * tree, so the first expansion is not free either.
 *
 * The costs are real and worth stating: you render the tree column yourself
 * from `__ROW_PATH__` instead of getting AG-Grid's native grouping UI, selection
 * semantics differ, and the community answer base is far thinner.
 */

/** Indenting tree cell renderer for `__ROW_PATH__`. */
export function treeCellRenderer({ onToggle } = {}) {
  return class {
    init(params) {
      const path = params.data?.__ROW_PATH__ ?? [];
      const depth = Math.max(0, path.length - 1);
      const isLeaf = params.data?.__isLeaf === true;

      const e = document.createElement('span');
      e.style.display = 'inline-flex';
      e.style.alignItems = 'center';
      e.style.paddingLeft = `${depth * 16}px`;

      if (!isLeaf) {
        const caret = document.createElement('span');
        caret.textContent = params.data?.__expanded ? '▾' : '▸';
        caret.style.cssText = 'cursor:pointer;width:14px;opacity:.7;user-select:none';
        caret.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onToggle?.(params.node.rowIndex, params.data);
        });
        e.appendChild(caret);
      } else {
        const spacer = document.createElement('span');
        spacer.style.width = '14px';
        e.appendChild(spacer);
      }

      const label = document.createElement('span');
      label.textContent = path.length ? String(path[path.length - 1]) : '(all)';
      if (!isLeaf) label.style.fontWeight = '600';
      e.appendChild(label);
      this.eGui = e;
    }
    getGui() { return this.eGui; }
  };
}

export class VrmMode {
  /**
   * @param {object} o
   * @param {object} o.dataService  hub-backed service (openView/readWindow/expandRow)
   * @param {object} o.artifact
   * @param {object} o.viewSpec     the tree: { groupBy, aggregates, depth }
   * @param {number} [o.bufferRows] rows fetched either side of the viewport
   */
  constructor({ dataService, artifact, viewSpec, bufferRows = 50, refreshMs = 250,
                setTimer = (fn, ms) => setTimeout(fn, ms) }) {
    this.mode = 'vrm';
    this.dataService = dataService;
    this.artifact = artifact;
    this.viewSpec = viewSpec ?? {};
    this.bufferRows = bufferRows;

    this.handle = null;
    this.rowCount = 0;
    this.range = { first: 0, last: 0 };
    this.params = null;
    this.fetches = 0;
    this.pushes = 0;
    this.refreshes = 0;
    this.refreshMs = refreshMs;
    this.setTimer = setTimer;
    this.refreshTimer = null;
    this.pendingRefresh = false;
    /**
     * Expansion is DERIVED from the data, not tracked in a Set.
     *
     * Perspective's grouped view is fully expanded by default, so a Set that
     * starts empty immediately disagrees with reality — every caret renders
     * collapsed and the first click calls expand() on an already-expanded node,
     * which does nothing. Indices also shift on every toggle, so any index-keyed
     * state is stale the moment it is useful.
     *
     * In a flat indexed tree the answer is already there: a row is expanded iff
     * the NEXT row sits deeper than it does.
     */
    this.rowsByIndex = new Map();
  }

  /** @returns {object} an IViewportDatasource */
  datasource() {
    return {
      init: (params) => { this.params = params; this.start(); },
      setViewportRange: (first, last) => this.setViewportRange(first, last),
      destroy: () => this.destroy(),
    };
  }

  async start() {
    this.handle = await this.dataService.openView(this.viewSpec);
    const { rowCount } = await this.dataService.readWindow(this.handle, { startRow: 0, endRow: 1 });
    this.rowCount = rowCount;
    this.params.setRowCount(rowCount);
    await this.fill(this.range.first, this.range.last);
  }

  setViewportRange(first, last) {
    this.range = { first, last };
    return this.fill(first, last);
  }

  /**
   * Fill a range by ABSOLUTE INDEX.
   *
   * A buffer either side means a small scroll does not immediately trigger
   * another round trip; the grid re-requests the range constantly while
   * scrolling.
   */
  async fill(first, last) {
    if (!this.handle) return;
    const start = Math.max(0, first - this.bufferRows);
    const end = Math.min(this.rowCount, last + 1 + this.bufferRows);
    if (end <= start) return;

    this.fetches++;
    const { rows } = await this.dataService.readWindow(this.handle, { startRow: start, endRow: end });

    // setRowData takes a map keyed by absolute index — not an array.
    const block = {};
    rows.forEach((r, i) => {
      const idx = start + i;
      const path = r.__ROW_PATH__ ?? [];
      const nextPath = rows[i + 1]?.__ROW_PATH__;
      block[idx] = {
        ...r,
        __index: idx,
        __isLeaf: !this.isGroupRow(path),
        // Expanded iff the next row is deeper. The last row of a window has no
        // next row, so it falls back to "not expanded" — a one-row-per-window
        // inaccuracy that corrects itself on the next fetch.
        __expanded: Array.isArray(nextPath) ? nextPath.length > path.length : false,
      };
      this.rowsByIndex.set(idx, block[idx]);
    });
    this.params.setRowData(block);
    this.pushes++;
  }

  /**
   * A row is a group if the tree has more levels below its path depth.
   * With `groupBy: [a, b]`, a path of length 1 is a group and length 2 a leaf.
   */
  isGroupRow(path) {
    const levels = this.viewSpec.groupBy?.length ?? 0;
    return path.length < levels;
  }

  /**
   * Expand or collapse IN PLACE — one view, mutated, for the whole tree.
   *
   * Direction comes from what the row currently IS, not from remembered state:
   * Perspective's tree arrives fully expanded, so a Set starting empty would
   * disagree with reality on the very first click.
   *
   * The row count changes, so the grid is told BEFORE the refill; leaving it
   * stale lets the viewport scroll into indices that no longer exist.
   */
  async toggle(index, hint) {
    if (!this.handle) return;
    const row = hint ?? this.rowsByIndex.get(index);
    const collapse = row?.__expanded === true;

    const { rowCount } = await this.dataService.expandRow(this.handle, index, collapse);

    // Every index below the toggled row has shifted; cached rows are now wrong.
    for (const i of [...this.rowsByIndex.keys()]) if (i > index) this.rowsByIndex.delete(i);

    this.rowCount = rowCount;
    this.params.setRowCount(rowCount);
    await this.fill(this.range.first, this.range.last);
    return { collapsed: collapse, rowCount };
  }

  /**
   * Live updates: refresh ONLY what is on screen.
   *
   * This is VRM's entire reason for existing. A grouped tree's aggregates change
   * on every tick, but the user is looking at ~40 rows — so refreshing the
   * viewport is the whole job, and no other row model can express that.
   *
   * COALESCED. At the feed's ~2,000 rows/sec a naive refresh-per-delta would
   * issue thousands of window reads a second and starve the engine; one read per
   * interval delivers the same picture.
   */
  onUpstreamChange() {
    this.pendingRefresh = true;
    if (this.refreshTimer !== null) return;
    this.refreshTimer = this.setTimer(async () => {
      this.refreshTimer = null;
      if (!this.pendingRefresh || !this.handle) return;
      this.pendingRefresh = false;
      try { await this.refreshViewport(); } catch { /* a dropped tick is not fatal */ }
    }, this.refreshMs);
    if (this.refreshTimer && typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();
  }

  async refreshViewport() {
    if (!this.handle) return;
    const { rowCount } = await this.dataService.readWindow(this.handle, { startRow: 0, endRow: 1 });
    if (rowCount !== this.rowCount) {
      this.rowCount = rowCount;
      // keepRenderedRows — without it the grid blinks on every tick.
      this.params.setRowCount(rowCount, true);
    }
    this.refreshes++;
    await this.fill(this.range.first, this.range.last);
  }

  /** Feed hub `rowDelta` events straight in. */
  attach(control) {
    this.detach = control.on('rowDelta', () => this.onUpstreamChange());
    return this.detach;
  }

  async destroy() {
    this.detach?.();
    if (this.refreshTimer !== null) { this.refreshTimer = null; }
    if (this.handle) { await this.dataService.disposeView(this.handle); this.handle = null; }
    this.rowsByIndex.clear();
  }
}
