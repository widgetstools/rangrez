/**
 * Hub-side alerts (Phase 9, architecture §9.1).
 *
 * ── Why alerts MUST be hub-side ───────────────────────────────────────────────
 *
 * An alert is a promise: "tell me when any position crosses this line." In SSRM
 * the client holds only a window — the rows it has scrolled to — so a client-side
 * alert silently only watches those. A trader who set "PnL < -500k" and is
 * looking at the top of the book would never hear about a blow-up 40,000 rows
 * down. So the predicate compiles to a Perspective expression and runs against
 * the WHOLE table, in the hub, regardless of any client's viewport or filter.
 *
 * ── The mechanism ─────────────────────────────────────────────────────────────
 *
 * The rule's predicate becomes a filter: a view over the full table containing
 * exactly the rows that currently match. That view's membership IS the set of
 * firing rows. `AlertWatcher` diffs successive memberships and reports:
 *
 *   fired    — a key that just entered the set (crossed the line)
 *   cleared  — a key that just left it (came back inside)
 *
 * Only TRANSITIONS are events. A row that stays over the line for an hour fires
 * once, not once per tick — an alert that repeats every tick is noise a trader
 * learns to ignore, which defeats the point.
 */

/** Track the matching key-set and report entries/exits. */
export class AlertWatcher {
  constructor() {
    this.matching = new Set();
    this.fires = 0;
    this.clears = 0;
  }

  /**
   * Feed the CURRENT set of rows that satisfy the predicate (the alert view's
   * contents, decoded to rows with `__key`).
   *
   * @returns {{fired: object[], cleared: string[]}}
   *   fired   — full rows that newly match (so the alert carries the values)
   *   cleared — keys that no longer match
   */
  feed(rows) {
    const now = new Set();
    const fired = [];
    for (const row of rows ?? []) {
      const key = row?.__key;
      if (key === undefined || key === null) continue;
      now.add(key);
      if (!this.matching.has(key)) { fired.push(row); this.fires++; }
    }
    const cleared = [];
    for (const key of this.matching) {
      if (!now.has(key)) { cleared.push(key); this.clears++; }
    }
    this.matching = now;
    return { fired, cleared };
  }

  /** How many rows are currently over the line — for the diagnostics panel. */
  get activeCount() { return this.matching.size; }

  reset() { this.matching.clear(); }
}

/**
 * Build the `alert` wire message for one fired row.
 *
 * `firedAt` is stamped by the caller (Date is unavailable in some hosts and must
 * be injected), so this stays pure.
 */
export function alertMessage(ruleId, row, firedAt) {
  return { id: `a-${ruleId}`, type: 'alert', ruleId, row, ...(firedAt ? { firedAt } : {}) };
}
