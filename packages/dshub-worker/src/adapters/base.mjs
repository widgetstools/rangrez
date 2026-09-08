/**
 * Shared adapter lifecycle.
 *
 * Four transports (STOMP, raw WebSocket, socket.io, REST) differ in how bytes
 * arrive and how a snapshot is requested. Everything AROUND that is identical:
 * the state machine, failover across endpoints, exponential backoff, snapshot
 * row accounting and the declared-count check, and the timer discipline.
 *
 * Writing that four times means writing the same backoff bug four times, and
 * the parts most worth getting right — "upstream loss is `stale`, not `failed`,
 * because the cache is still valid" — are exactly the parts nobody re-derives
 * carefully on the fourth copy.
 *
 * A subclass supplies two things: `openTransport(url)` and `closeTransport()`.
 * It drives the lifecycle by calling `beginSnapshot`, `countSnapshotRows`,
 * `finishSnapshot`, `deliver`, `fail` and `transportClosed`.
 */

import { STATE } from '../table_actor.mjs';

export class BaseAdapter {
  /**
   * @param {object} o
   * @param {object} o.connection
   * @param {object} o.datasource
   * @param {object} [o.params]
   * @param {(rows:object[], phase:'snapshot'|'live')=>void} o.onRows
   * @param {(state:string, detail?:string)=>void} o.onState
   */
  constructor({
    connection, datasource, params = {}, onRows, onState,
    // ARROW WRAPPERS, not bare setTimeout/clearTimeout. Stored as a property and
    // called as `this.setTimer(...)`, a bare browser `setTimeout` receives the
    // instance as `this` and throws `Illegal invocation`. Node's timers do not
    // check, so a bare reference fails ONLY in a browser and only at runtime —
    // every unit test passes.
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  }) {
    this.connection = connection;
    this.datasource = datasource;
    this.params = params;
    this.onRows = onRows;
    this.onState = onState;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;

    this.urls = [connection.url, ...(connection.failover ?? [])];
    this.urlIndex = 0;
    this.attempt = 0;
    this.state = STATE.IDLE;
    this.snapshotRows = 0;
    this.declared = undefined;
    this.closed = false;
    this.snapshotTimer = null;
  }

  // ------------------------------------------------------------ state

  setState(s, detail) { this.state = s; this.onState?.(s, detail); }

  /** Node timers only; a no-op for browser timer ids and injected fakes. */
  unref(t) { if (t && typeof t.unref === 'function') t.unref(); return t; }

  get url() { return this.urls[this.urlIndex]; }

  // ------------------------------------------------------------ lifecycle

  connect() {
    this.closed = false;
    this.snapshotRows = 0;
    this.declared = undefined;
    this.setState(STATE.CONNECTING, this.url);
    this.openTransport(this.url);
  }

  close() {
    this.closed = true;
    this.clearSnapshotTimer();
    try { this.closeTransport(); } catch { /* already gone */ }
    this.setState(STATE.IDLE);
  }

  // ------------------------------------------------------------ snapshot

  /** Enter the snapshot phase and arm its deadline. */
  beginSnapshot(detail) {
    this.snapshotRows = 0;
    this.declared = undefined;
    this.setState(STATE.SNAPSHOTTING, detail);
    this.armSnapshotTimeout();
  }

  armSnapshotTimeout() {
    // A snapshot that never ends is indistinguishable from one still arriving,
    // so there is always a deadline even when config omits one.
    const ms = this.datasource?.snapshot?.timeoutMs ?? 120_000;
    if (!ms) return;
    this.clearSnapshotTimer();
    this.snapshotTimer = this.setTimer(() => {
      if (this.state === STATE.SNAPSHOTTING) {
        this.fail(`snapshot sentinel not seen within ${ms}ms after ${this.snapshotRows} rows`);
      }
    }, ms);
    this.unref(this.snapshotTimer);
  }

  clearSnapshotTimer() {
    if (this.snapshotTimer !== null) { this.clearTimer(this.snapshotTimer); this.snapshotTimer = null; }
  }

  get inSnapshot() { return this.state === STATE.SNAPSHOTTING; }

  /** Rows, tagged with the phase so the actor knows whether to buffer. */
  deliver(rows) {
    if (!rows?.length) return;
    if (this.inSnapshot) this.snapshotRows += rows.length;
    this.onRows(rows, this.inSnapshot ? 'snapshot' : 'live');
  }

  /**
   * End the snapshot.
   *
   * A declared count that does not match what arrived is a FAILURE, not a
   * warning: going live on a silently truncated book is the worst outcome in
   * this system, because everything downstream looks healthy.
   */
  finishSnapshot(declared) {
    this.clearSnapshotTimer();
    this.declared = declared;
    if (declared !== undefined && declared !== this.snapshotRows) {
      this.fail(`expected ${declared} rows, received ${this.snapshotRows}`);
      return false;
    }
    this.setState(STATE.LIVE, `${this.snapshotRows} rows`);
    return true;
  }

  fail(detail) { this.clearSnapshotTimer(); this.setState(STATE.FAILED, detail); }

  // ------------------------------------------------------------ recovery

  /** The transport dropped. Not a failure — the cache is still valid. */
  transportClosed() {
    if (this.closed) return;
    if (this.state === STATE.FAILED) return;
    // Upstream loss is `stale`, so the blotter greys out rather than emptying.
    this.setState(STATE.STALE, 'connection closed');
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    const r = this.connection.reconnect ?? {};
    const max = r.maxAttempts ?? null;
    if (max !== null && this.attempt >= max) {
      // Exhausted this endpoint: move to the next failover URL. Failover is a
      // recovery, not a failure (architecture §5.7).
      if (this.urlIndex < this.urls.length - 1) {
        this.urlIndex += 1;
        this.attempt = 0;
      } else {
        this.setState(STATE.FAILED, 'all endpoints exhausted');
        return;
      }
    }
    const delay = Math.min(
      (r.initialMs ?? 500) * Math.pow(r.factor ?? 2, this.attempt),
      r.maxMs ?? 30_000
    );
    this.attempt += 1;
    this.setState(STATE.RECOVERING, `retry in ${delay}ms (attempt ${this.attempt}, ${this.url})`);
    this.unref(this.setTimer(() => { if (!this.closed) this.connect(); }, delay));
  }

  // ------------------------------------------------------------ subclass hooks

  /* eslint-disable no-unused-vars */
  openTransport(url) { throw new Error(`${this.constructor.name} must implement openTransport`); }
  closeTransport() {}
}

/**
 * `{clientId}` / `{rate}` substitution into destinations, URLs and bodies.
 *
 * THROWS on a missing param rather than leaving the placeholder. A destination
 * that still reads `/snapshot/positions/{clientId}` subscribes to a literal
 * topic of that name and receives nothing — a silent empty blotter with a
 * healthy-looking connection.
 */
export function substitute(template, params = {}) {
  if (template === null || template === undefined) return template;
  return String(template).replace(/\{(\w+)\}/g, (whole, key) => {
    const v = params[key];
    if (v === undefined) throw new Error(`missing param "${key}" for template "${template}"`);
    return String(v);
  });
}

/**
 * One frame/message body -> rows.
 *
 * `bodyShape` says whether a body is one record or an array of them. Guessing
 * from the payload instead means a datasource whose records are themselves
 * arrays silently explodes into garbage.
 */
export function bodyToRows(parsed, bodyShape) {
  if (bodyShape === 'record-array') return Array.isArray(parsed) ? parsed : [parsed];
  if (bodyShape === 'record') return [parsed];
  return Array.isArray(parsed) ? parsed : [parsed];
}
