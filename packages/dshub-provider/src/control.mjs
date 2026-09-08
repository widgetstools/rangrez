/**
 * Typed control client — request/response correlation over the control channel.
 *
 * Architecture §7.2. Every request carries an `id`; the hub echoes it. Events
 * (`state`, `alert`, `statsTick`, `schemaChanged`) arrive unsolicited and are
 * dispatched to listeners instead.
 *
 * Timeouts are mandatory rather than optional: a request that never resolves
 * leaves a blotter spinning with no error and nothing to diagnose.
 */

/** Errors the UI can switch on, rather than strings it can only print. */
export class ControlError extends Error {
  constructor(code, message, { retryable = false, ref } = {}) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
    this.retryable = retryable;
    this.ref = ref;
  }
}

/** Messages that are events, not replies — they never correlate to a request. */
// `error` is deliberately NOT here: a correlated error must reject its request
// rather than be broadcast. The uncorrelated case is handled in handle().
// `commandResult` is DELIBERATELY absent: it is the correlated reply to a
// `command` request, matched by id and resolving that request. Listing it here
// would emit it as a broadcast and the request would hang forever unresolved.
const EVENTS = new Set(['state', 'alert', 'statsTick', 'schemaChanged', 'rowDelta', 'refresh', 'groupDelta']);

/**
 * Timer defaults are ARROW WRAPPERS, not bare `setTimeout`/`clearTimeout`.
 *
 * Stored as a property and invoked as `this.setTimer(...)`, a bare browser
 * `setTimeout` receives the instance as `this` and throws
 * `TypeError: Illegal invocation`. Node's timers do not check, so this fails
 * ONLY in a browser and only at runtime — every unit test passes.
 */
