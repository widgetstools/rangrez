/**
 * SharedWorker bootstrap — the first host.
 *
 * One worker per origin. Every tab connects a MessagePort to it, and they all
 * share the same Hub, so two blotters on the same datasource cost ONE upstream
 * subscription and ONE table.
 *
 * Deliberately thin: everything testable lives in hub.mjs / control.mjs /
 * port.mjs, which run under Node. This file is the part that can only be
 * exercised in a browser, so it holds as little logic as possible.
 */

import { Hub } from './hub.mjs';
import { attachPort } from './port.mjs';
import { handleControl } from './control.mjs';

let hub = null;
let nextSessionId = 1;
const sessions = new Set();

/** Bootstrapped from IndexedDB in the real host; injected by the harness in tests. */
async function loadBundle() {
  if (globalThis.__DSHUB_BUNDLE__) return globalThis.__DSHUB_BUNDLE__;
  const res = await fetch('./config.json');
  return res.json();
}

async function ensureHub(schema) {
  if (hub) return hub;
  const bundle = await loadBundle();
  hub = new Hub({
    bundle,
    openSocket: (url) => new WebSocket(url),
    // Engine seam. A stub table keeps the worker useful before Perspective is
    // wired in; swapping it is a one-line change here and nowhere else.
    createTable: async (name) => {
      const rows = new Map();
      return {
        name,
        update(block) {
          const keys = block.__key ?? [];
          for (let i = 0; i < keys.length; i++) {
            const row = rows.get(keys[i]) ?? {};
            for (const [c, vals] of Object.entries(block)) row[c] = vals[i];
            rows.set(keys[i], row);
          }
        },
        size: () => rows.size,
        _rows: rows,
      };
    },
  });
  hub.schema = schema;
  return hub;
}

/** One connected tab. */
function makeSession(port) {
  const id = nextSessionId++;
  const channel = attachPort(port, {
    onControl: async (msg) => {
      const h = await ensureHub(globalThis.__DSHUB_CONTROL_SCHEMA__);
      const session = sessionsById.get(id);
      const reply = await handleControl(msg, { schema: h.schema, validate: h.validate, hub: h, session });
      if (reply) channel.control(reply);
    },
    // Perspective's protocol, passed straight through. Never parsed here.
    onBinary: (buf) => { sessionsById.get(id)?.onBinary?.(buf); },
  });

  const session = {
    id,
    subscriptions: new Set(),
    send: (msg) => channel.control(msg),
    sendBinary: (buf) => channel.binary(buf),
    close: () => channel.close(),
  };
  sessionsById.set(id, session);
  sessions.add(session);
  return session;
}

const sessionsById = new Map();

/** SharedWorker entry point. */
globalThis.onconnect = (e) => {
  const port = e.ports[0];
  const session = makeSession(port);
  ensureHub(globalThis.__DSHUB_CONTROL_SCHEMA__).then((h) => {
    h.sessions.add(session);
    session.send({ id: 'hello-0', type: 'result', payload: { ready: true, sessionId: session.id, sessions: h.sessions.size } });
  });
};

/**
 * A dedicated Worker or a direct import gets the same wiring, which is what
 * lets the harness drive this without a SharedWorker.
 */
export { ensureHub, makeSession, sessions };
