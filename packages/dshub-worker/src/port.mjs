/**
 * The two-channel split, over a MessagePort.
 *
 * Architecture §7.1. Plain objects are control; ArrayBuffer transfers are
 * Perspective's own protocol, passed straight through without being parsed.
 * That is the whole trick: no envelope, no multiplexing, no framing code.
 *
 * With the sidecar the same split becomes WebSocket text vs binary frames, so
 * this module is the only place that differs between hosts.
 */

const isBinary = (d) => d instanceof ArrayBuffer || ArrayBuffer.isView(d);

/**
 * Wrap one MessagePort.
 *
 * @param {MessagePort} port
 * @param {object} h
 * @param {(msg:object)=>void|Promise<void>} h.onControl
 * @param {(buf:ArrayBuffer)=>void|Promise<void>} h.onBinary  Perspective traffic
 */
export function attachPort(port, { onControl, onBinary }) {
  port.onmessage = (ev) => {
    const d = ev.data;
    if (isBinary(d)) { onBinary?.(d instanceof ArrayBuffer ? d : d.buffer); return; }
    onControl?.(d);
  };
  port.start?.();

  return {
    /** Control: structured-cloned, never transferred. */
    control(msg) { port.postMessage(msg); },

    /**
     * Perspective: TRANSFERRED, not copied. At 500k x 372 the copy would be the
     * dominant cost of every window read, and the buffer is dead on this side
     * the moment it is sent.
     */
    binary(buf) { port.postMessage(buf, [buf]); },

    close() { try { port.close(); } catch {} },
  };
}

/**
 * Route inbound traffic for a session. Kept separate from attachPort so the
 * routing is testable without a real MessagePort.
 */
export function makeRouter({ handleControl, handleBinary }) {
  return async (data) => {
    if (isBinary(data)) return { channel: 'binary', result: await handleBinary?.(data) };
    return { channel: 'control', result: await handleControl?.(data) };
  };
}

export { isBinary };
