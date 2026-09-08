# DataSource Hub — Architecture

**Version:** 1.0
**Companion documents:** `ssrm-parity-study.md`, `implementation-plan.md`

---

## 0. Design principles

These constrain every decision below. When a choice is ambiguous, resolve it against this list.

1. **One engine, one protocol.** Perspective carries all bulk data on its own wire protocol. We do not write a chunking protocol, a delta format, or a paging scheme.
2. **Two hosts, one design.** SharedWorker (TypeScript) and sidecar (Rust) are the same architecture with different transports. Anything that differs between them is a bug or a deliberate, documented exception. **The worker ships first** — see §2.2 for what that costs and what it buys.
3. **Specs, not layers.** Behaviour that must match across hosts lives in a declarative spec plus a conformance corpus, not in a shared abstraction. Two small interpreters that pass the same tests beat one clever abstraction.
4. **Two channels, one socket.** WebSocket *text* frames carry control JSON. *Binary* frames carry the Perspective protocol. No envelope, no multiplexing code.
5. **One writer per table.** All mutation of a Perspective table goes through a single actor fed by a bounded channel. No locks, no concurrent `update()`.
6. **Concrete types, one seam.** There is exactly one engine abstraction — a single module with concrete function signatures. No plugin framework, no DI container, no repository/service/controller stack.
7. **The provider is the only place AG-Grid exists.** The hub knows nothing about grids, row models, or column definitions.

**What we are deliberately not building:** a custom wire protocol, a query language, a row-model server, an ORM, a message bus, an abstraction over WebSocket, a plugin system, or a generic "connector framework."

---

## 1. System view

```
┌─ Upstream ──────────────────────────────────────────────────┐
│  STOMP   REST   AMPS   Solace   raw WS   socket.io          │
└───────────────────────────┬─────────────────────────────────┘
                            │ adapters
┌───────────────────────────▼─────────────────────────────────┐
│  HUB  (SharedWorker now  ·  sidecar process at Phase 10)    │
│                                                             │
│   Adapter ──▶ Normalizer ──▶ TableActor ──▶ Perspective     │
│                                (1 per table)     Server      │
│                                                             │
│   Registry (refcount, lifecycle)   Queries   Stats   Alerts │
└───────────────────────────┬─────────────────────────────────┘
            control: objects │  binary: perspective protocol
            (MessagePort now; WebSocket text/binary with the sidecar)
┌───────────────────────────▼─────────────────────────────────┐
│  DATAPROVIDER  (browser, npm package)                        │
│                                                             │
│   Transport ─▶ perspective Client ─▶ Table/View handles     │
│   ControlClient ─▶ GridDataService ─▶ CSRM | SSRM | VRM     │
│   ColDefBuilder   DSL evaluator   StateManager              │
└───────────────────────────┬─────────────────────────────────┘
                            │
                  AG-Grid  (OpenFin / browser)

┌─ Control plane (client-side) ───────────────────────────────┐
│  Admin UI (React)  ◀──▶  IndexedDB  ◀──▶  export/import     │
│  datasource config · schema artifacts · DSL rules           │
│  export/import in v1; sidecar sync at Phase 10 (§3.6)       │
└─────────────────────────────────────────────────────────────┘
```

Roughly 40 source files total. If it grows past 60, something has been over-abstracted.

---

## 2. Repository layout

This lives in the existing `rangrez` pnpm/turbo monorepo rather than a repo of its own. Phases 1–8 are one continuous change across both sides of the §8.1 seam, and a single workspace keeps spec codegen, the provider and the admin screens moving together without a publish step between every change.

The workspace convention holds: **`packages/` is libraries, `apps/` is demos and test harnesses.** Everything the desk's OpenFin app consumes — including the admin screens, which it mounts rather than launches — is a package. What lives in `apps/` exists to exercise those packages. The Rust hub is neither, so it sits as a top-level sibling built by cargo and wired into turbo as an external task.

Revisit once the provider is stable and a second desk consumes it — at that point `@wellsfargo-starui/dshub-provider` as a published package, with the hub extracted, becomes the better shape.

```
rangrez/
  packages/
    dshub-spec/                          # single source of truth, codegen input
      datasource-config.schema.json
      schema-artifact.schema.json
      control-protocol.schema.json
      dsl-grammar.md
      corpus/<datasource>/{raw.jsonl, expected.arrow, config.json}
      src/generated/                     # codegen output, TS types + validators

    dshub-provider/src/                  # @wellsfargo-starui/dshub-provider
      transport.ts      WS or MessagePort; text->control, binary->perspective
      control.ts        typed control client, request/response correlation
      engine.ts         THE SEAM: openTable/createView/readWindow/onUpdate/dispose
      dataService.ts    GridDataService interface + CSRM and hub implementations
      modes/            csrm.ts ssrm.ts vrm.ts
      coldefs.ts        schema artifact -> ColDef[]
      configStore.ts    IndexedDB wrapper, migrations, validate-on-write,
                        bundle codec, sidecar reconcile
      dsl/              parse.ts eval.ts compile-perspective.ts
      state.ts          layout/config persistence

    dshub-worker/src/   FIRST HOST (§2.2). SharedWorker on perspective wasm.
                        worker.ts port.ts control.ts registry.ts
                        table_actor.ts normalize.ts adapters/ queries.ts
                        alerts.ts stats.ts config.ts
                        normalize.ts is the conformance REFERENCE

    dshub-tools/src/
      infer-schema.ts   offline sampling -> schema artifact
      codegen.ts        spec -> TS types + validators, Rust serde types
      conformance.ts    corpus runner: rust output == ts output (Phase 10)

    dshub-admin/src/    React screens the host app mounts, not a standalone deploy:
                        editors, test-connect, sample+infer, flatten preview,
                        diagnostics, export/import/diff

  apps/
    dshub-blotter/      demo blotter — the Phase 4 deliverable, the parity
                        harness target, and what the record/replay corpus drives
    dshub-console/      demo host mounting dshub-admin's screens standalone,
                        so the admin surface is exercisable without OpenFin

  hub-rust/src/         SECOND HOST — Phase 10. Not a pnpm workspace member;
                        cargo build (edition 2021, toolchain 1.78), turbo external task
    main.rs             bootstrap, single-instance lock, port file
    config.rs           generated types, load/merge/validate, hot-reload classes
    server.rs           WS listener, auth handshake, frame routing
    control.rs          control message handlers
    registry.rs         table registry, refcount, lifecycle, state machine,
                        process memory ceiling, reconnect-diff queue
    table_actor.rs      per-table actor: channel -> normalize -> perspective
    normalize.rs        must match dshub-worker/normalize.ts byte-for-byte
    adapters/           stomp.rs rest.rs ws.rs socketio.rs
                        solace.rs amps.rs  <- only reachable from a native process
    queries.rs          distinct, rank, aggregates, export, scan
    alerts.rs           rule views + on_update -> control events
    stats.rs            counters, latency histograms
```

