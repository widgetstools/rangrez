/**
 * Sidecar socket.io endpoint (Phase 10, architecture §2.2).
 *
 * The Rust sidecar runs the SAME hub logic outside the browser and exposes it
 * over socket.io. This is the socket.io SERVER half of that link, written in JS
 * so the design can be proven — and conformance-tested — before the Rust
 * reimplementation. A browser connects with `socketIoPort`; this speaks the
 * server side of the Engine.IO/Socket.IO handshake and routes each control
 * message through the SAME `handleControl` the SharedWorker uses.
 *
 * The Rust twin must match this byte-for-byte at the protocol layer: same
 * handshake, same one-event-per-control-message framing, same dispatch. This
 * server is that spec, executable.
 */

import {
  EIO, SIO, decodeEngineIO, decodeSocketIO, encodeEvent, encodeOpen,
} from '../../dshub-spec/src/socketio-codec.mjs';

const CONTROL_EVENT = 'msg';

/**
 * Attach a hub session to one raw socket (a `ws` connection, or any object with
 * `send`, `on('message'|'close')`).
 *
 * @param {object} socket
 * @param {object} o
 * @param {(msg:object, deps:object)=>Promise<object|null>} o.handleControl
 * @param {object} o.hub
 * @param {object} o.schema
 * @param {(v:unknown, s:unknown)=>unknown} o.validate
 * @param {()=>string} [o.sid]
 */
export function attachSidecarSocket(socket, { handleControl, hub, schema, validate, sid = () => 'srv' }) {
  // The session object the hub mutates (subscriptions, delivery mode, flow state).
  // `send` pushes a control message back down as one socket.io event, exactly
  // the shape `socketIoPort` decodes.
  const session = {
    id: sid(),
    subscriptions: new Set(),
    send: (msg) => socket.send(encodeEvent(CONTROL_EVENT, msg, '/')),
  };
  hub.sessions?.add?.(session);

  // Engine.IO OPEN, immediately — the client waits for it before joining.
  socket.send(encodeOpen(session.id));

  const onText = async (text) => {
    const { type, payload } = decodeEngineIO(text);
    if (type === EIO.PING) { socket.send(EIO.PONG); return; }
    if (type === EIO.CLOSE) { await teardown(); return; }
    if (type !== EIO.MESSAGE) return;

    const pkt = decodeSocketIO(payload);
    if (pkt.type === SIO.CONNECT) {
      // Acknowledge the namespace join; only now does the client flush its outbox.
      socket.send(`${EIO.MESSAGE}${SIO.CONNECT}`);
      return;
    }
    if (pkt.type !== SIO.EVENT || !Array.isArray(pkt.data)) return;

    const [event, msg] = pkt.data;
    if (event !== CONTROL_EVENT) return;

    // The SAME dispatch the SharedWorker runs.
    const reply = await handleControl(msg, { hub, schema, validate, session });
    if (reply) session.send(reply);
  };

  const teardown = async () => {
    try { await hub.disposeSessionViews?.(session); } catch { /* gone */ }
    for (const key of [...session.subscriptions]) {
      try { await hub.unsubscribe?.({ datasourceId: key.split('#')[0] }, session); } catch { /* gone */ }
    }
    hub.sessions?.delete?.(session);
  };

  socket.on('message', (data) => onText(typeof data === 'string' ? data : data.toString()));
  socket.on('close', teardown);

  return { session, teardown };
}

export { CONTROL_EVENT };
