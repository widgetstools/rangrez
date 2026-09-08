/**
 * Raw WebSocket adapter.
 *
 * The simplest transport: a socket, optionally a subscribe message, then JSON
 * bodies. No framing protocol of its own, which makes the END OF SNAPSHOT the
 * only interesting question — there are no headers to carry a sentinel, so the
 * signal has to come from the body, a count, or the stream closing.
 */

import { BaseAdapter, substitute, bodyToRows } from './base.mjs';

/**
 * Did this message end the snapshot?
 *
 * Deliberately does NOT share STOMP's version: that one reads frame headers,
 * which a raw socket does not have. The `kind` values are the same vocabulary,
 * but `sentinel-header` is unreachable here and says so rather than silently
 * never matching.
 */
export function isEndOfSnapshot(parsed, spec, received) {
  if (!spec) return false;
  switch (spec.kind) {
    case 'sentinel-body': {
      const v = spec.path.split('.').reduce((o, k) => (o == null ? o : o[k]), parsed);
      return v === spec.value;
    }
    case 'sentinel-substring':
      return typeof parsed === 'string' && parsed.includes(spec.value);
    case 'count-reached':
      return typeof received === 'number' && received >= (spec.expected ?? Infinity);
    case 'stream-end':
      return false;   // signalled by the socket closing, handled in transportClosed
    case 'sentinel-header':
      throw new Error('endOfSnapshot "sentinel-header" needs frame headers; a raw WebSocket has none');
    default:
      throw new Error(`unknown endOfSnapshot kind "${spec.kind}"`);
  }
}

export class WsAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.openSocket = opts.openSocket;
  }

  openTransport(url) {
    const ws = this.openSocket(substitute(url, this.params));
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      const { snapshot, updates } = this.datasource;

      // Subscribe BEFORE triggering. Subscribing after the snapshot request
      // leaves a gap in which updates are lost (architecture §5.5).
      if (updates?.destination) {
        this.send({ type: 'subscribe', destination: substitute(updates.destination, this.params),
                    ...(updates.selector ? { selector: substitute(updates.selector, this.params) } : {}) });
      }

      this.beginSnapshot(substitute(updates?.destination ?? url, this.params));

      if (snapshot?.mode === 'trigger-reply' && snapshot.triggerBody !== undefined) {
        this.send(typeof snapshot.triggerBody === 'string'
          ? JSON.parse(substitute(snapshot.triggerBody, this.params))
          : JSON.parse(substitute(JSON.stringify(snapshot.triggerBody), this.params)));
      }
    };

    ws.onmessage = (ev) => this.onData(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
    ws.onerror = () => {};
    ws.onclose = () => this.onSocketClose();
  }

  closeTransport() { this.ws?.close(); }

  send(obj) { this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }

  onData(text) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return; }   // non-JSON keepalive chatter

    const { snapshot, updates } = this.datasource;
    if (this.inSnapshot && isEndOfSnapshot(parsed, snapshot?.endOfSnapshot, this.snapshotRows)) {
      this.finishSnapshot(declaredCount(parsed, snapshot));
      return;
    }
    this.deliver(bodyToRows(parsed, updates?.bodyShape));
  }

  /**
   * `stream-end`: the socket closing IS the sentinel.
   *
   * Only while snapshotting, and only for that mode — otherwise a mid-session
   * drop would be read as a completed snapshot and the datasource would go
   * live on a partial book.
   */
  onSocketClose() {
    if (this.inSnapshot && this.datasource?.snapshot?.endOfSnapshot?.kind === 'stream-end') {
      this.finishSnapshot(undefined);
      return;
    }
    this.transportClosed();
  }
}

/** A declared row count carried in the sentinel body, when there is one. */
export function declaredCount(parsed, snapshot) {
  const path = snapshot?.expectedCountHeader;
  if (!path) return undefined;
  const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), parsed);
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