Codegen writes into `packages/dshub-spec/src/generated/` for TypeScript and, from Phase 10, `hub-rust/src/generated/` for Rust — from the one set of schemas. Both are checked in, with a CI step asserting the diff is empty. Only the TypeScript half is exercised before Phase 10, but the Rust emitter is written in Phase 1 anyway: it is cheap while the schemas are fresh, and it keeps the spec honest about being language-neutral.

### 2.1 Shared dependency versions

**React is one version everywhere.** Two copies of React in one page is a broken app, not a version skew — hooks resolve against the wrong dispatcher and the failure is baffling. This matters more here than in a normal monorepo because `dshub-admin` is a *mounted* library: the desk's OpenFin app supplies the React that renders its screens.

Pinned once, in the `pnpm-workspace.yaml` catalog. Every package declares `"react": "catalog:"` rather than a literal range, so there is exactly one place the version changes:

The target is 19.3; as of writing that is unreleased (npm `latest` is 19.2.8, and 19.3.0 exists only as a canary), so the pin sits on the newest stable 19.x. Moving to 19.3 when it ships is a one-line catalog edit — which is the reason for pinning centrally rather than per package.

```yaml
catalog:
  react: ~19.2.8
  react-dom: ~19.2.8
  "@types/react": ^19.2.0
  "@types/react-dom": ^19.2.0

  ag-grid-community: 36.0.0
  ag-grid-enterprise: 36.0.0
  ag-grid-react: 36.0.0
```

`dshub-admin` additionally declares React as a **peer** dependency, since the host provides it. The apps in `apps/` declare it directly. Both resolve to the same catalog entry.

**AG-Grid is 36.0.0**, the current latest, pinned in the same catalog. Two majors past the v29–v34 window `ssrm-parity-study.md` was written against, so its API surface needs re-verification — see the note at the top of that document for what has been checked and what has not. Exact pin rather than a range: SSRM APIs have churned across every recent major, and a silent minor bump is not something to discover through a broken blotter.

Three consequences worth stating before they surprise someone:

- **`dshub-provider` stays React-free.** It may depend on `ag-grid-community`/`ag-grid-enterprise`, which are framework-agnostic, but never on `ag-grid-react`. This keeps principle 7 honest and means a non-React host can use the provider. React belongs to `dshub-admin` and the `apps/` demos only.
- **Module registration is mandatory.** From v33 onward AG-Grid requires explicit `ModuleRegistry.registerModules`, and the modules the hub needs are not the default set — `ServerSideRowModelModule`, `ServerSideRowModelApiModule`, `ViewportRowModelModule`, plus the set-filter and clipboard modules. Register them in one place in the provider, not per blotter.
- **`.npmrc` currently sets `strict-peer-dependencies=false`**, which would silently swallow a package declaring a conflicting React or AG-Grid range — the exact failure the catalog exists to prevent. Worth flipping to strict once either is actually in the tree.

### 2.2 Host ordering

**The SharedWorker ships first. The Rust sidecar is Phase 10.**

Principle 2 says the two hosts are one design with different transports, and that stands. What changed is which one is built first, and the consequences run through the whole plan:

| Consequence | Detail |
|---|---|
| **Phases 0–9 are TypeScript** | Rust leaves the critical path entirely. One toolchain, one language, faster iteration, and the language boundary becomes a single phase at the end rather than a seam running through the middle |
| **The memory ceiling is a front-line constraint — at ~3.8 GB** | Measured in Chrome 152 (`phase-0-findings.md` §1a): WebAssembly memory caps at 4.29 GB and commits ~3.76 GB, and **Memory64 buys no additional headroom in the browser** despite Perspective's probe passing. Roughly 2× the ~2 GB originally assumed, but a real ceiling — §6.2's budget and admission control stay required. Re-check on the OpenFin-pinned Chromium |
| **AMPS and Solace are unavailable in v1** | Neither is reachable from a browser. Datasources on those transports cannot be served until the sidecar exists. Confirm no desk depends on one before committing |
| **No cross-app config sync in v1** | §3.6's three-way reconcile is a sidecar mechanism. With IndexedDB as the only store, config is effectively per-app; moving it between apps means export/import. The `(bundleVersion, checksum)` conflict rule is specified and ships with the sidecar |
| **§7.3 is deferred wholesale** | No localhost listener, no port file, no single-instance mutex, no handshake token, no Origin allowlist. A MessagePort is same-origin by construction — this is a genuine security simplification for v1, not a deferred cost |
| **The worker is the conformance reference** | When the Rust twin lands, it must match the TypeScript normalizer's Arrow output byte for byte. The corpus is written in Phase 1 regardless, so the direction costs nothing |
| ~~**Single-threaded**~~ **Wrong** | The engine exports `_psp_num_cpus` / `_psp_set_num_cpus`, so it is not single-threaded. What concurrency is actually available inside a SharedWorker is unmeasured |

