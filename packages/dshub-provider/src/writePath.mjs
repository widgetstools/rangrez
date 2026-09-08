/**
 * Optimistic write path (Phase 9, architecture §8.6).
 *
 * Perspective is a read model — the blotter never writes to it. A write (an
 * annotation, an order edit) goes to the AUTHORITATIVE system and comes back
 * through the normal feed. The problem that creates: a trader who edits a cell
 * should see the change instantly, not after a round trip to the order system
 * and back down the market-data feed — which on a busy desk is hundreds of
 * milliseconds. So the edit is applied OPTIMISTICALLY, marked pending, and
 * reconciled when the authoritative echo arrives.
 *
 * ── The three ways a write resolves ───────────────────────────────────────────
 *
 *   confirmed — the echo (a feed row update) carries the value we sent. Clear
 *               the pending marker; nothing else to do.
 *   diverged  — the echo carries a DIFFERENT value: the server adjusted or
 *               partially filled. The authoritative value wins, silently — the
 *               feed already delivered it — and the marker clears. The optimistic
 *               value was a guess and the guess was wrong; showing the real value
 *               is the correct outcome, not an error.
 *   rejected  — the commandResult said `rejected`, or nothing came back within
 *               the timeout. Roll the cell back to what it was, and surface it:
 *               a silently-dropped order is the one failure a trader must never
 *               have.
 *
 * ── Why idempotencyKey, not a fresh id per attempt ────────────────────────────
 *
 * A network retry must never double-apply an order. The key is stable across
 * retries of the SAME logical write, so the hub/order-system dedups, and it is
 * also how an ambiguous timeout is resolved: if the echo eventually arrives
 * under that key, the write was applied after all.
 *
 * Pure and engine-free: `now` and the key generator are injected so it runs
 * deterministically in tests.
 */

const STATUS = { PENDING: 'pending', CONFIRMED: 'confirmed', DIVERGED: 'diverged', REJECTED: 'rejected', TIMED_OUT: 'timed-out' };
export { STATUS };

export class WriteManager {
  /**
   * @param {object} o
   * @param {(command:object)=>void} o.send        deliver a command to the hub
   * @param {number} [o.timeoutMs]                 rollback if unreconciled by then
   * @param {()=>number} [o.now]
   * @param {()=>string} [o.newKey]                idempotency key generator
   */
  constructor({ send, timeoutMs = 10_000, now = () => Date.now(), newKey } = {}) {
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.now = now;
    let seq = 0;
    this.newKey = newKey ?? (() => `w${++seq}`);
    /** idempotencyKey -> write record. */
    this.writes = new Map();
    /** `${key}${field}` -> idempotencyKey, for cell lookups. */
    this.byCell = new Map();
    this.confirmed = 0;
    this.diverged = 0;
    this.rejected = 0;
    this.timedOut = 0;
  }

  #cell(key, field) { return `${key}${field}`; }

  /**
   * Apply an edit optimistically.
   *
   * Records the original value so a reject/timeout can roll back, sends the
   * command, and returns the optimistic value the grid should show now.
   *
   * @returns {{idempotencyKey:string, value:unknown}}
   */
  submit({ ref, verb = 'edit', key, field, value, currentValue, payload }) {
    const idempotencyKey = this.newKey();
    const write = {
      idempotencyKey, ref, verb, key, field,
      optimistic: value, original: currentValue,
      status: STATUS.PENDING, at: this.now(),
    };
    this.writes.set(idempotencyKey, write);
    // A second edit to the same cell supersedes the first: only the latest
    // optimistic value should render, and the earlier write is abandoned.
    const cellId = this.#cell(key, field);
    const prior = this.byCell.get(cellId);
    if (prior && this.writes.has(prior)) this.writes.get(prior).superseded = true;
    this.byCell.set(cellId, idempotencyKey);

    this.send?.({
      type: 'command', ref, verb, idempotencyKey,
      payload: { key, field, value, ...(payload ?? {}) },
    });
    return { idempotencyKey, value };
  }

