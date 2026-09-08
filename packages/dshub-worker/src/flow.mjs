/**
 * Per-subscriber backpressure (architecture §7.4).
 *
 * ── Why not `bufferedAmount` ──────────────────────────────────────────────────
 *
 * §7.4 says to monitor the socket's send-queue depth. That works for a
 * WebSocket, which exposes `bufferedAmount`. The worker host talks to tabs over
 * a MessagePort, which exposes NOTHING: `postMessage` always appears to succeed,
 * and a tab whose main thread is wedged looks exactly like one keeping up. The
 * queue is real — it just lives in the receiving tab's event loop where the
 * sender cannot see it.
 *
 * So the signal has to be explicit. Every delta carries a sequence number and
 * the subscriber acknowledges what it has APPLIED. Lag is what was sent minus
 * what was applied, which measures the thing that actually matters — a tab that
 * receives promptly and renders slowly is still falling behind.
 *
 * ── The ladder ────────────────────────────────────────────────────────────────
 *
 *   none              send every delta
 *   conflating        merge deltas per key, emit at most one per interval
 *   snapshot-refresh  stop sending rows; tell it to re-read its own view
 *   disconnecting     typed error, subscription dropped
 *
 * Each rung is strictly cheaper for the sender than the one before, and the last
 * two stop sending row data entirely — which is the point. Conflation alone
 * cannot save a consumer that has stopped consuming, because the merged batch
 * still has to be delivered and applied.
 *
 * The ladder is PER SESSION. One wedged tab degrades and is dropped without
 * touching the others, which is the exit criterion for this phase.
 */

import { RUNG } from './stats.mjs';

/** Lag thresholds, as a fraction of the limit. */
const THRESHOLD = { CONFLATE: 0.4, REFRESH: 0.75, DROP: 1 };

export function rungForLag(lag, limit) {
  if (!limit) return RUNG.NONE;
  const load = lag / limit;
  if (load >= THRESHOLD.DROP) return RUNG.DISCONNECTING;
  if (load >= THRESHOLD.REFRESH) return RUNG.SNAPSHOT_REFRESH;
  if (load >= THRESHOLD.CONFLATE) return RUNG.CONFLATING;
  return RUNG.NONE;
}

/**
 * Merge column-oriented delta batches, last write wins per key.
 *
 * Conflation is only correct because a delta is a full row image keyed by
 * `__key`: two updates to one position collapse to the later one. If deltas
 * were partial patches this would silently drop fields, which is why the
 * normalizer's whole-row contract matters here and not just at ingest.
 */
export function mergeDeltas(batches) {
  const byKey = new Map();
  const columns = new Set();
  for (const b of batches) {
    const keys = b.columns?.__key ?? [];
    for (const name of Object.keys(b.columns ?? {})) columns.add(name);
    for (let i = 0; i < keys.length; i++) {
      const row = {};
      for (const name of Object.keys(b.columns)) row[name] = b.columns[name][i];
      byKey.set(keys[i], row);          // later batch wins
    }
  }
  if (byKey.size === 0) return null;

  const out = {};
  for (const name of columns) out[name] = [];
  for (const row of byKey.values()) {
    for (const name of columns) out[name].push(row[name] ?? null);
  }
  return { columns: out, rows: byKey.size };
}

/**
 * One subscriber's flow state.
 *
 * @param {object} o
 * @param {number} [o.limit]        lag, in deltas, at which the subscriber is dropped
 * @param {number} [o.conflateMs]   how often a conflating subscriber is served
 */
export class SubscriberFlow {
  constructor({ session, limit = 500, conflateMs = 250, stuckMs = 30_000, now = () => Date.now() } = {}) {
    this.session = session;
    this.limit = limit;
    this.conflateMs = conflateMs;
    /**
     * How long a subscriber may sit at the refresh rung making no progress.
     *
     * WITHOUT this the ladder cannot reach its last rung. At snapshot-refresh
     * the hub stops sending rows, so `sentSeq` stops advancing and lag FREEZES
     * at whatever it was — a permanently wedged tab would sit there forever
     * holding its subscription, its view and its share of the memory ceiling,
     * which is precisely the consumer the ladder exists to shed.
     *
     * So the last rung is driven by time-without-progress rather than by lag.
     */
    this.stuckMs = stuckMs;
    this.now = now;
    this.lastProgressAt = now();
    /**
     * When this subscriber ENTERED the refresh rung.
     *
     * The grace period is time spent stuck at that rung, NOT time since the last
     * ack. Measuring from the last ack looks equivalent and is not: a client
     * that never acks at all has `lastProgressAt` frozen at construction, so by
     * the time its lag reaches the refresh threshold the grace period has
     * already elapsed and it escalates in the same call — skipping the refresh
     * rung entirely, for precisely the client the ladder exists to catch.
     *
     * Measured: none -> conflating (32s) -> disconnecting (88s), with
     * snapshot-refresh never visited.
     */
    this.refreshEnteredAt = null;

    this.sentSeq = 0;
    this.ackedSeq = 0;
    this.rung = RUNG.NONE;
    this.pending = [];
    this.lastFlush = 0;
    this.refreshSent = false;
    this.dropped = 0;
    this.conflated = 0;
    this.rungChanges = [];
  }

