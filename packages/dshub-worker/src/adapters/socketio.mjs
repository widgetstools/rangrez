/**
 * socket.io adapter.
 *
 * socket.io is not WebSocket — it is the Engine.IO transport with the Socket.IO
 * protocol layered on top, and both are ordinary text on the wire:
 *
 *   Engine.IO packet = <type digit><payload>
 *     0 open   (payload is the handshake JSON: sid, pingInterval, pingTimeout)
 *     2 ping   3 pong        4 message
 *
 *   Socket.IO packet (inside an Engine.IO `4`) = <type digit>[namespace,]<json>
 *     0 CONNECT   2 EVENT    e.g. `42["rows",[{...}]]`
 *
 * So a normal WebSocket carries it, and the client is a small codec rather than
 * a dependency. That matters here: the worker is a SharedWorker with an import
 * map and no bundler, so every dependency is one more thing to serve and pin.
 *
 * The ping/pong is NOT optional. Engine.IO servers close a connection that stops
 * answering, so a client that ignores `2` gets dropped every `pingTimeout` and
 * reconnects forever, looking like an unstable network.
 */

import { BaseAdapter, substitute, bodyToRows } from './base.mjs';

import {
  EIO, SIO, decodeEngineIO, decodeSocketIO, encodeEvent,
} from '../../../dshub-spec/src/socketio-codec.mjs';
// Re-exported so existing importers of these from the adapter keep working.
export { EIO, SIO, decodeEngineIO, decodeSocketIO, encodeEvent };

export class SocketIoAdapter extends BaseAdapter {
  constructor(opts) {
    super(opts);
    this.openSocket = opts.openSocket;
    this.namespace = opts.connection?.vhost ?? '/';
    this.pingTimer = null;
  }

  openTransport(url) {
    // Engine.IO requires these query parameters; a bare ws:// URL gets a 400
    // from the server and looks like a network fault.
    const u = substitute(url, this.params);
    const sep = u.includes('?') ? '&' : '?';
    const ws = this.openSocket(`${u}${sep}EIO=4&transport=websocket`);
    this.ws = ws;

    ws.onopen = () => { this.attempt = 0; };
    ws.onmessage = (ev) => this.onData(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
    ws.onerror = () => {};
    ws.onclose = () => this.transportClosed();
  }

  closeTransport() {
    if (this.pingTimer !== null) { this.clearTimer(this.pingTimer); this.pingTimer = null; }
    this.ws?.close();
  }

  send(raw) { this.ws.send(raw); }

  onData(text) {
    const { type, payload } = decodeEngineIO(text);
    switch (type) {
      case EIO.OPEN:    return this.onHandshake(payload);
      // Answer immediately. A client that ignores ping is dropped every
      // pingTimeout and reconnects forever, looking like an unstable network.
      case EIO.PING:    return this.send(EIO.PONG);
      case EIO.MESSAGE: return this.onPacket(decodeSocketIO(payload));
      case EIO.CLOSE:   return this.transportClosed();
      default:          return;
    }
  }

  onHandshake(payload) {
    try { this.handshake = JSON.parse(payload); } catch { this.handshake = {}; }
    // Join the namespace; the server sends no events before this.
    this.send(`${EIO.MESSAGE}${SIO.CONNECT}${this.namespace !== '/' ? this.namespace : ''}`);
  }

  onPacket(pkt) {
    if (pkt.type === SIO.ERROR) { this.fail(`socket.io error: ${JSON.stringify(pkt.data).slice(0, 200)}`); return; }
    if (pkt.type === SIO.CONNECT) { this.onConnected(); return; }
    if (pkt.type !== SIO.EVENT || !Array.isArray(pkt.data)) return;

    const [event, payload] = pkt.data;
    const { snapshot, updates } = this.datasource;

    if (this.inSnapshot && event === (snapshot?.endOfSnapshot?.event ?? '__end__')) {
      this.finishSnapshot(countFrom(payload, snapshot));
      return;
    }
    // Only the configured update event carries rows; a server emitting several
    // event types would otherwise have its control chatter ingested as data.
    const wanted = substitute(updates?.destination ?? 'rows', this.params);
    if (event !== wanted) return;
    this.deliver(bodyToRows(payload, updates?.bodyShape));
  }

  onConnected() {
    const { snapshot, updates } = this.datasource;
    const dest = substitute(updates?.destination ?? '', this.params);

    // Subscribe before triggering, as everywhere else (architecture §5.5).
    if (dest) this.send(encodeEvent('subscribe', { destination: dest, selector: substitute(updates?.selector ?? null, this.params) }, this.namespace));

    this.beginSnapshot(dest || this.namespace);

    if (snapshot?.mode === 'trigger-reply') {
      const body = typeof snapshot.triggerBody === 'string'
        ? substitute(snapshot.triggerBody, this.params)
        : JSON.parse(substitute(JSON.stringify(snapshot.triggerBody ?? {}), this.params));
      this.send(encodeEvent(snapshot.triggerDestination ?? 'snapshot', body, this.namespace));
    }
  }
}

function countFrom(payload, snapshot) {
  const path = snapshot?.expectedCountHeader;
  if (!path || payload == null) return undefined;
  const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), payload);
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