The sidecar remains the answer for a desk whose working set does not fit the address space, or that needs AMPS or Solace. It is a capability upgrade rather than the default.

---

## 3. Configuration model

Three levels. Flattening them is the mistake that makes 40 datasources unmaintainable.

### 3.1 Connection profile — one per server

```jsonc
{
  "id": "viewserver-uat",
  "kind": "stomp",
  "url": "wss://vs-uat.corp/stomp",
  "vhost": "/",
  "heartbeat": { "outMs": 10000, "inMs": 10000 },
  "auth": { "mode": "token-from-app" },        // never a secret in config
  "credentialRef": "vault://desk/viewserver",  // resolved at connect time
  "reconnect": { "initialMs": 500, "maxMs": 30000, "factor": 2, "maxAttempts": null },
  "failover": ["wss://vs-uat-b.corp/stomp"],
  "tls": { "verify": true, "caRef": "system" }
}
```

### 3.2 Datasource definition — one per logical dataset

```jsonc
{
  "id": "cmbs-positions",
  "connectionRef": "viewserver-uat",
  "schemaRef": "cmbs-positions@v7",

  "snapshot": { /* discriminated union, §3.4 */ },
  "updates": {
    "destination": "/topic/positions.cmbs.{book}",
    "selector": null,
    "subscribeBeforeSnapshot": true,
    "updatesDuringSnapshot": "buffer"          // buffer | apply-live | none-expected
  },

  "keyColumns": ["positionId"],
  "opField": { "path": "action", "map": { "N": "insert", "U": "update", "D": "delete" } },
  "softDelete": { "column": "_deleted", "reapAfterMs": 60000 },

  "flatten": { "separator": "_", "maxDepth": 4, "arrays": { "legs": { "strategy": "explode", "childTable": "cmbs-position-legs" } } },
  "coercions": [ { "path": "price32", "kind": "ticks-to-decimal", "companion": "price32_num" } ],

  "batch": { "maxMs": 50, "maxRows": 5000, "dedupeByKey": true },
  "conflation": { "defaultIntervalMs": 100, "maxIntervalMs": 1000 },

  "params": { "book": { "type": "string", "required": true } },
  "sharing": { "strategy": "superset", "supersetParams": { "book": "*" } },

  "lifecycle": { "prewarm": false, "idleTeardownMs": 300000, "maxRows": 800000 }
}
```

### 3.3 Subscription instance — runtime

`{ datasourceId, params: { book: "CMBS" } }`. The pair `(datasourceId, canonicalParamsHash)` is the **cache key** for refcounting. Params substitute into topic templates and snapshot request bodies.

### 3.4 Snapshot modes

| `mode` | Fields | Notes |
|---|---|---|
| `trigger-reply` | `triggerDestination`, `triggerBody`, `replyDestination`, `correlationHeader` | The STOMP request/reply pattern |
| `rest-then-subscribe` | `url`, `method`, `headers`, `pagination` | GET then subscribe |
| `subscribe-with-replay` | `replayFrom` | Solace replay, AMPS `sow_and_subscribe` |
| `subscribe-only` | — | Cache built from stream; no initial snapshot |
| `file-seed` | `path` | Dev and replay testing |

**End-of-snapshot detection — three independent guards, all configured:**

```jsonc
"endOfSnapshot": { "kind": "sentinel-header", "header": "msg-type", "value": "EOS" },
"expectedCountHeader": "total-rows",
"timeoutMs": 120000,
"quietPeriodMs": null
```

A missing sentinel must fail the subscription loudly. Going live with a silently truncated book is the worst possible failure in this system; a trader acting on a partial position set is a real loss event. On mismatch between `expectedCount` and received rows: fail, do not warn.

### 3.5 Storage and distribution

There is no config server. Config lives client-side in IndexedDB, and the sidecar acts as the sync point between apps.

```
IndexedDB  db: "dshub-config"
  meta          key 'singleton'  → { bundleVersion, updatedAt, updatedBy, checksum, specVersion }
  connections   key id
  datasources   key id
  artifacts     key `${id}@${version}`     // last 3 versions retained
  rules         key id                      // DSL rules
  layouts       key `${blotterId}:${name}`

localStorage                                 // synchronous bootstrap reads only
  dshub.bundleVersion
  dshub.sidecarPort
  dshub.seedUrl                              // optional, §3.8
```

Schema artifacts are the size driver — 250 fields across 40 datasources exceeds localStorage's ~5MB quota, so artifacts must be IndexedDB. Nothing else is split across the two stores; two sources of truth for the same field is how a topic name gets changed in one place only.

Object-store versioning via `onupgradeneeded` with a migration function per version step, **written from day one**. Retrofitting migrations onto a store that already holds desk data is unpleasant.

**Validate on every write**, not just on import. With no server checking writes, the generated JSON Schema validators are the only thing between a typo in the admin UI and a broken datasource on a trader's machine.

### 3.6 Sync via the sidecar

Each OpenFin app has its own origin and therefore its own IndexedDB, so config would not normally be shared between them. But they all talk to one sidecar, which already keeps a copy in its profile dir. The `hello`/`configAck` exchange becomes a three-way reconcile:

```
app.hello { bundleVersion: 12, checksum: "sha256:…" }
hub compares against its running version:
  app  > hub                    → app pushes bundle; hub validates and persists to profile dir
  hub  > app                    → hub sends bundle down; app writes to IndexedDB
  equal, checksums match        → nothing
  equal, checksums differ       → CONFLICT; neither side wins automatically
```

One rule, three problems solved: cross-origin sync between OpenFin apps on the same machine, recovery when a user's browser storage is cleared, and cold start for a newly installed app.

**Reconcile on the pair, never on the version alone.** `bundleVersion` is a client-side counter, so two apps editing while the sidecar is down both bump `12 → 13` with different content. Comparing versions only, they meet at `equal → nothing` and stay divergent forever under the same number, with no signal to either user. The checksum already exists in the bundle format (§3.7); carrying it in `hello` costs one field and closes the hole.

