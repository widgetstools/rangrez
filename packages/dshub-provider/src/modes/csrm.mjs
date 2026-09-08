/**
 * CSRM mode — client-side row model.
 *
 * Architecture §8.2. The whole dataset lives in the browser; the grid does its
 * own sorting, filtering and grouping. Our job is to load the first window and
 * then keep it current.
 *
 * Two behaviours the architecture calls out explicitly, both implemented here:
 *
 *   1. A soft-delete flag flip becomes an AG-Grid `remove` transaction. Nothing
 *      else can: Perspective's on_update never surfaces a removal (§8.4).
 *   2. The user's filter model stays CLIENT-SIDE. Pushing it into the
 *      Perspective view would make filtered-out rows into ghosts — they would
 *      stop appearing in deltas while still sitting in the grid.
 */

import { pivotToRows } from '../engine.mjs';
import { rowKey } from '../../../dshub-spec/src/rowkey.mjs';

export class CsrmMode {
  /**
   * @param {object} o
   * @param {object} o.engine            EngineAdapter
   * @param {object} o.gridApi           AG-Grid API
   * @param {object} o.artifact          schema artifact
   * @param {string[]} o.keyColumns
   * @param {string} [o.softDeleteColumn]
   * @param {(n:number)=>void} [o.onLatency]  ingest-stamp -> applied, in ms
   */
  constructor({ engine, gridApi, artifact, keyColumns, softDeleteColumn, onLatency, onApplied }) {
    this.engine = engine;
    this.gridApi = gridApi;
    this.artifact = artifact;
    this.keyColumns = keyColumns ?? artifact?.keyColumns ?? [];
    this.softDeleteColumn = softDeleteColumn;
    this.onLatency = onLatency;
    this.onApplied = onApplied;
    this.rows = new Map();
    this.unsubscribe = null;
    this.applied = 0;
    this.removed = 0;
    this.duplicateKeys = 0;
    this.bufferedAtStart = 0;
  }

  /**
   * Row identity. Must be byte-identical to the hub's key encoding, or
   * transactions will not route (parity study §2.3).
   */
  getRowId = (params) => this.keyOf(params.data);

  keyOf(row) { return rowKey(row, this.keyColumns); }

  /**
   * Load the first window, then stay live.
   *
   * SUBSCRIBE BEFORE READING. `on_update` only delivers deltas that occur after
   * registration, so registering after the snapshot read drops every update
   * that lands while the window is being read and pivoted — at 2,000 rows/sec
   * and a 20k-row pivot that is hundreds of rows, left showing stale values
   * until they happen to tick again. A slow-moving row can stay wrong all day.
   *
   * Deltas that arrive during the read are buffered and replayed afterwards.
   * One that predates the snapshot gets applied twice, which is harmless: the
   * merge is idempotent and the snapshot already holds that value or a newer
   * one. At-least-once is the correct bias here; at-most-once loses data.
   */
  async start(table, viewSpec = {}) {
    this.view = await this.engine.createView(table, viewSpec);

    const pending = [];
    let buffering = true;
    this.unsubscribe = this.engine.onUpdate(this.view, (delta) => {
      if (buffering) pending.push(delta);
      else this.applyDelta(delta);
    });

    let initial;
    try {
      const block = await this.engine.readWindow(this.view);
      initial = pivotToRows(block).filter((r) => !this.isDeleted(r));
    } catch (e) {
      // Do not leave a subscription behind on a failed start.
      this.unsubscribe?.();
      this.unsubscribe = null;
      throw e;
    }

    for (const r of initial) {
      const key = this.keyOf(r);
      // Two rows with one id is a keyColumns misconfiguration. AG-Grid reports
      // it as an opaque duplicate-node error much later, so name it here.
      if (this.rows.has(key)) this.duplicateKeys++;
      this.rows.set(key, r);
    }

    this.gridApi.setGridOption('rowData', initial);

    buffering = false;
    for (const d of pending) this.applyDelta(d);
    this.bufferedAtStart = pending.length;

    return initial.length;
  }

  isDeleted(row) {
    return this.softDeleteColumn ? row[this.softDeleteColumn] === true : false;
  }

  /**
   * Map an engine delta onto an AG-Grid transaction.
   *
   * `applyTransactionAsync` batches across frames, which is what keeps a
   * 20k-update burst from blocking the main thread.
   */
  applyDelta(delta) {
    const incoming = Array.isArray(delta) ? delta : pivotToRows(delta ?? {});
    if (incoming.length === 0) return;

    const add = [];
    const update = [];
    const remove = [];

    for (const row of incoming) {
      const key = this.keyOf(row);
      const known = this.rows.get(key);

      if (this.isDeleted(row)) {
        // The flag flip IS the removal signal — the only one available.
        if (known) { this.rows.delete(key); remove.push(known); this.removed++; }
        continue;
      }

      // Deltas are partial: merge onto what we hold rather than replacing, or
      // fields absent from this delta are wiped from the grid.
      const merged = known ? { ...known, ...row } : row;
      this.rows.set(key, merged);
      (known ? update : add).push(merged);
    }

    const tx = {};
    if (add.length) tx.add = add;
    if (update.length) tx.update = update;
    if (remove.length) tx.remove = remove;
    if (Object.keys(tx).length === 0) return;

    const stamp = performance.now();
    const seq = delta?.seq;
    this.gridApi.applyTransactionAsync(tx, () => {
      this.applied += add.length + update.length + remove.length;
      this.onLatency?.(performance.now() - stamp);
      /**
       * Acknowledge from INSIDE the apply callback.
       *
       * `applyTransactionAsync` batches across frames, so acking on receipt
       * would report progress this grid has not made — which is precisely the
       * lie the hub's ladder is trying to detect. Acking here means the number
       * reflects rows actually in the grid.
       */
      if (seq !== undefined) this.onApplied?.(seq);
    });
  }

  rowCount() { return this.rows.size; }

  async stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.view) { await this.engine.dispose(this.view); this.view = null; }
    /**
     * Drop the mirror.
     *
     * `this.rows` decides add-vs-update. Carried into a restart it says
     * "known" for rows the grid no longer holds, so they are emitted as
     * updates — and an update against a node that does not exist is a silent
     * no-op. The rows simply never appear.
     */
    this.rows.clear();
  }
}