  /** The value to render for a cell: the optimistic overlay, or undefined. */
  overlay(key, field) {
    const w = this.#activeWrite(key, field);
    return w ? w.optimistic : undefined;
  }

  /** The pending status of a cell, for styling — or null if settled/none. */
  status(key, field) {
    const w = this.#activeWrite(key, field);
    return w ? w.status : null;
  }

  #activeWrite(key, field) {
    const id = this.byCell.get(this.#cell(key, field));
    const w = id && this.writes.get(id);
    return w && !w.superseded && w.status === STATUS.PENDING ? w : null;
  }

  /**
   * A fast ack from the hub.
   *
   * `applied`/`duplicate` do NOT clear the pending marker — the authoritative
   * VALUE still arrives via the echo, and only that confirms what the cell holds
   * (the server may have adjusted it). `rejected` rolls back immediately.
   * `unknown` is left pending for the echo or the timeout to resolve.
   *
   * @returns {{idempotencyKey:string, action:'await-echo'|'rolled-back'|'ignored', restore?:object}}
   */
  onResult({ idempotencyKey, outcome, detail }) {
    const w = this.writes.get(idempotencyKey);
    if (!w || w.status !== STATUS.PENDING) return { idempotencyKey, action: 'ignored' };

    if (outcome === 'rejected') {
      w.status = STATUS.REJECTED;
      w.detail = detail;
      this.rejected++;
      return { idempotencyKey, action: 'rolled-back', restore: { key: w.key, field: w.field, value: w.original } };
    }
    // applied / duplicate / unknown: the echo is the source of truth for the value.
    return { idempotencyKey, action: 'await-echo' };
  }

  /**
   * Reconcile against an authoritative row echo from the feed.
   *
   * For every pending write on this key, compare the echoed field value to the
   * optimistic one: equal → confirmed, different → diverged (authoritative wins).
   * Either way the pending marker clears.
   *
   * @param {string} key
   * @param {object} row  the echoed row (post-update field values)
   * @returns {{idempotencyKey:string, status:string}[]}
   */
  reconcileEcho(key, row) {
    const out = [];
    for (const w of this.writes.values()) {
      if (w.key !== key || w.status !== STATUS.PENDING) continue;
      if (!(w.field in row)) continue;                 // this echo did not touch the pending field
      const echoed = row[w.field];
      if (same(echoed, w.optimistic)) { w.status = STATUS.CONFIRMED; this.confirmed++; }
      else { w.status = STATUS.DIVERGED; w.authoritative = echoed; this.diverged++; }
      out.push({ idempotencyKey: w.idempotencyKey, status: w.status });
    }
    return out;
  }

  /**
   * Roll back writes that have gone unreconciled past the timeout.
   *
   * An order with no echo and no result is the ambiguous case the idempotency
   * key exists for: it MIGHT have applied. Rolling the display back is the safe
   * choice — showing an unconfirmed edit as if it were real is worse — and the
   * key means a retry cannot double-apply if it did go through.
   *
   * @returns {{key:string, field:string, value:unknown, idempotencyKey:string}[]}
   */
  tick() {
    const restored = [];
    const cutoff = this.now() - this.timeoutMs;
    for (const w of this.writes.values()) {
      if (w.status !== STATUS.PENDING || w.superseded) continue;
      if (w.at > cutoff) continue;
      w.status = STATUS.TIMED_OUT;
      this.timedOut++;
      restored.push({ key: w.key, field: w.field, value: w.original, idempotencyKey: w.idempotencyKey });
    }
    return restored;
  }

  get pendingCount() {
    let n = 0;
    for (const w of this.writes.values()) if (w.status === STATUS.PENDING && !w.superseded) n++;
    return n;
  }

  /** Drop settled writes so the maps do not grow without bound. */
  prune() {
    for (const [id, w] of this.writes) {
      if (w.status !== STATUS.PENDING) {
        this.writes.delete(id);
        if (this.byCell.get(this.#cell(w.key, w.field)) === id) this.byCell.delete(this.#cell(w.key, w.field));
      }
    }
  }
}

/** Value equality tolerant of number/string echo and float wobble. */
function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return String(a) === String(b);
}
