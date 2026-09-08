# DataSource Hub — Implementation Plan

**Companion documents:** `architecture.md`, `ssrm-parity-study.md`

---

## 0. How to read this

Ten phases. Each has a **goal**, a **file-level deliverable list**, **exit criteria** that are testable rather than aspirational, and the **risk it retires**.

Phases 1–5 produce a working single-datasource blotter on the sidecar. Phases 6–8 add the parity and configuration surface that make it usable by a desk. Phases 9–10 are hardening and the second host.

Two rules that keep this lean:

- **No phase introduces an abstraction that has only one implementation**, except the §8.1 engine seam, which is deliberate.
- **Every phase ends with something demonstrable.** If a phase cannot be demoed, it is scoped wrong.

Effort figures assume one engineer full-time on the phase, with a second on parallel tracks where noted.

---

## Phase 0 — Spike and decide (2.5 weeks) — **RUN; see `phase-0-findings.md`**

**Goal:** retire the engine risk before building on it — in the host that ships first.

> **Outcome: go on Perspective, with two plan changes.** The engine moved to `@perspective-dev/*` 5.3.0 (`@finos/perspective` is deprecated). Memory64 removes the wasm32 ceiling this phase was built around. Grouped-view creation costs ~300 ms and degrades with live view count, which damages SSRM and promotes VRM. Browser confirmation of Memory64 is still outstanding and is load-bearing. Full detail in `phase-0-findings.md`.

**Do only this:** — and do it in **Perspective wasm inside a SharedWorker**, not `perspective-server` in Rust. The worker is the first host (architecture §2.2), so it is the host the spike must de-risk.

1. **wasm32 headroom — the number this phase exists for.** Load the real working set into Perspective wasm in a SharedWorker: **10 concurrent tables, 1–2 of them at 500k × 160 and the rest small.** Measure resident memory, then keep loading until the address space is exhausted and record where it dies.
   The arithmetic going in: ~500 MB for a large table puts the stated working set near **1.4 GB against a practical wasm32 ceiling of ~2 GB.** That fits, with perhaps 30% headroom. Thin enough that this is the measurement most likely to change the plan, and thin enough that the §6.2 process ceiling has to be real rather than theoretical.
2. Create 100 concurrent grouped views (simulating SSRM node expansion). Measure creation latency and incremental memory per view. **Dispose all, assert memory returns to baseline.** Views come out of the same 2 GB, so a leak here is a dead tab, not a slow sidecar.
3. Drive 20k updates/sec at a column that is also the sort key. Measure how much of a windowed view's index churns. Note the worker is single-threaded — measure whether ingest starves the query path.
4. **Aggregations, testing the decomposition first.** Take the top five FI aggregations the desks actually use. For each, in order:
   a. Does it decompose into `sum(w·x) / sum(w)`, computable by emitting the product column at ingest and dividing client-side? Most weighted averages do, and this path needs no engine support at all.
   b. If not, is it expressible in Perspective's fixed aggregate set directly?
   c. If neither, does a hub-side post-aggregation pass over the group results reach it?
   Record the answer per aggregation, not just a count of failures.
5. Wire a trivial AG-Grid to a Perspective client over a MessagePort and measure ingest-stamp → `applyTransactionAsync` return, p50/p95/p99.
6. Benchmark `to_json` vs `to_columns` + pivot vs `to_arrow` + decode + pivot at 160 columns.
7. **VRM feasibility — one day, and it can retire a week and a half of Phase 8.** `architecture.md` §8.2 claims Perspective's expanded tree is already a flat indexed list, which is exactly the shape viewport row model wants. If that holds, VRM sidesteps most of `ssrm-parity-study.md` §5: route computation, group-key change as remove-plus-add, `StoreNotFound`, sort-position drift, aggregate staleness, and the cell-selection-past-viewport bug.
   a. Grouped view over the fixture; `expand`/`collapse` a few levels.
   b. `to_columns({start_row, end_row})` against the expanded tree — confirm indices are stable and contiguous across expand/collapse.
   c. Trivial AG-Grid viewport row model with a `__ROW_PATH__` tree cell renderer.
   d. Drive updates in; observe what the viewport datasource actually has to do on a row change.
   Record the costs honestly too: custom tree cell renderer instead of native grouping UI, different selection semantics, a much thinner base of community answers. VRM may lose on those grounds — but that verdict is worth a day now rather than week 14.

   AG-Grid's own v36 guidance cuts both ways and should be read before the probe, not after. It warns that "many of our users use Viewport Row Model when they don't need to and end up with more complicated applications as a result" — while describing its fit as "a large amount of changing data" where you "want to push updates to the client when the server-side data changes," and notes that VRM alone tells the server exactly which rows a user is looking at. That is this system, precisely. The warning is about reaching for VRM casually; the described fit is the case we actually have. Neither settles it — the probe does.
