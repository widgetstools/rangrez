/**
 * Upstream reconnect diff (architecture §5.7, Phase 6).
 *
 * ── What goes wrong without it ────────────────────────────────────────────────
 *
 * When the upstream drops and comes back, the adapter re-snapshots: 20,000 rows
 * arrive again and are pushed into the table. Perspective keys on `__key`, so
 * the DATA ends up correct — but every row is written, so `on_update` reports
 * every row as changed, and the provider turns that into a 20,000-row
 * transaction.
 *
 * For CSRM that is a full grid repaint: scroll position jumps, selection is
 * disturbed, and every cell flashes as changed when almost nothing did. On a
 * blotter mid-trade that is worse than the disconnect was.
 *
 * The insight is that a reconnect snapshot is overwhelmingly the SAME data. A
 * desk's book does not turn over during a five-second outage — typically a few
 * hundred rows moved out of twenty thousand. So the fix is to compare rather
 * than to trust: hold the re-snapshot aside, diff it against what the table
 * already has, and emit only the rows that actually differ.
 *
 * ── Why rows can be dropped as well as changed ────────────────────────────────
 *
 * A key present before the outage and absent from the re-snapshot has GONE —
 * closed, or moved out of this subscription's slice. That is the one removal
 * signal this system ever gets for a non-soft-delete feed, because Perspective's
 * on_update never surfaces removals (§8.4). Missing it leaves phantom positions
 * on the blotter that no update will ever clear.
 */

/** Deep-ish equality over the columns a row actually carries. */
function sameRow(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k], bv = b[k];
    if (av === bv) continue;
    // NaN is not equal to itself, but two NaNs in the same cell are not a change.
    if (typeof av === 'number' && typeof bv === 'number' && Number.isNaN(av) && Number.isNaN(bv)) continue;
    if (av instanceof Date && bv instanceof Date && av.getTime() === bv.getTime()) continue;
    return false;
  }
  return true;
}

/**
 * Diff a re-snapshot against what is already held.
 *
 * @param {Map<string, object>} previous  key -> row, as of the disconnect
 * @param {object[]} incoming             the re-snapshot, normalized rows
 * @param {object} [o]
 * @param {string} [o.softDeleteColumn]   how a removal is expressed downstream
 * @returns {{upserts: object[], removals: object[], unchanged: number}}
 */
export function diffSnapshot(previous, incoming, { softDeleteColumn } = {}) {
  const upserts = [];
  const seen = new Set();
  let unchanged = 0;

  for (const row of incoming) {
    const key = row?.__key;
    if (key === undefined || key === null) continue;
    seen.add(key);
    const before = previous.get(key);
    if (before && sameRow(before, row)) { unchanged += 1; continue; }
    upserts.push(row);
  }

  /**
   * Gone from the re-snapshot.
   *
   * Expressed as a soft-delete flip when the datasource has that column,
   * because that is the shape the rest of the system already understands —
   * CSRM turns the flip into an AG-Grid `remove`, and doing anything else here
   * would need a second removal path that nothing downstream reads.
   */
  const removals = [];
  for (const [key, row] of previous) {
    if (seen.has(key)) continue;
    removals.push(softDeleteColumn ? { __key: key, [softDeleteColumn]: true } : { __key: key, __op: 'delete' });
  }

  return { upserts, removals, unchanged };
}

/**
 * Accumulates a re-snapshot off to the side, then emits the diff.
 *
 * Held OUT of the table until complete. Writing rows as they arrive and diffing
 * afterwards would defeat the point — the writes themselves are what produce the
 * repaint this exists to avoid.
 */
export class ReconnectDiffer {
  /**
   * @param {object} o
   * @param {() => Promise<Map<string, object>>} o.snapshotOfTable
   *        Reads the table's current contents. ASYNC because the rows live in
   *        Perspective, not in a mirror kept beside it — a key->row mirror of a
   *        500k-row table would roughly double the memory this system spends
   *        most of its budget defending. The read happens once per reconnect,
   *        in the worker; the repaint it prevents happens in every open tab.
   * @param {string} [o.softDeleteColumn]
   */
  constructor({ snapshotOfTable, softDeleteColumn } = {}) {
    this.snapshotOfTable = snapshotOfTable;
    this.softDeleteColumn = softDeleteColumn;
    this.active = false;
    this.rows = [];
    this.stats = { reconnects: 0, lastUpserts: 0, lastRemovals: 0, lastUnchanged: 0, lastRows: 0 };
  }

  /**
   * A re-snapshot is starting.
   *
   * `previous` is captured HERE rather than at completion: by the time the
   * snapshot ends the table may already have been written by a racing path, and
   * diffing against that would report no change for rows that did change.
   */
  begin() {
    this.active = true;
    this.rows = [];
    /**
     * The read is ISSUED synchronously and awaited later.
     *
     * `Promise.resolve().then(() => read())` looks equivalent but defers the
     * call by a microtask, which is long enough for a write to land first — and
     * then the baseline already contains the change it was supposed to predate.
     * Issuing it here and awaiting in end() lets the read race the incoming
     * snapshot without racing the writes.
     */
    let p;
    try { p = Promise.resolve(this.snapshotOfTable()); }
    catch { p = Promise.resolve(null); }
    this.previousPromise = p.catch(() => null);
    this.stats.reconnects += 1;
  }

  collect(rows) {
    if (!this.active) return false;
    for (const r of rows) if (r) this.rows.push(r);
    return true;
  }

  /** @returns {Promise<{upserts: object[], removals: object[], unchanged: number}>} */
  async end() {
    this.active = false;
    const previous = await this.previousPromise;

    /**
     * If the baseline could not be read, apply the snapshot WHOLE.
     *
     * A failed read must not be mistaken for an empty table: diffing against an
     * empty Map would mark every existing row as removed, emptying the blotter
     * on a reconnect. Repainting is the bad outcome this exists to avoid;
     * deleting the book is a worse one.
     */
    if (!previous) {
      const rows = this.rows;
      this.rows = [];
      this.previousPromise = null;
      this.stats.lastRows = rows.length;
      this.stats.lastUpserts = rows.length;
      this.stats.lastRemovals = 0;
      this.stats.lastUnchanged = 0;
      this.stats.lastDegraded = true;
      return { upserts: rows, removals: [], unchanged: 0, degraded: true };
    }

    const d = diffSnapshot(previous, this.rows, { softDeleteColumn: this.softDeleteColumn });
    this.stats.lastRows = this.rows.length;
    this.stats.lastUpserts = d.upserts.length;
    this.stats.lastRemovals = d.removals.length;
    this.stats.lastUnchanged = d.unchanged;
    this.rows = [];
    this.previousPromise = null;
    this.stats.lastDegraded = false;
    return d;
  }

  abort() { this.active = false; this.rows = []; this.previousPromise = null; }
}