A conflict is surfaced, not resolved silently: the hub answers `configAck { status: "conflict" }`, the app opens the §3.7 import diff view against the hub's bundle, and the user picks a side. Until they do, the app runs on its local config and the hub keeps serving its own — divergence is survivable, a silent overwrite of someone's desk config is not.

The sidecar writes `config.json` plus `config.bak.json` on every accepted push and validates before swapping. A corrupt bundle must not brick the sidecar.

In SharedWorker mode there is no sidecar; IndexedDB is the only store and the worker reads it directly. Worker mode is therefore effectively single-app.

**Since the worker ships first (§2.2), this whole section is Phase 10.** v1 has no cross-app config sync at all — export/import is the transfer mechanism, which raises the stakes on the bundle-in-git process below. Accepting that is the cost of worker-first; it is recoverable, and it is not a correctness problem.

### 3.7 Export and import

```json
{
  "kind": "dshub-config-bundle",
  "specVersion": "1.0",
  "bundleVersion": 12,
  "exportedAt": "2026-08-31T14:02:11Z",
  "exportedBy": "anand",
  "checksum": "sha256:…",
  "connections": [], "datasources": [], "artifacts": [], "rules": [], "layouts": []
}
```

Format rules:

- **Checksum over the canonicalized payload**, verified on import. Catches files truncated by email or a share drive.
- **`specVersion` gates import.** Refuse a bundle from a newer spec rather than partially applying it.
- **Layouts excluded by default.** Personal window arrangements should not ride along when a datasource config is shared. Separate "export my layouts" action.
- **Secrets stripped and rejected.** Export emits `credentialRef` only; import runs the same password-shaped-field validator as the write path. Bundles will travel over email — assume it.

Import modes:

| Mode | Behaviour |
|---|---|
| **Dry run** | Parse, validate, diff by id: added / changed / removed / conflicting. No write. The default |
| Merge, incoming wins | Per-id overwrite; local-only entries preserved |
| Merge, keep local | Adds new ids only |
| Replace all | Wipes stores first; confirmation dialog names the count being deleted |

Every import bumps `bundleVersion` and rewrites `meta`, inside a single IndexedDB transaction so a mid-import failure leaves the previous config intact.

The diff view replaces the promotion-with-review workflow a config server would have given you, and is roughly 200 lines of React over a plain object diff.

**Distribution without a server:**

1. **Bundles live in git.** Export, commit, PR, review — audit trail and diff review in a tool the team already uses. Adopt as process from day one.
2. **Optional seed URL.** `dshub.seedUrl` points at static JSON on an intranet path or network share. On startup, if the seed's `bundleVersion` exceeds local, offer to import. ~50 lines, and it restores central rollout with no service to deploy. Build when a second desk asks for the same datasource.

### 3.8 Hot-reload classes

Every config field carries a reload class in the JSON schema, so behaviour is derived, not decided ad hoc.

| Class | Fields | Effect |
|---|---|---|
| `live` | conflation intervals, idle teardown, log level, alert rules | Applied in place |
| `resubscribe` | topics, selectors, snapshot params | Drop + re-establish upstream; subscribers see `recovering` then fresh snapshot |
| `rebuild` | key columns, flatten spec, coercions, schema version, types | Destroy + recreate table; subscribers re-init |
| `restart` | listen port, auth mode, TLS | Sidecar restart required |

### 3.9 Credentials

Config carries `credentialRef` only. Preferred resolution is a token the OpenFin app already holds, passed at connect time so the sidecar stores nothing. A schema validation rule rejects any config containing password-shaped fields, enforced on IndexedDB write, on export, and on import. This gets a unit test, because someone will try.

---

## 4. Schema artifact

The single source for the Perspective schema, the key columns, the colDefs, and the filter strategy. Produced by an **offline inference pass**, reviewed by a human, versioned.

```jsonc
{
  "id": "cmbs-positions", "version": 7,
  "keyColumns": ["positionId"],
  "columns": [
    {
      "id": "counterparty",
      "path": "counterparty.name",          // source path in raw JSON
      "column": "counterparty_name",        // flattened Perspective column
      "type": "string",
      "nullable": true,
      "cardinality": 340,
      "filter": "set",                      // set | search-select | text | number | date
      "cascadingValues": true,
      "colDef": { "headerName": "Counterparty", "width": 180, "enableRowGroup": true }
    },
    {
      "id": "price32", "path": "price", "column": "price32", "type": "string",
      "companion": { "column": "price32_num", "type": "float", "coercion": "ticks-to-decimal" },
      "colDef": { "headerName": "Price", "type": "rightAligned", "sortColumn": "price32_num" }
    }
  ],
  "volatileSortColumns": ["price32_num", "pv"],
  "setFilterColumns": ["counterparty", "book", "trader"]
}
```

### 4.1 Inference rules

Run offline against a live sample (N messages, or until every leaf path is seen non-null M times). Output is reviewable, never auto-applied in production.

- Widen `int → float` on any conflict. **Never narrow.**
- Numeric-looking strings stay strings unless explicitly typed. CUSIP, SEDOL, ISIN, account numbers: leading zeros and float precision loss are how you get support tickets.
- ISO-8601 → `datetime` only above a high parse rate **and** only with human confirmation.
- `Y`/`N`/`true`/`1` → boolean only when the observed value set is exactly that.
- First-batch inference is banned in production. An all-null first batch becomes `string`; a float column whose first batch happens to be whole numbers becomes `integer` and truncates silently forever.

### 4.2 FI-specific coercions

32nds prices (`"99-16+"`) must remain string columns with a **companion numeric column** computed at ingest, or sorting and aggregation break. Same for any tick-formatted field. The colDef points its `sortColumn` at the companion. Encode as a named coercion so it is declarative, not bespoke code per datasource.

### 4.3 Cardinality drives colDefs

| Cardinality | Filter | Behaviour |
|---|---|---|
| < 500 | Set | Values cached eagerly at subscription |
| 500 – 10k | Set | Lazy fetch on open, mini-filter on |
| > 10k | Search-select | Custom component; prefix query, debounced, top-N |