8. **STOMP-over-WebSocket from a SharedWorker**, against the live ViewServer endpoint. Confirm the browser can hold the subscription, that heartbeats survive a backgrounded tab, and that the trigger-reply snapshot pattern works without a native socket.

**Exit criteria**
- A one-page memo with numbers, and a go/no-go on Perspective wasm for the worker host.
- **Headroom verdict from (1).** Comfortable → proceed. Under ~25% → the §6.2 ceiling needs eviction, not just refusal, and large-table desks are sidecar-only from the start.
- **Aggregation verdict, pre-committed before the spike runs so it is not negotiated after two weeks of sunk cost:** 0–1 of five unreachable after path (a) → proceed unchanged. 2 → proceed, with the shortfall named in writing and an owner for each workaround. 3 or more → decisive against Perspective; re-plan.
- **VRM verdict from (7).** If VRM is viable for the >200k grouped case, re-sequence Phase 8: 8f moves ahead of 8e, and 8e/8g scope shrinks to what VRM does not cover.
- **Backgrounded-tab verdict from (8).** If browsers throttle the worker's socket badly enough to drop the subscription, that is a finding about the whole worker-first plan and needs to surface now.
- The read-format winner from (6) is chosen and will not be revisited.

**Risk retired:** building nine phases on an engine that cannot do grouped views at scale, cannot hold the working set inside a 32-bit address space, or cannot express the aggregations the business needs.

---

## Phase 1 — Spec and codegen (1 week)

**Goal:** the shared source of truth exists before either host is written.

**Deliverables**

| File | Contents |
|---|---|
| `packages/dshub-spec/datasource-config.schema.json` | Connection profile, datasource definition, snapshot union, `x-reloadClass` on every field |
| `packages/dshub-spec/schema-artifact.schema.json` | Columns, types, cardinality, filter strategy, colDef fragments, companion columns, volatile sort columns |
| `packages/dshub-spec/control-protocol.schema.json` | Every message in architecture §7.2, request/response and events |
| `packages/dshub-spec/dsl-grammar.md` | Grammar, AST node types, capability matrix per backend |
| `packages/dshub-tools/src/codegen.ts` | → TS types + runtime validators, Rust serde types |
| `packages/dshub-spec/corpus/` | Initial recordings from two real datasources |
| `pnpm-workspace.yaml` catalog | React 19.3 and AG-Grid 36.0.0 declared once; every package references `catalog:` (architecture §2.1) |
| AG-Grid v36 API verification pass | Walk `ssrm-parity-study.md` §2.2, §2.4 and §2.5 against the pinned 36.0.0 docs and correct in place. Two known drifts are already recorded there; the rest is unchecked. Cheap now, a rewrite in Phase 8 |

**Exit criteria**
- `pnpm codegen` produces types for both languages into `packages/dshub-spec/src/generated/` and `hub-rust/src/generated/`, checked into CI as a diff-must-be-empty step.
- A hand-written config for one real ViewServer datasource validates against the schema.
- Config validation rejects a config containing a password-shaped field. (Unit test.)
- No package declares a literal `react` range; all resolve through the catalog to one version. (CI check — cheap to write, and it is the only thing preventing a second React in the OpenFin host.)

**Risk retired:** the two hosts drifting apart, and the config growing organically into an unmaintainable blob.

---

## Phase 2 — Worker hub skeleton, one transport (2.5 weeks)

**Goal:** a SharedWorker that connects to STOMP over WebSocket, builds a snapshot, and serves it to the page's Perspective client over a MessagePort.

**This is the first host.** The Rust sidecar is Phase 10. Ordering per the host decision recorded in architecture §2.2 — everything through Phase 9 is TypeScript, which removes a language boundary from the critical path and lets the whole stack iterate in one toolchain.

**Deliverables**

