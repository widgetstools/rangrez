/**
 * socket.io transport port for the Rust sidecar (Phase 10, architecture §2.2).
 *
 * The SharedWorker host hands the provider a MessagePort; the Rust sidecar hands
 * it a socket.io connection. `Transport` and `ControlClient` do not care which —
 * they want a port-like object with `postMessage`, `onmessage`, `onclose`,
 * `close`. This wraps a socket.io link in exactly that shape, so the entire
 * provider stack runs UNCHANGED against the sidecar. That the two hosts differ
 * in one 60-line adapter and nothing else is the payoff of keeping the hub and
 * the protocol transport-neutral from Phase 2 onward.
 *
 * Control messages ride a single socket.io event (`msg`) as JSON. The Perspective
 * binary channel is a later addition (§7.1); the current hub decodes deltas
 * server-side and sends columns as control messages, so a JSON control channel
 * reproduces its behaviour exactly.
 */

import {
  EIO, SIO, decodeEngineIO, decodeSocketIO, encodeEvent,
} from '../../dshub-spec/src/socketio-codec.mjs';

const CONTROL_EVENT = 'msg';

/**
 * @param {string} url
 * @param {object} [o]
 * @param {(url:string)=>object} [o.openSocket]  WebSocket factory (injected for tests)
 * @param {string} [o.namespace]
 * @returns {object} a port-like: { postMessage, close, start, onmessage, onclose, onerror }
 */
export function socketIoPort(url, { openSocket = (u) => new WebSocket(u), namespace = '/' } = {}) {
  const sep = url.includes('?') ? '&' : '?';
  const ws = openSocket(`${url}${sep}EIO=4&transport=websocket`);

  const port = {
    onmessage: null, onclose: null, onerror: null,
    _connected: false,
    _outbox: [],
    postMessage(msg) {
      // Buffer until the socket.io CONNECT handshake completes, or the first
      // messages (hello!) are sent into a namespace the server has not joined
      // us to yet and are silently dropped.
      const frame = encodeEvent(CONTROL_EVENT, msg, namespace);
      if (this._connected) ws.send(frame);
      else this._outbox.push(frame);
    },
    close() { try { ws.close(); } catch { /* already gone */ } },
    start() { /* MessagePort parity; the socket auto-starts */ },
  };

  const flush = () => { for (const f of port._outbox) ws.send(f); port._outbox = []; };

  ws.onopen = () => { /* wait for the Engine.IO OPEN handshake */ };
  ws.onmessage = (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
    const { type, payload } = decodeEngineIO(text);

    if (type === EIO.OPEN) {
      // Join the namespace; the server sends nothing before CONNECT.
      ws.send(`${EIO.MESSAGE}${SIO.CONNECT}${namespace !== '/' ? namespace : ''}`);
      return;
    }
    if (type === EIO.PING) { ws.send(EIO.PONG); return; }   // keep the link alive
    if (type === EIO.CLOSE) { port.onclose?.({}); return; }
    if (type !== EIO.MESSAGE) return;

    const pkt = decodeSocketIO(payload);
    if (pkt.type === SIO.CONNECT) { port._connected = true; flush(); return; }
    if (pkt.type === SIO.DISCONNECT) { port.onclose?.({}); return; }
    if (pkt.type !== SIO.EVENT || !Array.isArray(pkt.data)) return;

    const [event, data] = pkt.data;
    if (event === CONTROL_EVENT) port.onmessage?.({ data });   // one control message -> Transport
  };
  ws.onclose = () => port.onclose?.({});
  ws.onerror = () => port.onerror?.({});

  return port;
}

export { CONTROL_EVENT };