Also drives `enableRowGroup`, alignment, precision (from observed decimals), and width (from max sampled string length). Your existing 250-field FI catalog is the seed layer; inference fills gaps.

### 4.4 Evolution

Perspective cannot add a column to a live table — it is a rebuild. An unknown path arriving mid-session is **logged and surfaced in diagnostics, never auto-added**. Bump the schema version through the admin flow, rebuild, force client re-init on handshake mismatch.

---

## 5. Ingest

### 5.1 Pipeline

```
transport → decode → normalize → micro-batch → TableActor → perspective.update()
```

Only transport and decode are host-specific. Normalize is spec-driven and must produce **byte-identical output** in Rust and TypeScript, verified by the conformance corpus.

### 5.2 Normalizer

Driven entirely by the flatten spec and schema artifact. Responsibilities:

- **Path flattening** with configured separator. Use `_` or `/`, **never `.`** — AG-Grid treats dots in `field` as deep property paths and will silently resolve wrong.
- **Array strategies**, per path: `index-pin` (bounded arity), `aggregate` (count/sum computed at ingest), `json-string` (visible, not sortable), `explode` (sibling table keyed `parentKey|index`, surfaced via master-detail).
- **Partial patch correctness.** The flattener walks the *incoming payload*, not the schema. `{tradeId, risk:{dv01:1234}}` must emit only `risk_dv01` — emitting the full flattened row with nulls would wipe untouched columns through Perspective's merge semantics.
- **Absent vs null** stay distinguishable end to end.
- **Op mapping** to insert/update/delete via `opField`; delete becomes a soft-delete flag flip.
- **Coercions** including the FI companion columns.

### 5.3 Micro-batching

Flush on `maxMs` (25–50ms) or `maxRows` (~5k), whichever first, with **per-key dedupe inside the batch**. That dedupe is free conflation before anything reaches a view.

Host-specific performance notes:
- **Rust:** build one Arrow `RecordBatch` per batch. Never row-at-a-time.
- **Worker:** feed `table.update()` **column-oriented** (`{col:[v1,v2,...]}`), not an array of row objects. The wasm path for columnar input is materially faster and skips an allocation round.

### 5.4 TableActor — the single writer

One actor per table, owning the Perspective table handle, fed by a bounded MPSC channel. Multiple adapters may feed the same table; concurrent `update()` is a race not worth debugging later. Bounded channel gives natural upstream backpressure.

State machine, published on the control channel:

```
idle → connecting → snapshotting → live ⇄ stale → recovering → live
                         ↓                              ↓
                       failed ←──────────────────────────┘
```

`stale` is what lets the blotter grey out or badge. Silence must never be ambiguous between "quiet market" and "upstream died."

### 5.5 Snapshot atomicity

The single most important correctness property.

1. Subscribe to updates **before** requesting the snapshot (otherwise there is a gap).
2. Per `updatesDuringSnapshot` policy: `buffer` queues arriving updates keyed by row key; `apply-live` applies them directly (only valid when upstream guarantees snapshot-then-delta ordering).
3. On sentinel: apply the buffered updates, keyed, last-write-wins per key, then transition to `live`.
4. Validate row count if `expectedCountHeader` is configured. Mismatch → `failed`.
5. Stamp the table with a monotonic `seq` and the snapshot completion time.

### 5.6 Upstream reconnect

On upstream loss: transition `stale`, keep serving the cache, publish the state. On recovery: re-snapshot into a shadow table, **diff against the live table**, emit the minimal transaction set. Blind replace causes scroll jump and full repaint; the diff buys a much better desk experience for a bounded memory cost.

**The cost is 2× the table, transiently, and it must be serialised.** A shadow table is a full second copy. The triggering event is usually shared — an upstream server bounce drops every datasource on that connection at once — so the naive implementation doubles several tables simultaneously, at the moment the system is least able to absorb it.

One shadow table at a time per hub. Tables awaiting their turn stay in `recovering` and keep serving their stale cache, which is the correct thing for them to be doing anyway. This turns a multi-gigabyte spike into a queue, and it belongs in `registry.rs` alongside the process-level ceiling (§6).

### 5.7 Failover

`failover` list is tried in order after `maxAttempts` on the primary. Failover is a `recovering` transition, not a `failed` one.

---

## 6. Table registry and sharing

- Cache key: `(datasourceId, canonicalParamsHash)`.
- **Refcounted.** First subscriber creates the upstream subscription; last departure starts an `idleTeardownMs` timer. Prewarm-flagged datasources are created at startup and never torn down.
- **Superset sharing.** When subscriber A wants `book=CMBS` and B wants `book=*`, the `sharing.strategy: "superset"` config makes one table hold the superset and each subscriber gets a filtered view. This is what makes "one stop shop" true rather than aspirational.
- **Entitlement is enforced separately from filtering.** A filtered view must never be the only thing hiding rows a user is not entitled to see. See §6.1.
- `lifecycle.maxRows` is a hard per-table guard; exceeding it fails the subscription rather than OOMing the hub. It is not sufficient on its own — see §6.2.

### 6.1 Entitlements

Superset sharing puts entitlement and filtering in direct tension. One table holds `book=*` while each subscriber sees a filtered view, which means **a filter clause is the only thing separating two desks inside one table.** A bug there is a cross-desk data leak, not a rendering glitch. This section exists because a two-line treatment is not enough for that consequence.

**Two independent mechanisms, both required.** Neither is a fallback for the other:

1. **Admission.** At table-open time the hub resolves the subject's entitlement set and refuses the subscription outright if the datasource is not in it. A subscriber who should see nothing gets an error, not an empty grid.
2. **A mandatory clause.** Every view the hub creates for that subscriber is built as `AND(entitlementClause, userFilter)`. The clause is composed hub-side at view construction; it is never sent to the client, never present in a `ViewSpec` the client can author, and therefore not removable by a crafted request. The client filter model is an *input* to view construction, not the construction itself.