| File | Scope |
|---|---|
| `worker.ts` | SharedWorker bootstrap, `onconnect`, per-port session state, structured logging to a ring buffer |
| `config.ts` | Load generated types from IndexedDB, validate before swap, reload-class dispatch |
| `port.ts` | MessagePort split: plain objects = control, `ArrayBuffer` transfers = Perspective. Verify the custom-transport hook against the pinned Perspective version |
| `control.ts` | `hello`, `subscribe`, `unsubscribe`, `state` events |
| `registry.ts` | Cache key, refcount, `idleTeardownMs`, `maxRows` guard, process ceiling (§6.2), state machine |
| `table_actor.ts` | Single-writer queue with bounded depth, micro-batching, **column-oriented `table.update()`**, table lifecycle |
| `adapters/stomp.ts` | STOMP over WebSocket: connect, heartbeat, subscribe, trigger-reply snapshot, EOS sentinel + timeout + count validation, reconnect with backoff, failover list |
| `normalize.ts` | Flatten, coerce, op-map, partial-patch handling, soft delete — **the reference implementation the Rust twin must match in Phase 10** |

**Deliberately deferred:** other transports, superset sharing, queries, alerts, stats, hot reload beyond reload-on-rebuild.

**Simpler than the sidecar would have been, and worth naming:** no localhost WebSocket server, no port file, no single-instance mutex, no handshake token, no Origin allowlist. A MessagePort is same-origin by construction, so architecture §7.3 is deferred wholesale to Phase 10 rather than being v1 attack surface.

**Exit criteria**
- A page opens a Perspective client over the worker's MessagePort and reads the largest real table into a plain grid.
- Two browser tabs share one worker and one upstream subscription. Verified: one STOMP connection, two ports.
- Killing upstream mid-snapshot produces `failed`, not `live`. (Automated.)
- Row count mismatch against `expectedCountHeader` produces `failed`.
- Convergence property test passes: random insert/update/delete sequences converge to a naive fold oracle.
- **Resident memory against the Phase 0 wasm32 headroom figure**, with the guard firing rather than the tab dying.

**Risk retired:** snapshot atomicity and truncation — the highest-consequence correctness failure in the system — plus the wasm memory ceiling, now a front-line constraint rather than a Phase 10 footnote.

---

## Phase 3 — Schema inference and colDef generation (1.5 weeks, parallelisable)

**Goal:** onboarding a new datasource is a sampling run plus a review, not a hand-written config.

**Deliverables**

| File | Scope |
|---|---|
| `tools/infer-schema.ts` | Sample N messages or until every leaf seen non-null M times; emit candidate artifact with paths, types, nullability, cardinality, min/max, samples, max string length |
| Inference rules | Widen int→float never narrow; numeric-looking strings stay strings; datetime only above threshold **and** confirmed; boolean only on exact value sets |
| `provider/src/coldefs.ts` | Artifact → `ColDef[]`: filter strategy by cardinality, alignment, precision from observed decimals, width from max length, `enableRowGroup`, `sortColumn` pointing at companions |
| FI coercions | `ticks-to-decimal` with companion numeric column, and the two or three siblings your catalog needs |

**Exit criteria**
- Sampling a live ViewServer topic produces a reviewable artifact.
- The artifact plus your existing 250-field catalog generates colDefs for a real blotter that a trader recognises without hand-editing.
- A column of 32nds prices sorts numerically via its companion.
- An unknown path arriving mid-session is logged and reported, never silently added.

**Risk retired:** per-datasource hand-written column config, which does not scale past ten datasources.

---

## Phase 4 — Provider, CSRM mode (2 weeks)

**Goal:** a real blotter, live, in CSRM, end to end.

**Deliverables**

| File | Scope |
|---|---|
| `transport.ts` | WebSocket, text→control, binary→perspective; reconnect with resume |
| `control.ts` | Typed client, id correlation, timeouts, typed errors |
| `engine.ts` | The seam. `PerspectiveAdapter` implementing it |
| `modes/csrm.ts` | First window → rowData or progressive add; `on_update` → `applyTransactionAsync`; `getRowId` from key columns |
| `dataService.ts` | Interface + **full CSRM implementation of every method** |
| `state.ts` | Layout/config persistence |
| `apps/dshub-blotter` | Demo blotter hosting the provider — the phase's demoable artifact, and later the parity-harness target |

