/**
 * Group-aggregate deltas (Phase 8e, architecture §8.5).
 *
 * SSRM shows grouped data, and every leaf tick changes the aggregate of the
 * group above it and of that group's ancestors. The baseline handles this by
 * re-fetching every loaded block once a second — correct, but laggy (up to a
 * second behind) and heavy (it re-reads leaf blocks that did not move).
 *
 * The plan's mechanism is to watch a PARALLEL GROUPED VIEW: the engine already
 * maintains group keys and their aggregates, so its `on_update` on that view
 * tells us exactly which groups changed and to what. The hub forwards a compact
 * `groupDelta`; the client refreshes only those group routes, immediately.
 *
 * This module is the pure half — no engine, no sockets — so it can be tested in
 * Node. It takes successive snapshots of a grouped view (already decoded to rows
 * by the caller, the way the hub decodes its Arrow deltas) and reports the group
 * paths whose aggregates actually changed.
 */

/** A stable string key for a group path: ["Govies","Jane"] -> "GoviesJane". */
import { routesToRefresh } from '../../dshub-spec/src/grouproutes.mjs';
export { routesToRefresh };

const SEP = String.fromCharCode(1);
const pathKey = (path) => path.join(SEP);

/**
 * Diff grouped-view snapshots and report changed groups.
 *
 * `aggregateColumns` is the set of value columns whose change counts — a group
 * whose only difference is a child count still matters (the count IS shown), so
 * `__count` participates unless the caller narrows it.
 */
export class GroupAggregateDiffer {
  /**
   * @param {object} o
   * @param {string[]} o.aggregateColumns  value columns to watch for change
   * @param {number}   [o.epsilon]         float tolerance; a 1e-12 wobble is not a change
   */
  constructor({ aggregateColumns = [], epsilon = 1e-6 } = {}) {
    this.aggregateColumns = aggregateColumns;
    this.epsilon = epsilon;
    this.prev = new Map();          // pathKey -> { path, values }
    this.rounds = 0;
    this.lastChanged = 0;
  }

  /** Same value, within float tolerance and treating null/undefined alike. */
  same(a, b) {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (typeof a === 'number' && typeof b === 'number') {
      if (Number.isNaN(a) && Number.isNaN(b)) return true;
      return Math.abs(a - b) <= this.epsilon;
    }
    return false;
  }

  /**
   * Feed one snapshot of the grouped view's rows.
   *
   * Each row is `{ __ROW_PATH__: [...], <aggCol>: value, ... }` — exactly what a
   * grouped Perspective view yields. The ROOT (`__ROW_PATH__: []`) is skipped:
   * it is the grand total, not a group AG-Grid renders as a node.
   *
   * @returns {{path: string[], values: object}[]} groups changed since last feed
   */
  feed(rows) {
    this.rounds += 1;
    const changed = [];
    const seen = new Set();

    for (const row of rows ?? []) {
      const path = row.__ROW_PATH__;
      if (!Array.isArray(path) || path.length === 0) continue;   // root / not grouped
      const key = pathKey(path);
      seen.add(key);

      const values = {};
      for (const c of this.aggregateColumns) values[c] = row[c] ?? null;

      const before = this.prev.get(key);
      this.prev.set(key, { path, values });

      if (!before) { changed.push({ path, values, reason: 'new' }); continue; }
      const moved = this.aggregateColumns.some((c) => !this.same(before.values[c], values[c]));
      if (moved) changed.push({ path, values, reason: 'changed' });
    }

    // A group that vanished (last leaf left it) is a change too: the client must
    // drop the node, not leave a stale aggregate on screen.
    for (const [key, entry] of this.prev) {
      if (seen.has(key)) continue;
      changed.push({ path: entry.path, values: null, reason: 'removed' });
      this.prev.delete(key);
    }

    this.lastChanged = changed.length;
    return changed;
  }

  /** Forget everything — e.g. when the grouping columns change under us. */
  reset() { this.prev.clear(); }
}

/**
 * Build the wire message the hub sends.
 *
 * Deliberately carries the aggregate VALUES, not just the paths: a future client
 * can patch the group row in place without a refetch at all, and even the
 * refresh-based client benefits from the values being present for diagnostics.
 */
export function groupDeltaMessage(key, datasourceId, groupBy, changed) {
  return {
    id: `g-${key}`,
    type: 'groupDelta',
    ref: { datasourceId },
    groupBy,
    changed: changed.map((c) => ({ path: c.path, values: c.values, reason: c.reason })),
  };
}