**Entitlement source — UNRESOLVED.** The service, its latency and its caching behaviour are not yet decided, and the choice changes `connectionRef` handling and the control protocol. What the design commits to regardless of the answer:

| Concern | Rule |
|---|---|
| Failure mode | **Fail closed.** An unreachable entitlement source refuses new table-opens. It does not fall back to "allow" and does not silently widen an existing clause |
| Cached entitlements | Permitted, with an explicit TTL, because a source outage should not evict a trader mid-session. A cache may keep an existing subscription alive; it may **not** authorise a new one past its TTL |
| Mid-session change | A revocation must drop the subscription and publish `state: failed` with a typed code. A widening may wait for the next natural re-subscribe |
| Representation | The resolved clause is derived hub-side from the subject and the datasource. It is not a config field, because anything in config is something a user can edit |

**Exit criterion.** Not "an unentitled subscriber cannot open a table" — that only tests mechanism 1. The real test: *a subscriber holding a legitimate view into a shared superset table cannot reach a single row outside their entitlement by any filter model, sort, group, aggregate, distinct-values query, export, scan, or rank request they are able to issue.* Every query RPC in §7.2 is a potential bypass, and each one composes the clause independently. This is a test suite, not an assertion.

### 6.2 Resource budget

`lifecycle.maxRows` bounds one table. Nothing bounds the process, and the process is what runs out of memory.

**Known working set:** at most **2 datasources and 10 tables** per trader concurrently. The hub is per-user, so this is a genuine ceiling rather than a figure that grows with desk size — which makes a budget tractable rather than speculative.

**Revised by Phase 0.** The browser ceiling is **~3.8 GB committable** (measured, Chrome 152 — `phase-0-findings.md` §1a), not the ~2 GB assumed here. The shape of this section is right; the number was roughly 2× too pessimistic. Memory64 does **not** lift it in the browser. The engine also ships its own residency/eviction machinery (`_psp_residency_*`) which may already cover eviction — investigate before building it by hand. Per-table memory was measured with a flawed method and is still unknown; see `phase-0-findings.md` §2.

Required:

- **A configured process ceiling**, separate from and additional to `lifecycle.maxRows`.
- **A stated breach policy.** Refuse the new subscription with a typed error the provider can surface, or evict the least-recently-used idle table and retry. Refusing is the safer default; eviction is better UX and needs the refcount to be trustworthy first.
- **Admission accounting at table-open**, using the schema artifact's row estimate, so a subscription that cannot fit is refused before it is half-built rather than during its snapshot.
- **Current usage against the ceiling published in `statsTick`**, so §10 diagnostics can answer "why was I refused."

If Phase 0 shows more than three or four of the ten tables are large, this stops being a safety net and becomes a scheduling constraint the blotters must tolerate — they will be refused sometimes, and that path needs a UI.

---

## 7. Transport and control channel

### 7.1 The two-channel trick

One WebSocket connection (or one `MessagePort`):

- **Binary frames** → Perspective protocol, passed straight through to `perspective-server` / `perspective.Client`. We never parse these.
- **Text frames** → control JSON.

Zero multiplexing code, zero envelope overhead. In worker mode: `ArrayBuffer` transfers are Perspective traffic; plain objects are control.

### 7.2 Control protocol

Request/response with `id` correlation, plus server-pushed events. Defined once in `control-protocol.schema.json`, types generated for Rust and TypeScript.

**Client → hub**

| Message | Purpose |
|---|---|
| `hello` | Token, app id, config version, protocol version |
| `pushConfig` | Config bundle + version |
| `subscribe` | `{datasourceId, params}` → returns table name + schema artifact ref |
| `unsubscribe` | Release refcount |
| `distinctValues` | `{colId, contextFilter, limit}` |
| `searchValues` | `{colId, prefix, limit}` |
| `rowCount` / `aggregates` | Status bar, footers |
| `rank` | `{key, viewSpec}` → index, for scroll-to-row |
| `export` | `{fmt, viewSpec}` → streamed result |
| `scan` | `{viewSpec}` → streamed batches for whole-dataset iteration |
| `command` | Write path: order/amend/cancel/annotate |
| `alertSubscribe` | Register a DSL rule as a hub-side alert |
| `stats` | Diagnostics pull |

**Hub → client**

| Event | Purpose |
|---|---|
| `state` | Per-datasource state machine transition |
| `configAck` | Running config version |
| `schemaChanged` | Version bump; client must re-init |
| `alert` | Rule fired, with the row |
| `commandResult` | Write-path outcome |
| `statsTick` | Periodic metrics |
| `error` | Typed, with a code the UI can act on |

### 7.3 Sidecar security

A localhost WebSocket is reachable by any page in any browser on the machine, and is exposed to DNS rebinding. Non-negotiable:

- Bind `127.0.0.1` only. Never `0.0.0.0`.
- Strict `Origin` allowlist; reject `Host` headers that are not `127.0.0.1`/`localhost`.
- **Handshake token** written to a user-profile file at startup; the app reads it and presents it in `hello`. Loopback is not authentication.
- Per-user port on shared machines (Citrix, terminal server), discovered via that same profile file.
- Single-instance mutex; stale port file cleanup on startup.
- Upstream credentials scoped to the logged-in user; entitlements enforced hub-side.

### 7.4 Backpressure

Perspective's protocol handles data flow, but the socket still needs guarding: monitor `bufferedAmount` (or the Rust equivalent send-queue depth) per subscriber. Policy ladder: **conflate harder → drop to periodic snapshot refresh → disconnect with a typed error.** Publish which rung a subscriber is on, in stats.

---

## 8. Provider

### 8.1 The seam

`engine.ts` is one file with concrete signatures. Not an interface hierarchy, not a plugin registry — one module boundary that means swapping Perspective for CQServer later touches one file, not the provider.

