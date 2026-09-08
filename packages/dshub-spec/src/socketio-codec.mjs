/**
 * Engine.IO / Socket.IO wire codec (shared).
 *
 * socket.io is Engine.IO framing (`<type><payload>`) with the Socket.IO protocol
 * layered on top (`<type>[namespace,]<json>`). Both are plain text over a normal
 * WebSocket, so this is a small codec, not a dependency.
 *
 * It lives in the SPEC package because THREE places need it and must agree: the
 * ingest adapter (a client to an external socket.io feed), the provider's
 * transport (a client to the Rust sidecar, Phase 10), and the sidecar/test
 * server (the hub's socket.io endpoint). One definition, or the two ends of the
 * sidecar link speak subtly different framing.
 */

export const EIO = { OPEN: '0', CLOSE: '1', PING: '2', PONG: '3', MESSAGE: '4' };
export const SIO = { CONNECT: '0', DISCONNECT: '1', EVENT: '2', ACK: '3', ERROR: '4' };

/** Decode one Engine.IO packet: `<type><payload>`. */
export function decodeEngineIO(text) {
  if (typeof text !== 'string' || text.length === 0) return { type: null };
  return { type: text[0], payload: text.slice(1) };
}

/**
 * Decode a Socket.IO packet body.
 *
 * The namespace is optional and comma-terminated: `2/trades,["ev",{...}]`.
 * Binary-attachment syntax (`51-`) is reported rather than silently misparsed.
 */
export function decodeSocketIO(payload) {
  if (!payload) return { type: null };
  const type = payload[0];
  let rest = payload.slice(1);

  if (/^\d+-/.test(rest)) return { type, binary: true, namespace: '/', data: null };

  let namespace = '/';
  if (rest.startsWith('/')) {
    const comma = rest.indexOf(',');
    if (comma === -1) { namespace = rest; rest = ''; }
    else { namespace = rest.slice(0, comma); rest = rest.slice(comma + 1); }
  }

  let data = null;
  if (rest) { try { data = JSON.parse(rest); } catch { data = null; } }
  return { type, namespace, data };
}

/** Encode a Socket.IO EVENT inside an Engine.IO message. */
export function encodeEvent(name, payload, namespace = '/') {
  const ns = namespace && namespace !== '/' ? `${namespace},` : '';
  return `${EIO.MESSAGE}${SIO.EVENT}${ns}${JSON.stringify([name, payload])}`;
}

/** The Engine.IO OPEN handshake a server sends on connect. */
export function encodeOpen(sid = 'srv', { pingInterval = 25000, pingTimeout = 20000 } = {}) {
  return `${EIO.OPEN}${JSON.stringify({ sid, upgrades: [], pingInterval, pingTimeout })}`;
}