**Two behaviours that must be explicit here:**
- Soft-delete flag → `remove` transaction.
- The user's filter model stays **client-side** in CSRM. Do not push it into the view, or filtered-out rows become ghosts.

**Exit criteria**
- A production-shaped blotter runs live against the worker with a real desk dataset from the live ViewServer endpoint.
- `GridDataService` is fully implemented for CSRM — all eleven methods — so downstream UI work is unblocked with zero hub dependency.
- Deleting a row upstream removes it from the grid.
- Latency histogram from ingest stamp to transaction apply is captured and within the Phase 0 numbers.

**Risk retired:** the transport, the seam, and the delta path. After this, everything is additive.

---

## Phase 5 — Diagnostics (0.5 week)

**Goal:** stop debugging blind. Do this *now*, not before UAT.

**Deliverables**
- `stats.rs`: per-datasource msgs/sec in and out, conflation ratio, cache rows, memory, subscriber count, open view count, last error, running config version, backpressure rung.
- `statsTick` event on the control channel.
- Diagnostics screen in `packages/dshub-admin`: table of datasources, state badges, sparklines, latency histogram, active mode per blotter, process memory against the §6.2 ceiling. Built as a mountable screen, not a bespoke window, so OpenFin and `apps/dshub-console` render the same component.
- Record/replay: capture raw upstream to JSONL; replay deterministically as a `file-seed` snapshot mode.

**Exit criteria**
- Every question in the form "why is this blotter behaving oddly" can be answered from the screen without attaching a debugger — including "why was my subscription refused," which reads the §6.2 budget.
- A recorded session replays and produces identical table state.

**Risk retired:** integration-phase debugging cost, which is otherwise the largest hidden schedule item.

---

## Phase 6 — Remaining transports and sharing (2 weeks)

**Goal:** the hub is genuinely multi-source and genuinely shared.

**Deliverables**

| Item | Notes |
|---|---|
| `adapters/rest.ts` | `rest-then-subscribe`, pagination |
| `adapters/ws.ts`, `socketio.ts` | Raw WebSocket and socket.io |
| ~~`adapters/solace`~~, ~~`adapters/amps`~~ | **Not reachable from a browser. Moved to Phase 10 with the sidecar.** A datasource on either transport cannot be served in v1 — worth confirming no desk needs one before Phase 6 starts |
| Superset sharing | `sharing.strategy`, filtered views per subscriber |
| Entitlements | Table-open check, mandatory non-removable filter clause |
| Backpressure ladder | Send-queue depth monitoring; conflate harder → snapshot refresh → disconnect |
| Upstream reconnect diff | Shadow re-snapshot, diff, minimal transaction set |

**Exit criteria**
- All four browser-reachable transports (STOMP, raw WS, socket.io, REST) serve the same blotter from config alone, no code change per datasource. AMPS and Solace wait for Phase 10.
- Two subscribers with different `book` params share one upstream subscription. Verified in stats: one connection, two subscribers.
- ~~An unentitled subscriber cannot open a table.~~ **Deferred — v1 is single-desk**, so admission is a no-op and the mandatory clause is empty. Architecture §6.1 stays written and unimplemented; revisit when a second desk arrives.
- A deliberately stalled subscriber degrades through the ladder and is disconnected without affecting others.
- Upstream reconnect does not cause a full grid repaint or scroll jump.

**Risk retired:** the "one stop shop" claim, which is otherwise aspirational.

---

## Phase 7 — Config store and admin UI (1 week, parallel track)

**Goal:** datasource onboarding is a self-service workflow, with no config server.

**Deliverables**

