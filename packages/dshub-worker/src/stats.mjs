/**
 * Stats collection — architecture §10.
 *
 * "Build this in the first working phase, not before UAT — you will need it on
 * day one of integration testing, and it is the difference between 'the blotter
 * is slow' and a diagnosis."
 *
 * Everything here answers a question someone will actually ask:
 *   "is data arriving?"        -> msgsInPerSec
 *   "is the grid keeping up?"  -> msgsOutPerSec, conflationRatio
 *   "why is it slow?"          -> latency histogram, not an average
 *   "why did it stop?"         -> state, lastError
 *   "why was I refused?"       -> memory used vs ceiling, backpressure rung
 */

/** Backpressure ladder (architecture §7.4). Published so support can see the rung. */
export const RUNG = {
  NONE: 'none',
  CONFLATING: 'conflating',
  SNAPSHOT_REFRESH: 'snapshot-refresh',
  DISCONNECTING: 'disconnecting',
};

/**
 * Rate over a sliding window.
 *
 * A cumulative counter divided by uptime hides a feed that stopped ten minutes
 * ago — the average stays healthy while the truth is zero.
 */
export class RateMeter {
  constructor({ windowMs = 5000, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.events = [];
    this.total = 0;
  }
  mark(n = 1) {
    const t = this.now();
    this.events.push([t, n]);
    this.total += n;
    this.trim(t);
  }
  trim(t = this.now()) {
    const cutoff = t - this.windowMs;
    while (this.events.length && this.events[0][0] < cutoff) this.events.shift();
  }
  perSec() {
    const t = this.now();
    this.trim(t);
    if (!this.events.length) return 0;
    const sum = this.events.reduce((a, [, n]) => a + n, 0);
    return +(sum / (this.windowMs / 1000)).toFixed(1);
  }
}

/**
 * Latency as a HISTOGRAM, never an average.
 *
 * Architecture §10 is explicit about this. An average of 40ms hides the p99 of
 * 900ms that is the thing a trader actually notices.
 */
export class Histogram {
  constructor(cap = 2000) { this.cap = cap; this.samples = []; }
  record(ms) {
    this.samples.push(ms);
    if (this.samples.length > this.cap) this.samples.shift();
  }
  percentiles() {
    if (!this.samples.length) return null;
    const s = [...this.samples].sort((a, b) => a - b);
    const at = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);
    return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: +s.at(-1).toFixed(1) };
  }
}

/** Per-datasource counters. */
export class DatasourceStats {
  constructor({ datasourceId, now = () => Date.now() } = {}) {
    this.datasourceId = datasourceId;
    this.now = now;
    this.msgsIn = new RateMeter({ now });
    this.rowsIn = new RateMeter({ now });
    this.rowsOut = new RateMeter({ now });
    this.latency = new Histogram();
    this.state = 'idle';
    this.stateSince = now();
    this.lastError = null;
    this.rung = RUNG.NONE;
    this.dropped = 0;
  }

  onMessage(rows) { this.msgsIn.mark(1); this.rowsIn.mark(rows); }
  onFlush(rows, ms) { this.rowsOut.mark(rows); if (typeof ms === 'number') this.latency.record(ms); }

  onState(state, detail) {
    this.state = state;
    this.stateSince = this.now();
    // Keep the error that EXPLAINS the failure; a later transition must not
    // erase why it happened.
    if (state === 'failed' && detail) this.lastError = { at: this.now(), message: detail };
  }

  /**
   * Conflation ratio — rows written / rows received, over the window.
   *
   * 1.0 means dedupe achieved nothing, which is worth seeing: it says the feed
   * rarely re-marks the same key inside a batch, so the batching is buying
   * write amortisation rather than conflation.
   */
  get conflationRatio() {
    const inn = this.rowsIn.perSec();
    return inn === 0 ? 1 : +(this.rowsOut.perSec() / inn).toFixed(3);
  }

  snapshot(extra = {}) {
    return {
      datasourceId: this.datasourceId,
      state: this.state,
      stateForMs: this.now() - this.stateSince,
      msgsInPerSec: this.msgsIn.perSec(),
      rowsInPerSec: this.rowsIn.perSec(),
      rowsOutPerSec: this.rowsOut.perSec(),
      conflationRatio: this.conflationRatio,
      latency: this.latency.percentiles(),
      backpressureRung: this.rung,
      dropped: this.dropped,
      lastError: this.lastError,
      ...extra,
    };
  }
}

/**
 * Decide the backpressure rung from queue depth (architecture §7.4).
 *
 * Published rather than acted on silently: a subscriber that has been quietly
 * degraded to periodic refresh looks identical to a slow feed unless the rung
 * is visible.
 */
export function rungFor(queueDepth, limit) {
  if (!limit) return RUNG.NONE;
  const load = queueDepth / limit;
  if (load >= 1) return RUNG.DISCONNECTING;
  if (load >= 0.75) return RUNG.SNAPSHOT_REFRESH;
  if (load >= 0.4) return RUNG.CONFLATING;
  return RUNG.NONE;
}
