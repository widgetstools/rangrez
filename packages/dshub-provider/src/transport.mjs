/**
 * Provider-side transport — the client half of the two-channel split.
 *
 * Architecture §7.1. Plain objects are control; ArrayBuffers are Perspective's
 * own protocol and are handed straight through without being parsed.
 *
 * One class covers both hosts: a MessagePort today, a WebSocket when the
 * sidecar lands. The only difference is which `send` the constructor is given,
 * which is why §2.2 calls this the one module that differs between hosts.
 */

const isBinary = (d) => d instanceof ArrayBuffer || ArrayBuffer.isView(d);

/**
 * Timer defaults are ARROW WRAPPERS, not bare `setTimeout`/`clearTimeout`.
 *
 * Stored as a property and invoked as `this.setTimer(...)`, a bare browser
 * `setTimeout` receives the instance as `this` and throws
 * `TypeError: Illegal invocation`. Node's timers do not check, so this fails
 * ONLY in a browser and only at runtime — every unit test passes.
 */
export class Transport {
  /**
   * @param {object} o
   * @param {() => object} o.connect   returns a port-like: postMessage/close, onmessage
   * @param {(msg: object) => void} o.onControl
   * @param {(buf: ArrayBuffer) => void} [o.onBinary]
   * @param {(state: string, detail?: string) => void} [o.onState]
   * @param {object} [o.reconnect]     { initialMs, maxMs, factor, maxAttempts }
   */
  constructor({ connect, onControl, onBinary, onState, reconnect = {}, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
    this._connect = connect;
    this.onControl = onControl;
    this.onBinary = onBinary;
    this.onState = onState;
    this.reconnect = { initialMs: 250, maxMs: 10_000, factor: 2, maxAttempts: null, ...reconnect };
    this.setTimer = setTimer;

    this.port = null;
    this.attempt = 0;
    this.closed = false;
    this.connected = false;
    /** Buffered while disconnected, replayed on reconnect (architecture §5.6). */
    this.outbox = [];
  }

  open() {
    this.closed = false;
    this.port = this._connect();
    this.port.onmessage = (ev) => {
      const d = ev.data;
      if (isBinary(d)) { this.onBinary?.(d instanceof ArrayBuffer ? d : d.buffer); return; }
      this.onControl?.(d);
    };
    this.port.onclose = () => this.handleClose();
    this.port.onerror = () => this.handleClose();
    this.port.start?.();

    this.connected = true;
    this.attempt = 0;
    this.onState?.('connected');

    // Replay anything queued while down. Resume rather than drop: a subscribe
    // lost across a reconnect leaves a blotter permanently blank.
    const queued = this.outbox;
    this.outbox = [];
    for (const m of queued) this.send(m);
    return this;
  }

  send(msg) {
    if (!this.connected) { this.outbox.push(msg); return false; }
    this.port.postMessage(msg);
    return true;
  }

  /** Perspective traffic is TRANSFERRED, never copied. */
  sendBinary(buf) {
    if (!this.connected) return false;
    this.port.postMessage(buf, [buf]);
    return true;
  }

  handleClose() {
    if (this.closed || !this.connected) return;
    this.connected = false;
    this.onState?.('disconnected');
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    const r = this.reconnect;
    if (r.maxAttempts !== null && this.attempt >= r.maxAttempts) {
      this.onState?.('failed', 'reconnect attempts exhausted');
      return;
    }
    const delay = Math.min(r.initialMs * Math.pow(r.factor, this.attempt), r.maxMs);
    this.attempt += 1;
    this.onState?.('reconnecting', `attempt ${this.attempt} in ${delay}ms`);
    const t = this.setTimer(() => { if (!this.closed) this.open(); }, delay);
    if (t && typeof t.unref === 'function') t.unref();
  }

  close() {
    this.closed = true;
    this.connected = false;
    try { this.port?.close?.(); } catch { /* already gone */ }
    this.onState?.('closed');
  }
}

export { isBinary };