| Component | Scope |
|---|---|
| `packages/dshub-provider/src/configStore.ts` | IndexedDB wrapper; object stores per architecture §3.5; `onupgradeneeded` migrations from day one; **validate on every write** using the generated JSON Schema validators |
| Bundle codec | Export/import format, canonicalization, sha256 checksum, `specVersion` gate, secret stripping |
| Import modes | Dry run (default) / merge-incoming / merge-local / replace-all, each in a single IDB transaction |
| ~~Sidecar reconcile~~ | **Deferred to Phase 10.** There is no sidecar in v1, so IndexedDB is the only store and the worker reads it directly — config is effectively per-app, per architecture §3.6. The `(bundleVersion, checksum)` conflict rule is specified and ships with the sidecar |
| Export / import as the sync path | Until Phase 10, moving config between OpenFin apps means export → import, and the bundle-in-git process carries more weight than it otherwise would |
| Hot reload | Dispatch by `x-reloadClass`: live / resubscribe / rebuild / restart |
| Credential resolution | `credentialRef` only; token-from-app preferred; password-shaped-field rejection on write, export **and** import |
| `dshub-admin`: editors | Connection and datasource forms driven by the JSON Schema |
| `dshub-admin`: test connection | Connect, trigger snapshot, capture first N, report sentinel arrival, timing, row count, headers. Read-only, no table created |
| `dshub-admin`: sample and infer | Capture → inference pass → review → save artifact `@vN` to IDB → generate colDefs |
| `dshub-admin`: flatten preview | Paste or capture a raw message, see flattened output side by side. Catches array-strategy mistakes instantly |
| `dshub-admin`: diagnostics | Read the hub stats stream — worker over MessagePort in v1, sidecar over WebSocket from Phase 10 |
| `dshub-admin`: export / import / diff | The diff view replaces promotion-with-review; ~200 lines over a plain object diff |
| Optional: seed URL | `dshub.seedUrl` → static JSON on an intranet path; offer import when its `bundleVersion` exceeds local. ~50 lines. Build when a second desk wants the same datasource |

**Process, not code:** exported bundles live in git. Export → commit → PR → review restores the audit trail and change review a config server would have provided. Adopt from day one.

**Exit criteria**
- A new datasource goes from "here is a topic name" to "working blotter" without an engineer writing code.
- An IDB schema migration runs cleanly against a store populated by the previous version.
- Export → wipe browser storage → import reproduces byte-identical config.
- A bundle with a tampered checksum, a newer `specVersion`, or an embedded password is refused.
- ~~Two OpenFin apps converge via the sidecar.~~ **Deferred to Phase 10.** v1 exit criterion is narrower: export from one app, import into another, byte-identical config, and a tampered or newer-`specVersion` bundle refused.
- Changing a conflation interval applies live and does **not** cause a re-snapshot; changing key columns triggers a rebuild and clean client re-init.

**Risk retired:** engineering becoming the bottleneck for every new dataset — and, with the sidecar reconcile, config loss when a user's browser storage is cleared.

---

## Phase 8 — SSRM, VRM, and parity (4 weeks)

**Goal:** large datasets behave like small ones. This is the biggest phase; sequence it internally per `ssrm-parity-study.md` §9 — **with one change from Phase 0: run 8f (VRM) before 8c–8e.**

Phase 0 measured grouped-view creation at ~300 ms on 200k rows, degrading to ~490 ms each with 100 views held open. SSRM needs a view per expanded node; VRM needs one view total, and its `__ROW_PATH__` is already the flat indexed list a viewport row model wants. If VRM covers the grouped case on real data, 8e (live update routing) and much of 8g shrink to what VRM does not handle.

**8a — Query RPCs (1 week)**
- `queries.rs`: `distinctValues` (grouped view + `set_depth(1)`, **disposed immediately**), `searchValues` prefix query, `rowCount`, `aggregates`, `rank`, `export` streaming, `scan` streaming.
- Distinct-value cache: keyed `(datasourceId, colId, contextHash)`, ~30s TTL, single-flight, invalidated on unseen values for set-filter columns only.
- Cardinality guard and the custom search-select filter component.
- Cascading values as a per-column opt-in flag.

**8b — Filter translation (0.5 week)**
- AST-based translator with golden-file tests.
- Blank vs empty string, case sensitivity, range inclusivity, empty set = match nothing.

**8c — SSRM datasource, flat (1 week)**
- `getRows` → view spec → window read.
- `getRowId` with `\u0001` separator, byte-identical to the hub's key encoding.
- View LRU cache keyed by request signature, disposal on eviction.
- Cache block sizing, `getServerSideGroupLevelParams`, `maxBlocksInCache`, `blockLoadDebounceMillis`.

**8d — Grouping and aggregation (0.5 week)**
- Next-level `group_by` only, `set_depth(1)`, `groupKeys` → equality filters.
- Sort-key columns replaced by companion columns where custom comparators were used — **custom comparators are never called in SSRM.**