```ts
export interface EngineAdapter {
  openTable(name: string): Promise<TableHandle>;
  createView(t: TableHandle, spec: ViewSpec): Promise<ViewHandle>;
  readWindow(v: ViewHandle, range: RowRange): Promise<ColumnBlock>;
  onUpdate(v: ViewHandle, cb: (d: Delta) => void): Unsubscribe;
  schema(v: ViewHandle): Promise<EngineSchema>;
  dispose(v: ViewHandle): Promise<void>;
}
```

`ViewSpec` is our shape — filters, groupBy, sort, aggregates, expressions. `PerspectiveAdapter` translates. AG-Grid mode adapters never touch Perspective types.

### 8.2 Mode mapping

**CSRM.** One flat view. First window → `setGridOption('rowData')` or progressive `applyTransactionAsync({add})`. Then `view.on_update(cb, {mode:'row'})` → `applyTransactionAsync`. `getRowId` from key columns.

**SSRM.** Each `getRows` request becomes its own view: `groupKeys` → equality filters, next `rowGroupCol` → `group_by`, `valueCols` → aggregates, `set_depth(1)`, window read. **LRU-cache views by request signature and dispose on eviction** — one view per expanded node leaks server memory otherwise. Full detail in `ssrm-parity-study.md`.

**VRM.** Perspective's expanded tree is already a flat indexed list, which is exactly what viewport row model wants. `to_columns({start_row,end_row})` serves the range; expand/collapse are `view.expand(i)` / `view.collapse(i)`. Requires rendering `__ROW_PATH__` with an indenting tree cell renderer. **Preferred for >200k grouped datasets** — far less fighting than SSRM.

### 8.3 Mode selection

Automatic, from the schema artifact. Never a user choice, always visible in diagnostics.

| Rows | Mode |
|---|---|
| < 50k | CSRM |
| 50k–200k | CSRM if simple grouping, else SSRM |
| > 200k | SSRM |
| > 200k and heavily grouped | VRM |

### 8.4 Two Perspective gotchas

**Removals do not surface through `on_update`.** A row deleted server-side, or one that filters *out* of a view, simply stops being present — no delta you can map to an AG-Grid `remove`. Mitigations, use both:
- Soft-delete flag column. The flag flip *is* an update, so the delta carries it; provider maps `_deleted === true` → `remove`. Hub reaps on a slow timer.
- In CSRM, keep the user's filter model **client-side**; do not push it into the Perspective view, or filtered-out rows become ghosts.

**Read format cost.** `to_json()` is directly consumable but slow. `to_columns()` plus a manual pivot in the provider is meaningfully faster at 160 columns. `to_arrow()` is fastest on the wire but adds an arrow-js decode plus the same pivot. Benchmark all three against the real column mix before committing.

### 8.5 GridDataService — the parity layer

The actual deliverable of the SSRM work. Both modes implement it; blotter code never branches on mode.

```ts
interface GridDataService {
  readonly mode: 'csrm' | 'ssrm' | 'vrm';
  getDistinctValues(colId: string, ctx?: FilterModel): Promise<unknown[]>;
  searchValues(colId: string, prefix: string, limit: number): Promise<unknown[]>;
  getRowCount(filter?: FilterModel): Promise<number>;
  getAggregates(specs: AggSpec[], filter?: FilterModel): Promise<Record<string, number>>;
  search(text: string, cols?: string[]): FilterModel;
  exportAll(fmt: 'csv' | 'xlsx', view: ViewSpec): Promise<Blob>;
  copyAll(view: ViewSpec): Promise<string>;
  scanAll(view: ViewSpec, cb: (rows: unknown[]) => void): Promise<void>;
  snapshotForChart(view: ViewSpec, limit: number): Promise<unknown[]>;
  rankOf(key: string, view: ViewSpec): Promise<number | null>;
  resolveSelection(state: ServerSideSelectionState, view: ViewSpec): Promise<SelectionRef>;
}
```

CSRM answers locally from row data. SSRM/VRM go to the hub via control RPC.

### 8.6 Write path

Perspective is a read model. Orders, amends, cancels and annotations go over the control channel's `command` message with correlation id, timeout, and typed errors. The provider applies optimistically, then reconciles when the authoritative row echoes back through the table. Optimistic rows carry a pending marker for conditional styling.

### 8.7 Connection state

The provider surfaces a single `DataSourceState` per subscription, derived from `state` events plus transport health. Blotters bind staleness badges to this, not to update silence.

---

## 9. DSL

One grammar, one AST, several compilers. **Do not translate the DSL to Perspective expressions generally** — translate it to whichever backend the rule actually needs.

### 9.1 Where each rule evaluates

| Rule type | Evaluate where | Why |
|---|---|---|
| Conditional styling | Client, `cellClassRules` | Data is local; edits apply instantly, no view rebuild |
| Conditional editing (`editable`) | Client | Same |
| Calculated column used for sort/filter/group | Perspective expression | Must exist in the engine to be sortable server-side |
| Calculated column, display only | Client `valueGetter` | No reason to pay for a view column |
| **Alerts over the full dataset** | **Hub, Perspective view** | Must fire for rows outside the viewport or filtered out |

The alert row is the one people get wrong. In SSRM/VRM the client only ever sees a window, so a client-side alert silently misses most of the book. Hub-side implementation is clean: one view per rule with the predicate as its filter, and that view's `on_update` **is** the alert firing. Cheap, and it works when nobody is looking at the grid.

### 9.2 Compilers

- **→ Perspective expression string.** Constraints to design around: ExprTK-based, columns as `"Column Name"` in double quotes, no regex, thin string functions, no cross-row references, booleans handled more reliably as `1`/`0`.
- **→ client evaluator.** A tree-walking interpreter over the AST, roughly 200 lines. **Never `new Function`** — OpenFin CSP will block it, and it is an injection surface for LLM-generated rules. Hoist compilation out of the render path; per-cell evaluation is then fast enough.
- **→ CQServer filter**, if that backend ever lands.

