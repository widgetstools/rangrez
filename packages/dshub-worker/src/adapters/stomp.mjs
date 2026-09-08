/**
 * STOMP-over-WebSocket adapter.
 *
 * Config-driven: adding a datasource on this transport touches zero source
 * files. The socket is injectable so the whole state machine is testable
 * without a broker.
 *
 * The ordering in `onConnected` is the part that matters — subscribe BEFORE
 * triggering the snapshot. Triggering first leaves a window where updates are
 * produced and nobody is listening, and the rows lost in that window never
 * reappear (architecture §5.5).
 */

import { FrameBuffer, encodeFrame, negotiateHeartbeat } from './stomp-codec.mjs';
import { STATE } from '../table_actor.mjs';
import { BaseAdapter, bodyToRows, substitute } from './base.mjs';

// One definition, in base.mjs; re-exported because callers import it from here.
export { substitute };


/**
 * Does this frame end the snapshot? Supports every `endOfSnapshot` kind.
 *
 * A missing sentinel must fail the subscription loudly rather than leaving the
 * table in `snapshotting` forever, so the caller pairs this with a timeout.
 */
export function isEndOfSnapshot(frame, spec, received) {
  if (!spec) return false;
  switch (spec.kind) {
    case 'sentinel-header':
      return frame.headers[spec.header] === spec.value;
    case 'sentinel-substring': {
      const hay = spec.caseSensitive ? frame.body : frame.body.toLowerCase();
      const needle = spec.caseSensitive ? spec.value : spec.value.toLowerCase();
      return hay.includes(needle);
    }
    case 'sentinel-body': {
      try {
        const parsed = JSON.parse(frame.body);
        const v = spec.path.split('.').reduce((o, k) => (o == null ? o : o[k]), parsed);
        return v === spec.value;
      } catch { return false; }
    }
    case 'count-reached':
      return typeof received === 'number' && received >= (spec.expected ?? Infinity);
    case 'stream-end':
      return false; // signalled by socket close, not by a frame
    default:
      throw new Error(`unknown endOfSnapshot kind "${spec.kind}"`);
  }
}

/** Extract the declared row count so truncation can be detected. */
export function declaredCount(frame, updates) {
  const header = updates?.expectedCountHeader;
  if (header && frame.headers[header] !== undefined) {
    const n = Number(frame.headers[header]);
    return Number.isFinite(n) ? n : undefined;
  }
  // Fall back to a count embedded in the completion prose, which is what the
  // view server actually provides.
  const m = /\ball\s+(\d[\d,]*)\b/i.exec(frame.body ?? '');
  return m ? Number(m[1].replace(/,/g, '')) : undefined;
}

/**
 * Timer defaults are ARROW WRAPPERS, not bare `setTimeout`/`clearTimeout`.
 *
 * Stored as a property and invoked as `this.setTimer(...)`, a bare browser
 * `setTimeout` receives the instance as `this` and throws
 * `TypeError: Illegal invocation`. Node's timers do not check, so this fails
 * ONLY in a browser and only at runtime — every unit test passes.
 */
export class StompAdapter extends BaseAdapter {
  /**
   * @param {object} o
   * @param {object} o.connection   connection profile
   * @param {object} o.datasource   datasource definition
   * @param {object} o.params       subscription params
   * @param {(url:string)=>object} o.openSocket  injectable; returns a WebSocket-like
   * @param {(rows:object[], phase:'snapshot'|'live')=>void} o.onRows
   * @param {(state:string, detail?:string)=>void} o.onState
   * @param {(fn:Function, ms:number)=>any} [o.setTimer]
   */
  constructor(opts) {
    super(opts);
    this.openSocket = opts.openSocket;
    this.fb = new FrameBuffer();
  }

  openTransport(url) {
    const ws = this.openSocket(url);
    this.ws = ws;
    this.fb = new FrameBuffer();

    ws.onopen = () => this.send({
      command: 'CONNECT',
      headers: {
        'accept-version': '1.2',
        host: this.connection.vhost ?? 'localhost',
        'heart-beat': `${this.connection.heartbeat?.outMs ?? 0},${this.connection.heartbeat?.inMs ?? 0}`,
      },
      body: '',
    });
    ws.onmessage = (ev) => this.onData(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
    ws.onerror = () => {};
    ws.onclose = () => this.transportClosed();
  }

  closeTransport() { this.ws?.close(); }

  send(frame) { this.ws.send(encodeFrame(frame)); }

  onData(text) {
    let frames;
    try { frames = this.fb.push(text); }
    catch (e) { this.fail(`frame error: ${e.message}`); return; }
    for (const f of frames) this.onFrame(f);
  }

  onFrame(f) {
    switch (f.command) {
      case 'CONNECTED': return this.onConnected(f);
      case 'ERROR':     return this.fail(f.headers.message ?? f.body.slice(0, 200));
      case 'HEARTBEAT': return;
      case 'MESSAGE':   return this.onMessage(f);
      default:          return;
    }
  }

  onConnected(f) {
    this.attempt = 0;
    this.heartbeat = negotiateHeartbeat(
      `${this.connection.heartbeat?.outMs ?? 0},${this.connection.heartbeat?.inMs ?? 0}`,
      f.headers['heart-beat']
    );

    const { snapshot, updates } = this.datasource;
    const listen = substitute(updates?.destination ?? snapshot.replyDestination, this.params);

    // ORDER MATTERS. Subscribe first; anything produced between the trigger and
    // the subscription is lost and never re-sent (architecture §5.5).
    this.send({ command: 'SUBSCRIBE', headers: { id: 'sub-0', destination: listen, ack: 'auto' } });
    this.beginSnapshot(listen);

    if (snapshot.mode === 'trigger-reply') {
      const dest = substitute(snapshot.triggerDestination, this.params);
      const body = snapshot.triggerBody
        ? substitute(typeof snapshot.triggerBody === 'string' ? snapshot.triggerBody : JSON.stringify(snapshot.triggerBody), this.params)
        : '';
      this.send({ command: 'SEND', headers: { destination: dest, 'content-length': String(body.length) }, body });
    }

    // A sentinel that never arrives must fail loudly rather than sit in
    // `snapshotting` forever pretending to load.
  }

  onMessage(f) {
    const { snapshot, updates } = this.datasource;

    if (this.inSnapshot && isEndOfSnapshot(f, snapshot.endOfSnapshot, this.snapshotRows)) {
      this.finishSnapshot(declaredCount(f, snapshot));
      return;
    }

    let parsed;
    try { parsed = JSON.parse(f.body); }
    catch { return; }   // non-JSON control chatter; the completion prose lands here too
    this.deliver(bodyToRows(parsed, updates?.bodyShape));
  }



}