export class ControlClient {
  /**
   * @param {object} o
   * @param {(msg: object) => boolean} o.send
   * @param {number} [o.timeoutMs]
   */
  constructor({ send, timeoutMs = 30_000, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t), now = () => Date.now() }) {
    this._send = send;
    this.timeoutMs = timeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;

    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.stats = { sent: 0, resolved: 0, failed: 0, timedOut: 0, late: 0 };
  }

  nextId() { return `c${++this.seq}`; }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  emit(type, msg) {
    for (const fn of this.listeners.get(type) ?? []) fn(msg);
    for (const fn of this.listeners.get('*') ?? []) fn(msg);
  }

  /**
   * Send and await the correlated reply.
   *
   * @param {object} msg  without `id` — one is assigned
   * @param {object} [opts] { timeoutMs }
   */
  /**
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @param {(payload:any, msg:object)=>void} [opts.onPartial]  streamed batches
   */
  request(msg, { timeoutMs = this.timeoutMs, onPartial } = {}) {
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        // Drop the entry BEFORE rejecting: a reply arriving later must not
        // resolve an already-rejected promise, and must not leak the entry.
        this.pending.delete(id);
        this.stats.timedOut++;
        reject(new ControlError('timeout', `${msg.type} timed out after ${timeoutMs}ms`, { retryable: true }));
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, { resolve, reject, timer, type: msg.type, at: this.now(), onPartial });
      this.stats.sent++;

      // Strip undefined so the wire shape matches JSON semantics on every
      // transport (see the note in dshub-spec/src/validate.mjs).
      const payload = { id };
      for (const [k, v] of Object.entries(msg)) if (v !== undefined) payload[k] = v;
      const ok = this._send(payload);
      if (ok === false) {
        // Queued by the transport rather than sent. Leave the request pending:
        // the outbox replays it on reconnect, and the timeout still applies.
      }
    });
  }

  /** Feed every inbound control message here. */
  handle(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (EVENTS.has(msg.type)) { this.emit(msg.type, msg); return; }

    const entry = this.pending.get(msg.id);

    /**
     * A PARTIAL result is one batch of a stream, not the answer.
     *
     * `export` and `scan` emit many of these before a final non-partial reply.
     * Resolving on the first one would hand the caller a single batch and
     * silently discard the rest as late replies — which is exactly how a scan
     * of 20,000 rows delivers 2,000 and looks like it worked.
     */
    if (entry && msg.partial) {
      entry.onPartial?.(msg.payload, msg);
      this.stats.partials = (this.stats.partials ?? 0) + 1;
      return;
    }

    if (!entry) {
      /**
       * An UNSOLICITED error is an announcement, not a late reply.
       *
       * The hub sends `backpressure-disconnect` precisely so a dropped tab
       * learns why — an unexplained stop is indistinguishable from a dead feed,
       * and the tab sits showing stale prices believing they are current. But
       * the message correlates to no request, so it landed here and was counted
       * as `late` and discarded: the explanation was sent and never delivered,
       * which is the same outcome as not sending it.
       *
       * Errors that DO correlate still reject their request, below.
       */
      if (msg.type === 'error') { this.emit('error', msg); return; }

      // A reply to something already timed out, or another unsolicited message.
      // Counting these makes a timeout that is really a slow hub visible.
      this.stats.late++;
      this.emit('unmatched', msg);
      return;
    }

    this.pending.delete(msg.id);
    this.clearTimer(entry.timer);

    if (msg.type === 'error') {
      this.stats.failed++;
      entry.reject(new ControlError(msg.code ?? 'internal', msg.message ?? 'hub error', {
        retryable: msg.retryable, ref: msg.ref,
      }));
      return;
    }
    this.stats.resolved++;
    entry.resolve(msg);
  }

  /**
   * Fail everything in flight. Called on disconnect: a pending request whose
   * transport is gone will never resolve, and leaving it hanging is worse than
   * a typed error the caller can retry.
   */
  failAll(reason = 'transport disconnected') {
    for (const [id, entry] of this.pending) {
      this.clearTimer(entry.timer);
      this.stats.failed++;
      entry.reject(new ControlError('transport-unavailable', `${entry.type}: ${reason}`, { retryable: true }));
      this.pending.delete(id);
    }
  }

  // ---------------------------------------------------------------- typed API

  hello({ appId, protocolVersion = 1, bundleVersion, bundleChecksum }) {
    return this.request({ type: 'hello', appId, protocolVersion, bundleVersion, bundleChecksum });
  }
  /**
   * @param {object} ref
   * @param {{delivery?: 'rows'|'notify'}} [opts] `notify` for modes that re-read
   *        their own window (VRM, SSRM) rather than keeping a local copy.
   */
  /**
   * Acknowledge deltas APPLIED, so the hub can measure how far behind we are.
   *
   * A MessagePort exposes no send-queue depth, so without this the hub cannot
   * tell a tab that is keeping up from one whose main thread is wedged
   * (architecture §7.4). Fire-and-forget: awaiting a reply would add exactly
   * the round trip the backpressure ladder exists to avoid.
   */
  ack(seq, ref) {
    if (typeof seq !== 'number') return;
    this._send({ type: 'ack', id: this.nextId(), seq, ...(ref ? { ref } : {}) });
  }

  /**
   * Ask the hub to watch a grouped view and push groupDelta events (§8e).
   * Fire-and-forget-ish: the reply just confirms whether the host supports it.
   */
  /**
   * Register a DSL rule as a hub-side alert (§9.1). It runs over the WHOLE
   * table, so it fires on rows outside this client's window and filter.
   */
  /**
   * Submit a write (§8.6). Carries an idempotencyKey so a retry cannot double
   * -apply; the reply is a commandResult with the outcome.
   */
  command(ref, verb, idempotencyKey, payload) {
    // Resolves with the commandResult message: { idempotencyKey, outcome, detail }.
    return this.request({ type: 'command', ref, verb, idempotencyKey, ...(payload ? { payload } : {}) });
  }

  alertSubscribe(ref, ruleId, predicate) {
    return this.request({ type: 'alertSubscribe', ref, ruleId, predicate });
  }
  alertUnsubscribe(ruleId) { return this.request({ type: 'alertUnsubscribe', ruleId }); }

  watchGroups(ref, groupBy, aggregates) {
    return this.request({ type: 'watchGroups', ref, groupBy, ...(aggregates ? { aggregates } : {}) });
  }

  subscribe(ref, opts) {
    return this.request({ type: 'subscribe', ref, ...(opts?.delivery ? { delivery: opts.delivery } : {}) });
  }
  unsubscribe(ref) { this._send({ type: 'unsubscribe', ref, id: this.nextId() }); }
  distinctValues(ref, colId, contextFilter, limit) {
    return this.request({ type: 'distinctValues', ref, colId, contextFilter, limit });
  }
  searchValues(ref, colId, prefix, limit) {
    return this.request({ type: 'searchValues', ref, colId, prefix, limit });
  }
  rowCount(ref, view) { return this.request({ type: 'rowCount', ref, view }); }
  aggregates(ref, specs, view) { return this.request({ type: 'aggregates', ref, specs, view }); }
  getStats() { return this.request({ type: 'stats' }); }
}