### 9.3 Rules

- Reference columns by **stable id**, not display name. The Perspective compiler resolves id → column at compile time so renames do not break persisted rules.
- Maintain an explicit **capability matrix** per backend. A rule using regex gets a typed error from the Perspective compiler and is marked client-only in the UI, rather than silently diverging.
- **Validate at authoring time** by compiling and dry-running against the live schema.
- Version the DSL alongside the schema version in persisted config.
- **Your LLM grid configurator emits this DSL, not raw ExprTK.** A small validated grammar with structured compile errors is a far more reliable LLM target, and gives a free repair loop: compile → feed errors back → retry.

---

## 10. Observability

Per datasource: state, msgs/sec in and out, conflation ratio, cache row count, memory, subscriber count, open view count, last error, running config version, current backpressure rung.

End-to-end latency: stamp at ingest, measure at `applyTransactionAsync` return. Histogram, not average.

**Diagnostics window in OpenFin** reading the `statsTick` stream. Build this in the first working phase, not before UAT — you will need it on day one of integration testing, and it is the difference between "the blotter is slow" and a diagnosis.

**Record/replay:** capture raw upstream to JSONL, replay deterministically. Feeds the conformance corpus, the parity harness, and the convergence property test.

---

## 11. Testing

| Test | Catches |
|---|---|
| **Conformance corpus** — Rust and TS normalizers, same input, identical Arrow | Host drift, the highest-risk failure in the dual-host design |
| **Convergence property test** — random insert/update/delete sequences vs a naive fold oracle | Snapshot atomicity, conflation, ordering. Same technique as the CQServer oracle |
| **Parity harness** — same dataset in CSRM and SSRM, matrix of sorts/filters/groups, assert identical keys and aggregates | Blank handling, case sensitivity, range inclusivity, collation divergence |
| **Filter translator golden files** | Silent translation regressions |
| **View leak test** — 500 expand/collapse cycles, 50 filter opens, assert view count returns to baseline | The most likely sidecar memory bug |
| **Cell selection regression** — scripted drag past viewport at several speeds | The known SSRM range-loss issue |
| **Snapshot truncation** — kill upstream mid-snapshot, assert `failed` not `live` | The worst-outcome failure |
| **Security** — cross-origin connect, missing token, rebinding host header | Sidecar exposure |

---

## 12. Engine decision and exit criteria

Ship on Perspective behind the §8.1 seam. CQServer (~70K lines Rust, IVM, as-of join, Barrage) is the credible alternative, but it has no wasm build — and the dual-host requirement is satisfied by Perspective today with one codebase.

Run a two-week spike measuring only the things that would flip the decision:

1. View creation cost and steady-state memory with 50–100 concurrent views over 500k × 160. This is the SSRM node-expansion case and the most likely way Perspective falls over.
2. Index churn under sort: 20k updates/sec on a sort-key column; how much of the grid must be invalidated.
3. Whether the top five FI aggregations are expressible. Perspective's aggregate set is fixed with no extension point — if three of five fail, that is decisive alone.
4. End-to-end latency at real update rates.

If (1) or (3) fails, the hybrid is legitimate and not a compromise: Perspective wasm in the SharedWorker for small and medium datasets, CQServer in the sidecar for the heavy ones, same adapter, chosen per datasource by row count.

---

## 13. Requirements traceability

| Requirement | Where |
|---|---|
| Multi-transport ingest (STOMP/REST/AMPS/Solace/WS/socket.io) | §5.1, `adapters/` |
| Dual host: sidecar and SharedWorker | §1, §2, §5.3 |
| Snapshot cache + realtime updates | §5.4, §5.5 |
| Chunked snapshot delivery to subscribers | §7.1 — Perspective protocol, not hand-rolled |
| Column definitions and key columns per cache | §4 schema artifact |
| Throttling and conflation | §5.3 ingest dedupe, §3.2 per-subscriber intervals |
| Snapshot/update atomicity | §5.5 |
| Late joiner, reconnect, resume | §5.6, §7.2 |
| Upstream lifecycle and stale state | §5.4 state machine, §5.6, §5.7 |
| Refcounting and datasource lifecycle | §6 |
| Delta semantics contract | §5.2, §8.4 soft delete |
| Partial nested patches | §5.2 |
| Cache sharing and parameterized subscriptions | §6 superset strategy |
| Entitlements | §6.1, §7.3 |
| Process resource budget and admission control | §6.2 |
| Worker host row-count ceiling | §6.2 |
| Localhost security | §7.3 |
| Sidecar lifecycle, port discovery, single instance | §7.3, `main.rs` |
| Backpressure and slow consumers | §5.4 bounded channel, §7.4 |
| Wire format (Arrow) | §7.1, §8.4 |
| Config: connection strings, topics, trigger, EOS token | §3 |
| Config storage (IndexedDB / localStorage) | §3.5 |
| Config sync between apps, no server | §3.6 |
| Config export / import / diff | §3.7 |
| Config versioning and hot reload | §3.7, §3.8 |
| Admin UI: test-connect, sample+infer, flatten preview, diagnostics | §2 `packages/dshub-admin/`, §4.1, §10 |
| Nested JSON flattening and array strategies | §5.2 |
| Schema inference and field name discovery | §4.1 |
| ColDef construction from inference | §4.3 |
| Schema evolution | §4.4 |
| 32nds and FI coercions | §4.2 |
| DSL for styling, alerts, conditional editing | §9 |
| Hub-side alerts over full dataset | §9.1 |
| CSRM mode | §8.2 |
| SSRM mode + full interface surface | §8.2, `ssrm-parity-study.md` |
| VRM mode | §8.2, §8.3 |
| Set filter distinct values | `ssrm-parity-study.md` §1, §8.5 |
| CSRM/SSRM parity helper API | §8.5 |
| Write path | §8.6 |
| Observability and diagnostics | §10 |
| Record/replay and test strategy | §10, §11 |
| Engine swappability | §8.1, §12 |
