# dshub-sidecar — the DataSource Hub, outside the browser

This is the **same `Hub`** the SharedWorker runs, hosted in a Node process, on
Perspective's Node engine, exposed to subscribers over **socket.io**. It is not a
stand-in and not a spec: a blotter points its transport at this process's URL and
drives it through the exact same `ControlClient`/`Transport` it uses against the
in-page worker. "Which host am I on" is a URL, not a code path.

Why it exists (architecture §2.2): a desk that outgrows the browser's wasm memory
ceiling, or needs an AMPS/Solace feed a browser tab cannot open, moves to this
host **without touching the blotter**.

## Run it

```sh
node apps/dshub-sidecar/server.mjs           # listens on ws://127.0.0.1:8787
DSHUB_PORT=9000 node apps/dshub-sidecar/server.mjs
```

It loads the example bundle (`packages/dshub-spec/examples/positions-stomp.config.json`)
and the `positions` artifact, creates the real Perspective tables on demand, and
serves every connecting subscriber from one shared hub — one upstream, many
subscribers, exactly as in the browser.

## Prove it runs (real engine, end to end)

```sh
node apps/dshub-sidecar/smoke.mjs
```

Boots the sidecar, connects the provider's own client over `socketIoPort`,
subscribes, writes rows into the **real** Perspective table, and reads the count
back over the socket — including a filter evaluated in the engine. Prints `OK`
when the hub has served real data from outside the browser.

## How a browser connects

Identical to the SharedWorker path, with the port swapped:

```js
import { socketIoPort } from '@wellsfargo-starui/dshub-provider/src/socketPort.mjs';
const transport = new Transport({
  connect: () => socketIoPort('ws://sidecar-host:8787', { openSocket: (u) => new WebSocket(u) }),
  onControl: (m) => control.handle(m),
});
```

`socketIoPort` returns a MessagePort-shaped object, so `Transport`/`ControlClient`
run unchanged — the transport swap is invisible above the port.

## The two proofs

| | engine | proves |
|---|---|---|
| `packages/dshub-worker/test/sidecar.conformance.test.mjs` | stub | the **transport** — handshake, framing, rejection, sharing — deterministic, runs in CI |
| `apps/dshub-sidecar/smoke.mjs` | real Perspective (Node) | the **engine** — the hub actually serves real data out of the browser |

## What still belongs to the Rust host

A Rust build on `perspective-server` is the eventual native host (lower memory
overhead than wasm, and the AMPS/Solace adapters). This JS sidecar is a fully
working out-of-browser host today; the Rust twin, when built, must pass the same
conformance exchange this one does. See `docs/implementation-plan.md` Phase 10
and `docs/phase-0-findings.md` §26.