**8e — Live update routing (1 week)**
- Route computation; group-key change as remove+add; `StoreNotFound` handled as normal, not an error.
- Sort-position drift policy per `volatileSortColumns`, defaulting to drift over refresh.
- **Group-level aggregate deltas:** hub maintains a parallel grouped view and forwards its `on_update`. This is what makes SSRM feel live rather than laggy.

**8f — VRM (0.5 week) — PROMOTED: do this FIRST, before 8c–8e**
- Flat indexed tree, `expand`/`collapse`, `__ROW_PATH__` tree cell renderer.
- Automatic mode selection from row count and grouping complexity.

**8g — Remaining parity gaps**
- Quick-filter replacement over a configured column subset (never all 160).
- Export/copy-all/scan wired to the RPCs.
- `rankOf` for scroll-to-row.
- Selection-as-predicate resolution.
- Cell selection fix: track anchor and focus keys in a hook, reconcile on `cellSelectionChanged`, restore after blocks load.

**Exit criteria**
- Parity harness passes: same dataset, same config, CSRM vs SSRM, identical row keys and aggregates across the sort/filter/group matrix.
- View leak test passes: 500 expand/collapse cycles and 50 filter opens return the hub's open-view count to baseline.
- Cell selection survives a scripted drag past the viewport at three scroll speeds.
- A trader on a 500k-row blotter cannot identify which mode they are in without looking at diagnostics.

**Risk retired:** the whole reason the hub exists.

---

## Phase 9 — DSL, alerts, and the write path (2 weeks)

**Deliverables**

| Item | Scope |
|---|---|
| `dsl/parse.ts` | Grammar → AST |
| `dsl/eval.ts` | Tree-walking interpreter, **no `new Function`** (OpenFin CSP, and injection surface for LLM output); compilation hoisted out of the render path |
| `dsl/compile-perspective.ts` | AST → ExprTK string; stable column ids resolved at compile time; typed errors on unsupported constructs |
| Capability matrix | Rule using regex → typed error, marked client-only in UI, never silently divergent |
| Authoring validation | Compile and dry-run against live schema before persisting |
| `alerts.rs` | One view per rule, predicate as filter, `on_update` → `alert` event |
| Write path | `command` RPC, correlation, timeout, typed errors; optimistic apply with pending marker; reconcile on echo |
| Chatbot integration | LLM configurator emits DSL, not ExprTK; structured compile errors feed a repair loop |

**Exit criteria**
- A conditional styling rule authored in the admin UI applies client-side with no view rebuild.
- A calculated column used for grouping is compiled into the Perspective view.
- An alert fires on a row that is outside the viewport and outside the active filter.
- A rejected rule reports *why* and offers the client-only fallback.
- An order placed from the blotter applies optimistically and reconciles against the authoritative echo.

**Risk retired:** styling and alerting becoming per-blotter code, and the LLM configurator producing unvalidatable expressions.

---

## Phase 10 — Rust sidecar host (3 weeks)

**Goal:** the second host, built last, on top of a proven design — and the transports a browser cannot reach.

**Deliverables**
- `hub-rust/`: mirror of the worker modules in Rust on `perspective-server`. Edition 2021 (the pinned 1.78 toolchain predates edition 2024).
- `main.rs`: single-instance mutex, port allocation, port file in the user profile dir, graceful shutdown.
- `server.rs`: `127.0.0.1` bind, Origin allowlist, Host header check, handshake token — architecture §7.3 in full, deferred from Phase 2 because the worker never needed it.
- `adapters/amps.rs`, `adapters/solace.rs`: **the transports that are only reachable from a native process.** Until this phase, AMPS and Solace datasources cannot be served at all.
- Config sync via the sidecar (architecture §3.6), including the `(bundleVersion, checksum)` reconcile. Cross-app config sharing does not exist before this phase.
- Arrow `RecordBatch` per micro-batch rather than the worker's columnar object path.

**Exit criteria**
- **Conformance corpus passes: the TypeScript and Rust normalizers produce byte-identical Arrow for every recorded message.** The worker is the reference; Rust must match it. This is the phase's real deliverable.
- The same blotter runs unchanged against either host, selected by config.
- An AMPS or Solace datasource serves a blotter, from config alone.
- Two OpenFin apps converge their config through the sidecar without silent overwrite.
- Resident memory for the full working set with no wasm ceiling — the reason a desk with more or larger tables would move to this host.