  get lag() { return this.sentSeq - this.ackedSeq; }

  /**
   * A subscriber that never acks must still be caught.
   *
   * An older client that does not implement `ack` would otherwise sit at lag 0
   * forever and never degrade — the ladder would be dead code against exactly
   * the clients most likely to be out of date. Treating unacknowledged sends as
   * lag makes silence indistinguishable from slowness, which is the safe
   * reading: both mean rows are being sent that nobody is applying.
   */
  onAck(seq) {
    if (typeof seq !== 'number') return;
    const next = Math.max(this.ackedSeq, Math.min(seq, this.sentSeq));
    if (next > this.ackedSeq) this.lastProgressAt = this.now();
    this.ackedSeq = next;
    if (this.rung === RUNG.SNAPSHOT_REFRESH && rungForLag(this.lag, this.limit) === RUNG.NONE) {
      // Caught up: resume normal delivery and forget the grace period.
      this.refreshSent = false;
      this.refreshEnteredAt = null;
    }
  }

  /**
   * Offer a delta. Returns what the hub should actually do.
   *
   * @returns {{action:'send'|'hold'|'refresh'|'drop', message?:object, rung:string}}
   */
  offer(delta) {
    const previous = this.rung;
    this.rung = rungForLag(this.lag, this.limit);

    // Escalate a stalled subscriber that lag alone can no longer indict — but
    // only once it has actually SAT at the refresh rung for the grace period.
    if (this.rung === RUNG.SNAPSHOT_REFRESH) {
      this.refreshEnteredAt ??= this.now();
      if (this.now() - this.refreshEnteredAt >= this.stuckMs) this.rung = RUNG.DISCONNECTING;
    } else if (this.rung !== RUNG.DISCONNECTING) {
      // Dropped back down: the clock restarts if it climbs again.
      this.refreshEnteredAt = null;
    }
    if (this.rung !== previous) this.rungChanges.push({ from: previous, to: this.rung, at: this.now(), lag: this.lag });

    if (this.rung === RUNG.DISCONNECTING) {
      this.pending = [];
      return { action: 'drop', rung: this.rung };
    }

    if (this.rung === RUNG.SNAPSHOT_REFRESH) {
      // Stop sending rows entirely. Row data is what this subscriber cannot
      // keep up with, so more of it — merged or not — cannot help.
      this.pending = [];
      if (this.refreshSent) return { action: 'hold', rung: this.rung };
      this.refreshSent = true;
      return { action: 'refresh', rung: this.rung };
    }

    if (this.rung === RUNG.CONFLATING) {
      this.pending.push(delta);
      const due = this.now() - this.lastFlush >= this.conflateMs;
      if (!due) return { action: 'hold', rung: this.rung };
      return { action: 'send', message: this.flush(), rung: this.rung };
    }

    this.refreshSent = false;
    this.sentSeq += 1;
    return { action: 'send', message: { ...delta, seq: this.sentSeq }, rung: this.rung };
  }

  /**
   * Merge and stamp whatever is queued.
   *
   * The ENVELOPE is carried from the queued deltas, not just their columns.
   * `mergeDeltas` returns bare `{columns, rows}`, and sending that lost `type`,
   * `id` and `ref` — so the client saw a message matching no event type and no
   * pending request, counted it as a late reply and discarded it.
   *
   * The effect was that the middle rung of the ladder did nothing at all: a
   * conflating subscriber received merged batches it silently threw away, while
   * the hub's own view of the world looked entirely healthy. Measured against
   * the live feed as 175 discarded messages.
   */
  flush() {
    const envelope = this.pending[0];
    const merged = mergeDeltas(this.pending);
    this.conflated += this.pending.length;
    this.pending = [];
    this.lastFlush = this.now();
    if (!merged || !envelope) return null;
    this.sentSeq += 1;
    return {
      id: envelope.id,
      type: envelope.type,
      ...(envelope.ref ? { ref: envelope.ref } : {}),
      ...merged,
      seq: this.sentSeq,
    };
  }

  stats() {
    return {
      rung: this.rung,
      lag: this.lag,
      sentSeq: this.sentSeq,
      ackedSeq: this.ackedSeq,
      conflated: this.conflated,
      pending: this.pending.length,
    };
  }
}