**Risk retired:** host drift, which would otherwise surface as "it works in the worker but not the sidecar" bugs with no clean reproduction — and the AMPS/Solace gap that v1 ships with.

**Built so far — the JS transport foundation and the conformance oracle (see findings §26).**
The user fixed the design: the sidecar *is* the current hub, run outside the browser,
with subscribers reaching it over socket.io. So the JS-side work for this phase is not the
Rust rewrite — it is proving the hub is genuinely host- and transport-independent and pinning
that as an executable spec:
- `dshub-spec/src/socketio-codec.mjs` — the Engine.IO / Socket.IO codec shared by both ends (+ `encodeOpen`).
- `dshub-provider/src/socketPort.mjs` — `socketIoPort(url,{openSocket})` returns a MessagePort-shaped
  object, so the existing `Transport`/`ControlClient` run against the sidecar UNCHANGED.
- `dshub-worker/src/sidecarServer.mjs` — `attachSidecarSocket(...)` routes every event through the SAME
  `handleControl` the SharedWorker uses; only the byte-plumbing differs.
- `dshub-worker/test/sidecar.conformance.test.mjs` (4 cases) — the real `Hub` behind a real `ws` loopback,
  reached by the provider's own client over `socketIoPort`: `hello`/`subscribe`/`rowCount` round-trip,
  malformed and version-mismatch rejected identically, and two clients collapse to ONE hub entry over the
  socket. This pins the transport with a stub engine (deterministic, in CI).
- **`apps/dshub-sidecar/` — the DataSource Hub running OUTSIDE the browser, today.** `server.mjs` hosts the
  real Hub on Perspective's Node build behind the same engine seams the browser host wires, over a `ws`
  socket.io endpoint; `smoke.mjs` boots it, drives it with the provider's own client over `socketIoPort`,
  writes rows into the REAL table, and reads the count back over the socket. The out-of-browser host is not
  deferred to Rust — it exists and runs. **Rust remains the eventual NATIVE host** (lower memory overhead
  than wasm; AMPS/Solace adapters a browser cannot open) and must pass this same conformance exchange to be
  the "exact replica" — but it is now a second implementation of a working host, not the only way out of the
  browser.

---

## Schedule

| Phase | Weeks | Track |
|---|---|---|
| 0 Spike | 2.5 | — |
| 1 Spec | 1 | A |
| 2 Worker hub | 2.5 | A |
| 3 Inference | 1.5 | B (parallel with 2) |
| 4 Provider CSRM | 2 | A |
| 5 Diagnostics | 0.5 | A |
| 6 Transports and sharing | 2 | A |
| 7 Config store and admin | 1 | B (parallel with 6) |
| 8 SSRM/VRM/parity | 4 | A |
| 9 DSL, alerts, write path | 2 | B (parallel with 8) |
| 10 Rust sidecar + AMPS/Solace | 3 | A |

**Single engineer, serial:** ~20 weeks.
**Two engineers on tracks A and B:** ~16 weeks (track B is no longer the constraint; A dominates).

**Phases 0–9 are TypeScript only.** Worker-first removes Rust from the critical path entirely — the sidecar is one phase at the end rather than a language boundary running through the middle. That is the largest schedule benefit of the host decision, and it is worth more than the half-week Phase 2 gained.

Cross-checking against volume: ~26–29k production lines over ~140 engineer-days is ~200 LOC/day. Fine for React screens, optimistic for `table_actor.rs` and `modes/ssrm.ts`, where 80–120/day including tests is realistic. Budget **19–20 weeks for two engineers**; Phases 2 and 8 are the ones that will slip.

First demoable blotter at end of Phase 4 — roughly week 9.5 serial, week 8 with two engineers.

---

## Leanness checkpoints

Review at the end of Phases 4, 8, and 10. Fail any of these and something has been over-built:

- Source file count under 60, excluding generated types, `dshub-admin`, and the `apps/` demos.
- Exactly one interface with a single implementation (`EngineAdapter`), and it is justified by the CQServer option.
- No dependency injection container in the Rust hub.
- No abstraction over WebSocket. The socket is the socket.
- No message envelope. Text is control, binary is Perspective.
- Adding a seventh transport touches one new file plus one match arm.
- Adding a datasource touches zero source files.

That last one is the real test. If onboarding a dataset requires code, the spec-driven design has failed and the architecture should be revisited rather than worked around.
