# Phase 0 — Spike Findings

**Companion documents:** `architecture.md`, `implementation-plan.md`, `design-review.md`
**Engine under test:** Perspective **5.3.0** (`@perspective-dev/*`)
**Harness:** `apps/dshub-spike/src/{run,views}.mjs`
**Hosts:** Node 24 (darwin arm64) for the engine measurements; **Chrome 152** for the memory ceiling (§1a). See §6 for what remains untested.

---

## 0. Verdict

**Go on Perspective, but not on the plan as written.** Two results change decisions:

1. **The memory ceiling still binds — but it is ~3.8 GB, not ~2 GB.** Measured in Chrome 152, not inferred. See §1a; an earlier draft of this memo got this wrong.
2. **View creation is expensive and degrades with the number of live views.** ~300 ms for a grouped view over 200k rows, rising to ~490 ms each when 100 are held open. Architecture §12 named this "the most likely way Perspective falls over," and it is the result that most damages SSRM.

Consequence: **VRM moves ahead of SSRM.** The tree API does exactly what architecture §8.2 hoped, and it needs *one* view where SSRM needs one per expanded node.

---

## 1a. Memory64: measured in a browser, and it changes nothing

**This corrects an earlier conclusion in this document.** The Node run showed `host_supports_memory64() === true` and 5.3 GB of engine heap reserved, and I concluded the wasm32 ceiling was obsolete. **That does not transfer to the browser.**

Measured directly in **Chrome 152**:

| Check | Result |
|---|---|
| Perspective's Memory64 probe (`WebAssembly.validate`) | **passes** |
| `new WebAssembly.Memory({index:'i64'})` max accepted | **65536 pages = 4.29 GB** |
| `new WebAssembly.Memory()` (wasm32) max accepted | **65536 pages = 4.29 GB** — identical |
| Actually committed by growing, wasm32 | **3.76 GB**, then `Maximum memory size exceeded` |
| Additional headroom from Memory64 | **none** |

Chrome validates Memory64 modules but caps linear memory at 4 GB either way. `host_supports_memory64()` returning true means *"this browser accepts memory64 modules"*, **not** *"you get more than 4 GB"*. Node's 5.3 GB reservation reflects Node's own limits and says nothing about the OpenFin runtime.

**So the ceiling analysis is restored, with a better number.** The design review assumed ~2 GB practical; the measurement says ~3.8 GB committable. That is roughly double the assumed headroom, which is good news — but it is a real ceiling, the §6.2 process budget is still required, and admission control still has to be real rather than theoretical.

Two caveats. This is Chrome 152 on macOS; OpenFin pins its own Chromium version, and the cap should be re-checked there. And 3.76 GB is what a bare `grow` loop reached with nothing else allocated — the engine, the grid, and the page all draw on the same budget, so the usable figure for tables is lower.

---

## 1. The engine moved

`@finos/perspective` is **deprecated** — npm prints *"no longer maintained, please upgrade to `@perspective-dev/client`"*. The project moved org and jumped **3.x → 5.3.0** (published 2026-08-25).

Every version-specific statement in `architecture.md` was written against 3.x and needs re-checking. Three capability changes are already visible in the 5.x surface:

| Symbol / export | Implication |
|---|---|
| `perspective-server.memory64.wasm`, `host_supports_memory64()` | Two wasm builds — but §1a shows the probe passing buys nothing in Chrome |
| `_psp_num_cpus()`, `_psp_set_num_cpus()` | The engine is **not single-threaded**. The plan's Phase 0 item 3 note and architecture §2.2 both claim it is |
| `_psp_residency_prepare/victim/commit` | The engine has its **own residency/eviction** machinery — overlapping the process ceiling designed by hand in §6.2 |
| `join`, `VirtualServer`, `GenericSQLVirtualServerModel` | Joins and SQL-backed virtual tables. Architecture §12 cites as-of join as a point in CQServer's favour; that comparison needs redoing |

**None of these were investigated further.** They are flagged because they invalidate assumptions, not because they have been measured.

---

## 2. Results

### Solid

| Measurement | Result | Bearing |
|---|---|---|
| Memory64 supported (Node) | **yes**, loader prefers it | but see §1a — no extra headroom in Chrome |
| Engine heap reserved (Node) | **5.3 GB** | Node-specific; does **not** transfer to the browser |
| Browser memory cap (Chrome 152) | **4.29 GB accepted, 3.76 GB committed** | the real constraint |
| View creation, flat | **51 ms** | cheap |
| View creation, any `group_by` | **~310 ms** (200k rows) | expensive, and the cost is in *creation* |
| First read after creation | **0.1–1.3 ms** | views are **eager**, not lazy — no deferred cost to find later |
| 100 concurrent views | **488 ms each** (vs 339 ms at 10) | cost **grows** with live view count |
| 100 views disposed | memory returns to baseline | **no leak** — the §11 view-leak risk is not present |
| Read format, 5k × 160 | `to_arrow` **23 ms** · `to_columns` **58 ms** · `to_json` **123 ms** | to_arrow wins |
| Aggregations | `sum` `avg` `first` `last` `median` `distinct count` all OK | fine |
| Native weighted mean | **unsupported** in the form tried | decomposition needed |
| `sum(w·x)/sum(w)` via expression | **works** — no engine support required | the §2.4 mitigation is viable |
| Distinct values via grouped view | **276 ms** for 340 values | usable behind the 30 s TTL cache |
| VRM `__ROW_PATH__` | `[[], ["ABS"], ["ABS","Broker 10"], …]` | **a flat indexed list, as §8.2 hoped** |
| VRM `set_depth` | present | one level of children per expansion is expressible |

### Not trustworthy — methodology was flawed

| Measurement | Why it cannot be used |
|---|---|
| Per-table memory | `system_info().used_size` is not a monotonic counter. One delta came out **negative** (−1.6 GB), which proves the method wrong, not the engine. Only the aggregate figure (~1.0 GB used / 5.3 GB reserved) is meaningful |
| ~~Update throughput~~ | **Re-measured — see §9.** The Node figure stands corrected |
| Run 1's "2.5 s per view" | Confounded: 500k rows, two-level `group_by`, and 100 held open at once. The isolated re-test (§views.mjs) gives the usable numbers above |

### Corrected

Run 1 reported VRM "DRIFT" and `expand(1)` adding no rows. That was **my error, not the engine's**: `expand`/`collapse` take a **row index**, not a depth. Row 0 is the root `[]`, so `collapse(0)` collapsed everything to 1 row — correct behaviour. The default tree view is already fully expanded (4 books + 340 counterparties + root = 345 rows).

---

## 3. What this does to the plan

### 3.1 VRM ahead of SSRM

SSRM needs a view per expanded node. At ~300 ms per grouped view on 200k rows — worse at 500k, and worse again as more stay open — each node expansion is a visible stall, and a blotter with many expanded groups holds many live views at the degraded rate.

VRM needs **one** view. `__ROW_PATH__` is a flat indexed list, `set_depth` controls levels, and `expand`/`collapse` work on row indices. That is precisely the viewport row model's shape.

The design review's §3.1 recommendation was to probe VRM early because it could retire a week and a half of Phase 8. That is now the stronger reading: **make VRM the primary mode for grouped datasets and treat SSRM as the fallback**, rather than the reverse.

The LRU view cache (plan 8c) softens the SSRM cost but does not remove it — a cache miss is still ~300 ms, and the eviction it performs is what keeps the live-view count down.

### 3.2 The memory sections need a new number, not deletion

Architecture §6.2 and design-review §5.4 assume a ~2 GB practical ceiling. The measured figure is **~3.8 GB committable in Chrome 152** (§1a), so the shape of the analysis is right and the number is roughly 2× too pessimistic. The process ceiling stays required; admission control stays required.

Also: the engine ships its own `_psp_residency_*` machinery, which may already provide eviction. Investigate before building §6.2's by hand.

### 3.3 Single-threading claim is wrong

Architecture §2.2 lists "Single-threaded" as a worker consequence and plan Phase 0 item 3 says to measure whether ingest starves queries. `_psp_set_num_cpus` says otherwise. Correct the claim, then measure what concurrency is actually available inside a SharedWorker.

### 3.4 Read format

`to_arrow` is ~2.5× faster than `to_columns` at 160 columns, contradicting the §8.4 expectation. **Caveat:** this measures engine-side serialisation only, not the arrow-js decode plus pivot the provider must then do. §8.4 says to benchmark all three end-to-end before committing — that is still the right instruction, and this result reorders which to try first.

---

## 4. Aggregations

The decomposition path works, and it is what matters. `sum(dv01 × px) / sum(dv01)` computed through a Perspective `expressions` clause plus two `sum` aggregates returned a correct DV01-weighted price with **no engine support required**.

The pre-committed threshold in the plan (0–1 unreachable → proceed; 2 → proceed with named shortfalls; 3+ → decisive) **cannot be evaluated**: the actual five FI aggregations the desks use are still unknown. What is established is that the cheapest mitigation is available, which is the useful half.

---

## 5. Numbers to re-run before trusting

1. ~~Update throughput.~~ **Done — §9.**
2. ~~Per-table memory.~~ **Done — §8**, measured in Chrome.
3. **View creation at 500k × 160**, to get the real SSRM figure rather than extrapolating from 200k. Still outstanding: the corpus is 20k rows, so a 500k fixture has to be synthesised or the snapshot size raised via the server's `snapshot-rows` header.

---

## 6. Not tested — needs a browser or the endpoint

| Item | Blocker |
|---|---|
| SharedWorker hosting, MessagePort transport | Node has no SharedWorker; needs a real browser |
| ~~Memory64 in a browser~~ | **Done — see §1a.** Measured in Chrome 152: no additional headroom over wasm32. Still to check on the OpenFin-pinned Chromium |
| STOMP-over-WebSocket from a worker, backgrounded-tab throttling | Needs the live ViewServer endpoint |
| The five FI aggregations | Needs the actual list |
| End-to-end ingest→`applyTransactionAsync` latency | Needs the browser and a real grid |

The Memory64 caveat is the important one. Every conclusion in §0 and §3.2 rests on it holding in the OpenFin runtime, and that has not been shown here.

---

## 7. Live STOMP server — captured, and it corrects two assumptions

Connected to the local view server (`ws://localhost:8081`, source at
`/Users/develop/wfh/stern-bak/apps/source/stomp-view-server`). Corpus written to
`packages/dshub-spec/corpus/positions/`.

**Wire shape**

| Aspect | Reality |
|---|---|
| Trigger | `/snapshot/{type}/{clientId}/{rate}[/{batchSize}]` — `rate` is aggregate rows/sec; `rate=0` is snapshot-only |
| Frame body | a **JSON array** of records (~10 per frame), not one record |
| Snapshot frames | `message-type: snapshot`, `content-type: application/json` |
| Completion | `message-type: snapshot-complete`, body `Success: All 20000 positions records delivered…` |
| Live frames | `message-type: live-update` |
| Heartbeat | server offers `0,0` — heartbeats **off** |
| Volume | 20,000 records in **750 ms** across 2,000 frames |

**Correction 1 — live updates are NOT partial patches.** The server README says each
update mutates "a random, correlated subset of at most 15 hot trading fields — never
the whole record." That describes what *changes*; the **wire carries all ~64 top-level
fields every time**. Measured across 3,068 live updates: every field present in every
update, while successive updates to the *same* row changed a median of **3** fields
(min 0, max 13).

So the normalizer's partial-patch handling is **not exercised by this feed**. It stays
correct and necessary — the real ViewServer may well differ, and architecture §5.2 is
written for feeds that do patch — but this fixture cannot validate it. Do not read a
green run here as proof that path works.

It also means conflation earns little on this feed: measured ratio **0.991**
(23,068 rows in → 22,860 out), because 3,068 updates spread across 20,000 keys rarely
collide inside one batch.

**Correction 2 — records are far wider and deeper than assumed.** 67 top-level fields
flatten to **372 leaves**, against the 160 columns the architecture sizes for. Nesting
reaches three levels (`analytics.keyRateDuration.10Y`). Three fields are
**conditionally present** — `clo` (5.1% of rows), `prepayment` (14.5%), `swapLegs`
(5.3%) — the absent-vs-null case in real data, and instrument-type-specific.
`swapLegs` is an array and needs an explicit array strategy.

**Inference on real data.** 20,000 records → 372 leaves, all satisfied. The uniqueness
heuristic held: `positionId`, `cusip`, `isin`, `sedol` and `instrumentName` all showed
20,000 distinct in 20,000 observations and were correctly routed to **search-select**
rather than a set filter that would have shipped 20k values to the browser. 117 columns
flagged for review. Artifact at `corpus/positions/artifact.json`.

**End-to-end.** normalize → TableActor → Perspective, on the real corpus:
snapshot count validated against the completion frame (20,000 declared = 20,000
received) and went `live`; 3,068 live updates applied with the row count unchanged;
**convergence vs a naive fold: MATCH** across 500 keys compared field by field; a
deliberately truncated snapshot was **refused** (`state=failed`), not served.

**Schema gaps this closed.** Added `endOfSnapshot.kind: "sentinel-substring"`
(case-insensitive body substring — what the admin UI exposes, and all some brokers
offer) and `updates.bodyShape: record | record-array`. A validated config for this
server is at `packages/dshub-spec/examples/positions-stomp.config.json`.

---

## 8. Per-table memory — measured in Chrome, and it changes the sizing

§2 listed per-table memory as "not trustworthy" because the Node method used
`system_info().used_size` deltas that came out negative. Measured properly in
Chrome 152, in a SharedWorker, building tables of increasing size from the real
corpus (20,000 records × 372 flattened columns) and reading
`client.system_info()` between each:

| rows | engine used |
|---|---|
| 2,500 | 24.4 MB |
| 5,000 | 44.3 MB |
| 10,000 | 181.7 MB |
| 20,000 | 295.6 MB |

**~30–42 bytes per cell** (the 10k→20k slope gives ~30.7; the 2.5k→20k fit gives
~41.7). The architecture and design review assumed roughly **6** — the estimate
was **5–7× optimistic**, which meant the §6.2 process ceiling would have fired
far too late to protect anything.

**Projected against the measured 3.76 GB browser ceiling:**

| Table | Projected | Verdict |
|---|---|---|
| 500k × 372 (this feed's real width) | **5.7–7.7 GB** | **does not fit** |
| 500k × 160 (the width the architecture sizes for) | **2.5–3.3 GB** | fits, with little room for anything else |
| 100k × 372 | ~1.5 GB | comfortable |
| 20k × 372 (this feed today) | ~0.3 GB | comfortable |

**Consequences.**

1. `Registry.estimateBytes` changed from `rows*cols*6` to `rows*cols*32`, and the
   default process ceiling from 1.6 GB to 2.5 GB — the latter chosen to leave
   working room under the measured 3.76 GB rather than to look generous.
2. **A single 500k-row table of this width cannot be served by the worker host.**
   That is the sidecar's case, and it is a stronger argument for Phase 10 than
   AMPS/Solace was.
3. The mode-selection thresholds in architecture §8.3 are row-count only. At
   372 columns a 200k-row table is already ~2.3 GB; **width has to enter the
   decision**, not just row count.

**Caveats.** The curve is not clean — 5k→10k more than quadruples while 10k→20k
is close to linear, so small tables sit below some allocation threshold and the
low-end points inflate the fit. Numbers include engine and client overhead, not
just column storage. And this is Chrome 152 on macOS; OpenFin pins its own
Chromium. Re-measure with more points, and per real datasource, before treating
these as planning figures — but the direction is not in doubt: the old estimate
was wrong by most of an order of magnitude.


---

## 9. Update throughput — re-measured in the browser

§2 flagged the Node figure (9,069 rows/sec against a 20,000/sec target) as a
single run under worst-case conditions and said to re-measure. Done, in Chrome,
in a SharedWorker, against the real 20k × 372 table, updating only the four hot
tick fields the server actually mutates (`currentPrice`, `marketValue`, `dv01`,
`pnl`):

| Scenario | Throughput |
|---|---|
| No view open | **13,787 rows/sec** |
| Sorted view **on the updated column** | **13,034 rows/sec** |
| Filtered view (a realistic blotter) | **13,612 rows/sec** |
| **Grouped view (SSRM-shaped)** | **4,190 rows/sec** |

**Three things this settles.**

1. **The Node number was pessimistic by ~50%.** The browser sustains ~13.6k
   rows/sec where Node managed 9k. Still short of the 20k target, but far less
   alarming.
2. **A sort on the updated column is nearly free** — 13.0k vs 13.8k, a ~5%
   penalty. The architecture's concern about index churn under sort (§12 item 2)
   does not show up at this scale. Whatever cost the Node run was measuring, it
   was not the sort.
3. **Grouping is what costs.** A single grouped view drops throughput to
   **4,190 rows/sec — a 3.3× penalty.** This is the same finding as §2's view
   creation cost seen from the ingest side: `group_by` is expensive both to
   create and to maintain.

**The grouped-view number is the one that matters for mode selection.** A
blotter in SSRM holds grouped views continuously, so it pays this on every
update, not just on expansion. It is a further argument for VRM over SSRM (§3.1)
and it means the 20k/sec target is unreachable with grouping on at this width.

**Caveats.** 20k-row table, not 500k; throughput is likely worse at scale. One
grouped view, not the many an expanded SSRM blotter holds. Chrome 152 on macOS.

---

## 10. VRM vs SSRM — both built, measured against the live worker

§3.1 promoted VRM ahead of SSRM on view-cost grounds. Both now exist and run
against the same worker, the same 20,000-row table and the same STOMP feed, so
the comparison is a measurement rather than an argument.

| | SSRM | VRM |
|---|---|---|
| Views for one grouped tree | **one per expanded node** (2 after a single expansion) | **one, always** |
| Window fetch p50 | **436 ms** | **20 ms** |
| Expansion mechanism | new grouped view per node | `expand(index)` on the existing view |
| Native AG-Grid grouping UI | yes | **no — tree column rendered from `__ROW_PATH__`** |
| Row identity | `g:`/`r:` prefixed, group vs leaf | absolute index |

**~20× on window fetch, and one view instead of N.** The gap is the grouped-view
creation cost from §2 (~300 ms, rising to ~490 ms with 100 held open) paid once
per expansion in SSRM and never in VRM.

The ingest side compounds it. A grouped view open drops throughput to 4,190
rows/sec against 13,787 with none (§9). SSRM holds one per expanded node
*continuously*, so a blotter with ten expanded groups pays that the whole time;
VRM holds one.

**Recommendation stands, now with numbers: flat → SSRM, grouped → VRM.** SSRM is
still the right mode for large flat datasets, where filtered views cost ~19 ms
and the native grid UI is worth having.

**What VRM costs.** No native grouping UI — the tree column is our own cell
renderer over `__ROW_PATH__`, including carets and indentation. Selection
semantics differ. And AG-Grid's own guidance warns Viewport is widely misused,
though the case it describes as its fit — "a large amount of changing data" that
the server pushes, where the server benefits from knowing what is on screen — is
precisely this system.

**One design note worth keeping.** Expansion state is DERIVED from the data (a
row is expanded iff the next row is deeper), not tracked in a Set. Perspective's
tree arrives fully expanded, so a Set starting empty disagrees with reality on
the first click; and every index below a toggle shifts, so index-keyed state is
stale the moment it matters.

---

## 11. VRM under live updates — the wire cost, measured

§10 compared the two modes on **view count and fetch latency**. That left the
more important claim untested: VRM says *only what is on screen crosses the
wire*. Wiring live updates made that measurable, and the first measurement
showed the claim was **false as built**.

The hub broadcast every delta to every subscriber. A VRM client re-reads its own
viewport, so it decoded the full payload and dropped it — paying CSRM's wire
cost for data it never used.

**Fix.** `subscribe` now carries a `delivery` mode. `rows` (the default, so
existing clients are unaffected) ships the changed rows, because CSRM keeps a
local copy and genuinely needs them. `notify` ships a count only. It is per
*session*, not per table: one tab may hold a CSRM grid and a VRM tree over the
same table.

### Same worker, same feed, same 10-second window

| | CSRM (`rows`) | VRM (`notify`) |
|---|---:|---:|
| upstream rows changed | 19,820 | 20,059 |
| delta messages | 62 | 63 |
| **control-channel bytes** | **81,389,317** | **10,206** |
| bytes per changed row | 4,106 | 0.51 |
| views held open | — | **1** |
| viewport refreshes | — | 31 |

**≈ 7,975× less traffic** for the same feed. Both tabs were subscribers of one
SharedWorker over one upstream STOMP connection, so this is the same bytes
arriving at the worker and being fanned out two different ways.

The refresh count is the other half: 63 deltas produced 31 refreshes, one per
250 ms interval. Uncoalesced, a ~2,000 rows/sec feed would issue a window read
per delta and starve the engine.

**Verified on screen**: all 34 visible rows changed value across a 5-second
window, aggregates recomputing up the tree, `views open 1` throughout.

### A second bug this surfaced — and the more serious one

The CSRM tab could not join at all. It sat on `no live state within 60s` while
the VRM tab beside it was live on the same table.

`state` messages are **transitions**. A session subscribing to a table that is
*already live* hears nothing and waits for an event that has already happened.
The first tab always worked, so this was invisible until a second tab opened
onto a running datasource — which is precisely the case the SharedWorker exists
for. Earlier multi-tab tests passed only because those tabs opened while the
table was still snapshotting.

`subscribe` now replays the current state to the joining session, marked
`detail.replay: true` so a client can distinguish it from a transition, and sent
*after* the session's view exists (a client may query the instant it reads
`live`). Time to `live` for the second tab: **60,000 ms → 0 ms**.

Worth stating plainly: both defects were invisible to the test suite and to a
single-tab demo. They only appeared when two clients with different needs shared
one worker — the configuration the whole design is for.

---

## 12. CSRM and SSRM — a defect audit

VRM was the detour; these two are the modes that matter. What follows is a
deliberate hunt through both, each finding reproduced before it was fixed.

### SSRM

**1. Grouped blocks were misaligned by one row — data corruption.**

A grouped Perspective view puts the ROOT (`__ROW_PATH__: []`, the grand total)
at index 0, so grid row N is view row N+1. The code windowed first and dropped
the root afterwards, which costs a row per block:

```
block [0,100)   asked 100, got 99   → HOLE at grid index 99
block [100,200) asked 100, got 100  → group 99 lands at grid index 100
```

Every block after the first was shifted by one and one group was never
delivered at all. The offset belongs on the REQUEST, not the response.

Invisible in the demo, which groups by `desk` — four groups, well inside one
block. Any realistic grouping (book, issuer, CUSIP) corrupts.

*Verified against the live hub grouping by `positionId` — 20,000 groups, 100
blocks: 200/200/200 rows per block, zero holes, no duplicates, and the boundary
at indices 198–202 strictly contiguous.*

**2. A view could be disposed mid-read.**

`getRows` took a handle from the cache and then awaited a window read. A
concurrent `getRows` could evict and dispose that same handle in between, and
the read then failed against a deleted view. AG-Grid issues block loads
concurrently, so this is an ordinary fast scroll, not a rare interleaving.

Handles are now pinned for the duration of a read, and the pin is taken in the
same synchronous step as the cache lookup — pinning after the insert leaves
exactly the window the bug lives in. An all-pinned cache goes briefly over its
cap rather than failing a block.

**3. Eviction could discard the entry just inserted.** With everything else
pinned, the newest entry was the only unpinned candidate — so the view the call
existed to cache was the one thrown away.

**4. SSRM never showed live updates at all.**

There is no delta path in SSRM: the grid owns its blocks, and the only way to
show new values is to re-fetch the loaded ones. Nothing did. An SSRM blotter
rendered its opening snapshot and never changed again — silently wrong prices
on a trading desk.

`attach(control, gridApi)` now refreshes on upstream change, coalesced to 1 Hz,
with `purge: false` so the grid does not blank on every tick. *Verified live: 8
refreshes in 8 seconds, all visible rows updating, 0 failures.*

**5. The view-cache key was order-sensitive.** `filterModel` key order follows
the order the user applied the filters, so the same two filters applied in the
other order missed the cache and opened a second view for a query already held —
at ~300 ms and 3.3× ingest cost per grouped view. Now hashed key-order
independently, with array order (sort precedence) still significant.

**6. Failures were undiagnosable.** `catch (e)` discarded `e`, so every SSRM
fault looked identical from outside: one blank row. The cause is now retained on
`lastError`.

### CSRM

**7. Every update during the snapshot read was lost.**

`on_update` only delivers deltas that occur after registration, and CSRM
registered *after* `await readWindow`. At 2,000 rows/sec over a 20k-row pivot
that is hundreds of rows, left showing stale values until they happened to tick
again — and a slow-moving row stays wrong all day.

Now subscribes first, buffers, and replays after the snapshot is installed. A
delta predating the snapshot is applied twice, which is harmless: the merge is
idempotent. At-least-once is the correct bias; at-most-once loses data.

**8. `stop()` left the mirror populated.** `this.rows` decides add-vs-update.
Carried into a restart it claims rows the grid no longer holds are known, so
they go out as updates — and an update against a node that does not exist is a
silent no-op. The rows simply never appear.

**9. Duplicate row ids passed silently.** A `keyColumns` misconfiguration
collapses the dataset; AG-Grid surfaces it much later as an opaque duplicate-node
error. Now counted and reported at load.

### Both modes

**10. The filter menu offered an operation the server cannot execute.**

Perspective has `contains` but no negation of it, and AG-Grid offers **"Not
contains"** in the DEFAULT text filter menu. A trader picking it made every
`getRows` throw and the grid go blank, with nothing to indicate why.

The offered options are now derived from the translator's own capability map, so
the menu and what the server can execute cannot drift. Two tests guard the
invariant in both directions: everything offered must be translatable by SSRM
*and* evaluable by CSRM. That second direction caught date `>=` / `<=`, which
SSRM accepted and CSRM would have thrown on.

**11. Every lifecycle transition was published twice.**

The actor and the adapter both transitioned through
connecting/snapshotting/live, and both published — once bare from the actor,
then the same state again with detail from the adapter. Anything counting
transitions (reconnects, for one) double-counted.

The adapter owns the externally visible lifecycle and carries the detail, so it
is now the sole publisher. The actor's FAILED is the exception and still gets
out: it checks the snapshot row count against what it was told to expect, which
the adapter cannot see.

*Before:* `connecting, connecting, snapshotting, snapshotting, live, live`
*After:* `connecting (replay), snapshotting +detail, live +detail`

### One demo bug, worth recording because of how it read

The CSRM blotter took the first 40 of 372 columns in artifact order — which are
`accruedInterest` and thirty-nine `additionalAttributes_*`, none of which the
feed ever touches. The grid was applying ~10,000 updates every five seconds with
not one visible cell changing, which reads exactly like a broken live path.

Measuring which columns actually move settled it: `pnl`, `marketValue`, `dv01`,
`yield`, `zSpread` and the other risk and P&L fields. The demo now leads with
those. Nothing was wrong with CSRM — but a demo that cannot show its own
liveness is worth fixing, because the next person to look will draw the same
wrong conclusion.

---

## 13. CSRM/SSRM audit, round two — the parity harness

§12 was a read-through. This round compared the two modes against each other on
the live 20,000-row table: CSRM answering locally, the hub answering the same
question over the same data. Comparing beats reading — it found things a careful
read had already walked past.

### 14. Row identity was computed four different ways, and one of them was wrong

`CsrmDataService.keyOf` joined composite key parts with **nothing**:

```js
return this.keyColumns.map((c) => row[c]).join('');
```

So did the hub's own `normalize.mjs`, which mints `__key`. Meanwhile `csrm.mjs`
and `ssrm.mjs` joined with U+0001. Four copies, two encodings.

Consequences, all silent:

- `rankOf` compared a key the grid produced (separated) against one built here
  (concatenated) and never matched — `ensureIndexVisible` did nothing on any
  composite key.
- `resolveSelection` had the same fault: acting on positions the trader did not
  pick.
- The hub and the provider disagreed about which row was which, which the parity
  study calls out as the thing that must be byte-identical or transactions do
  not route.
- `{book:'CMBS', id:'P-1'}` and `{book:'CMBSP', id:'-1'}` became the same row.

**Why it kept happening.** The separator is invisible in source. Any tool that
touches a file containing it as a literal can drop it. The existing test looked
like a guard but was vacuous:

```js
const SEP = '';                                  // stripped
assert.ok(rows[0].__key.includes(SEP));          // includes('') is ALWAYS true
```

Now one encoder in `dshub-spec/src/rowkey.mjs`, the separator built via
`fromCharCode` so no literal ever appears in source, and tests that assert the
character is really U+0001 and that colliding inputs produce different keys.
`key-agreement.test.mjs` compares the layers against *each other* rather than
against a hardcoded string, so it keeps holding if the encoding is deliberately
changed and fails the moment one layer changes alone.

### 15. Counts, aggregates and exports silently ignored half the filters

`HubDataService` carried a SECOND, simpler filter translator that disagreed with
the one `SsrmMode` uses for `getRows`. Anything it did not understand — AG-Grid's
combined AND/OR form, and the quick-search pseudo-column — it returned `[]` for.
`[]` means *no filter*.

So the grid rows were filtered correctly while the row count, aggregates, export
and copy-all reported over the entire dataset. **A trader exporting "my filtered
view" got all 20,000 rows, and nothing indicated it.**

Measured on the live table, combined AND: grid 2,502 rows, hub count 20,000.

One translator now. Where it cannot express something it throws, and the caller
surfaces it — loudly unsupported is recoverable, quietly wrong about a book is
not.

### 16. Case-insensitive equality: same box, opposite answers

AG-Grid text filters are case-insensitive by default. Typing `govies` instead of
`Govies`:

| | CSRM | SSRM |
|---|---:|---:|
| before | 2,502 | **0** |

Probing each operator separately showed the divergence is narrow — Perspective's
`contains`, `begins with` and `ends with` are *already* case-insensitive and
agreed for free; only `==` and `!=` are case-sensitive. Worth measuring rather
than assuming, because it meant the fix had to touch two operators, not seven.

Case-folded equality now translates to a computed column, `lower("desk")`,
compared against a folded literal. Two supporting fixes were needed: the hub
dropped `expressions` on every query path, and `toPerspectiveViewConfig` had to
merge caller-supplied expressions with the ones the filter derives — otherwise
the filter references a column that is not in the schema.

### Result

14 filter cases, CSRM versus the hub, on the same live 20,000 rows:

```
equals exact / lowercase / UPPERCASE / MiXeD      2,502 = 2,502
notEqual lowercase                               17,498 = 17,498
combined AND                                      2,502 = 2,502   (was 20,000)
ci equals + set filter                              408 = 408
set filter / contains / greaterThan / inRange     all agree
```

**Zero disagreements.**

### A note on the environment, not the code

Mid-audit a datasource failed with `snapshot sentinel not seen within 120000ms
after 5270 rows`, which looked like a regression from the filter changes. It was
not: 24 STOMP connections were open, each pulling a 20,000-row snapshot from one
server. Closing the stale tabs took it to 0 and the next run was clean.

Worth recording because the failure mode is indistinguishable from a code fault
at first glance, and the reflex to bisect the diff would have wasted the time.
It also says something real about the deployment: the SharedWorker is what keeps
this to one connection per browser, and the measurement above is what happens
without it.

---

## 14. Phase 6 — the remaining browser-reachable transports

**Status: transports done and demonstrated. Backpressure ladder and reconnect
diff are NOT done** — see the end of this section.

### One lifecycle, four transports

STOMP, raw WebSocket, socket.io and REST differ in how bytes arrive and how a
snapshot is requested. Everything around that is identical: the state machine,
failover across endpoints, exponential backoff, snapshot row accounting and the
declared-count check, and the timer discipline.

Writing that four times means writing the same backoff bug four times, and the
parts most worth getting right — "upstream loss is `stale`, not `failed`,
because the cache is still valid" — are exactly the parts nobody re-derives
carefully on the fourth copy. So `adapters/base.mjs` owns the lifecycle and a
subclass supplies `openTransport` / `closeTransport`.

STOMP was migrated onto it first, with its existing 17 tests as the check that
nothing changed.

That refactor immediately caught a divergence I had introduced myself: my base
used `${param}` substitution and returned the template unchanged on a miss,
while STOMP used `{param}` and THREW. STOMP was right — a destination still
reading `/snapshot/positions/{clientId}` subscribes to a literal topic of that
name and receives nothing, which is a silent empty blotter with a healthy
connection.

### socket.io without the dependency

socket.io is Engine.IO framing with the Socket.IO protocol on top, and both are
ordinary text: `4` wraps a message, `42["rows",[…]]` is an event. A normal
WebSocket carries it, so the client is a ~40-line codec rather than a
dependency — which matters because the host is a SharedWorker with an import map
and no bundler.

The ping/pong is not optional: an Engine.IO server closes a client that stops
answering `2`, so ignoring it means being dropped every `pingTimeout` and
reconnecting forever, which reads as an unstable network.

### rest-then-subscribe: the ordering rule, but worse

Everywhere else the rule is subscribe-before-trigger. Here the snapshot is a
different protocol entirely, so it is easier to get wrong and costlier: an HTTP
page-through of 500k rows takes tens of seconds, and every update in that window
is lost — the grid looks complete and is simply stale in places.

So the update transport is opened and subscribed FIRST, its rows buffered during
the page walk, and replayed once the snapshot lands. Applying a buffered update
twice is harmless; dropping one is not recoverable.

### Demonstrated, not asserted

The exit criterion is that every transport serves the SAME blotter from config
alone. Unit tests only prove the adapters parse what the tests feed them, so
`apps/dshub-spike/multi-transport-server.mjs` replays the real captured 20,000-row
corpus over REST (paginated) and raw WebSocket, and two config entries point at
it. The only code change was letting the demo page read `?ds=` — the adapters,
hub and provider were untouched.

| datasource | transport | result |
|---|---|---|
| `positions` | STOMP | 20,000 rows live, 33,091 updates applied |
| `positions-ws` | raw WebSocket | 20,000 rows live, 21,839 updates applied |
| `positions-rest` | REST snapshot + WS updates | 20,000 rows live, 22,357 updates in 6 s |

### Two bugs this surfaced

**`schemaRef` was ignored.** The hub resolved artifacts by datasource id, so
`positions-ws` and `positions-rest` — the same book arriving three ways, sharing
one `schemaRef: positions@v1` — got no artifact and failed with "cannot build a
table schema from an artifact with no columns", which points at the artifact
rather than at the lookup. `schemaRef` exists precisely to allow that sharing.

**One malformed row killed a whole datasource.** `normalize` reads the payload
with `Object.entries`, so a null row throws; ingestion sits behind one catch per
transport, so a single bad record took the book down with an error naming the
normalizer instead of the feed. `JSON.stringify` turns a hole in an array into a
`null`, so this reaches real feeds. Malformed rows are now dropped, counted, and
surfaced in stats — dropping them silently would trade one invisible failure for
another.

Both replay transports report exactly `malformed: 1`, which is the replay
fixture emitting one non-object message per connection, not the adapters. It is
visible in the console rather than inferred, which is the point.

### Still deferred

- **Entitlements** remain deliberately deferred (v1 is single-desk).
- **AMPS and Solace** remain Phase 10 — neither is reachable from a browser, and
  a datasource configured for one now gets an explicit `transport-unavailable`
  rather than a confusing connection failure.

---

## 15. Backpressure ladder and reconnect diff — Phase 6 completed

### The signal §7.4 assumes does not exist here

§7.4 says to monitor the socket's send-queue depth. A WebSocket exposes
`bufferedAmount`; the **MessagePort between the worker and a tab exposes
nothing**. `postMessage` always appears to succeed, and a tab whose main thread
is wedged looks exactly like one keeping up. The queue is real — it just lives
in the receiving tab's event loop, where the sender cannot see it.

So the signal has to be explicit. Every delta carries a sequence number and the
subscriber acknowledges what it has **applied**. Lag is sent-minus-applied, which
measures the thing that actually matters: a tab that receives promptly and
renders slowly is still falling behind.

CSRM acknowledges from **inside** the `applyTransactionAsync` callback. Acking on
receipt would report progress the grid has not made — precisely the lie the
ladder exists to detect.

A client that never acks still degrades. An older client without `ack` would
otherwise sit at lag 0 forever and the ladder would be dead code against exactly
the clients most likely to be out of date. Silence and slowness are treated
alike, which is the safe reading: both mean rows are being sent that nobody is
applying.

### The ladder could not reach its own last rung

Building it surfaced a design fault. At `snapshot-refresh` the hub stops sending
rows — so `sentSeq` stops advancing and **lag freezes**. A permanently wedged tab
would sit there forever holding its subscription, its view and its share of the
memory ceiling: the exact consumer the ladder exists to shed.

The last rung is therefore driven by time-without-progress rather than by lag. A
subscriber that keeps acking is never dropped no matter how long it runs; one
that stops making progress is dropped after a grace period, with a typed
`backpressure-disconnect` — not a silent removal, because from the tab's side an
unexplained stop is indistinguishable from a dead feed and it would sit showing
stale prices believing they were current.

`notify` subscribers are exempt: they re-read their own viewport, so a count can
never back up.

**Scope, stated plainly.** This governs the hub's control-channel delta path.
A CSRM client that consumes through Perspective's own protocol channel is
covered by that protocol's flow control, not by this ladder.

### Reconnect: compare rather than trust

When the upstream returns, the adapter re-snapshots 20,000 rows. Perspective
keys on `__key` so the data ends up correct — but every row is *written*, so
`on_update` reports every row as changed and CSRM turns that into a 20,000-row
transaction: scroll jumps, selection disturbed, every cell flashing when almost
nothing moved. Mid-trade that is worse than the disconnect was.

A book does not turn over during a five-second outage. So the re-snapshot is held
aside, diffed against what the table already holds, and only the rows that
actually differ are applied.

Two details that are easy to get wrong and expensive to miss:

- **A key that vanished has gone.** That is the only removal signal a
  non-soft-delete feed ever gives, since `on_update` never surfaces removals
  (§8.4). Missing it leaves phantom positions no update will ever clear.
- **A failed baseline read must not look like an empty table.** Diffing against
  an empty map marks every row as removed and empties the blotter. Repainting is
  the bad outcome this exists to avoid; deleting the book is a worse one, so an
  unreadable baseline applies the snapshot whole and says so in stats.

The baseline comes out of Perspective rather than a mirror kept beside the table:
a key→row mirror of a 500k-row table would roughly double the memory this system
spends most of its budget defending. It is paid once per reconnect, in the
worker, to spare every open tab a full repaint. The read is *issued*
synchronously at `begin` and awaited at `end` — deferring it by even a microtask
lets a write land first, and then the baseline already contains the change it was
supposed to predate.

### Verified

- 502 tests, 11/11 turbo tasks green.
- Unit tests cover the ladder end to end: a healthy subscriber receives every
  delta and never degrades; a stalled one is told to refresh, then dropped with a
  typed error; and **one wedged subscriber does not affect the others**, which is
  the phase's exit criterion.
- Live against the STOMP feed: 20,000 rows, 71,052 updates over 25 s, subscriber
  on rung `none`, zero drops, no errors — the ack path integrates without
  regressing the blotter. The ladder's *degradation* behaviour is proven by unit
  test rather than by a live wedged tab; forcing that live is worth doing before
  this ships.

---

## 16. Closing the SSRM gaps

Five defects, all in SSRM, all found by comparing the two modes rather than
reading them. Each was verified against the live 20,000-row table with CSRM as
ground truth.

### 1. Quick search did not work at all

`searchFilterModel` produces an OR across columns. Perspective's `filter` array
combines with AND and has no OR, so the translator threw — every `getRows`
failed the block. Before the earlier audit it was worse: the count path silently
returned NO filter, so the status bar reported the whole book.

Perspective's *expression* language does have `or`, so an OR now becomes a
computed boolean column that the filter tests:

```
__or_0 = (match(lower("desk"), '.*gov.*')) or (match(lower("trader"), '.*gov.*'))
filter: [["__or_0", "==", true]]
```

The operator forms were measured against CSRM rather than assumed —
`startsWith` 6,759, `endsWith` 3,332, `contains` 13,331, all exact.

**Regex escaping is not optional.** `match` takes a regex, and an unescaped `.`
matched all 20,000 rows; escaped it matches the 0 rows containing a literal dot.
A trader typing punctuation into a search box is not writing a regex.

### 2. `not(x)` is not valid Perspective

The obvious negation parses and then fails type resolution: *"inputs do not
resolve to a valid expression"*. `x == false` works and was checked against
CSRM's 6,669. This affected `notContains` and `notBlank`.

With expressions available, `notContains` also came *back* to the offered filter
menu — it had been excluded because Perspective has no such operator, but it has
an expression form, so the option can simply work.

### 3. The search never reached the datasource

Even translated, quick search did nothing in the grid: **AG-Grid's
`setFilterModel` silently ignores entries for columns that do not exist**, and
`__search__` is a pseudo-column. It never appeared in `params.request.filterModel`,
so the grid stayed unfiltered with no error anywhere. CSRM does not hit this
because it filters rows itself.

`SsrmMode.setSearch()` now holds it and merges it into every request — before
the view-cache signature, so two different searches never share a view.

Live: 4 desk groups → type "gov" → only Govies → clear → back to 4.

### 4. Pivot was silently ignored

`requestSignature` keyed the view cache on `pivotCols` and `pivotMode`, so two
different pivots got two different views — but `toViewSpec` never read them, so
both views were built identically and **a pivoted grid was served unpivoted
data**. Silently wrong rather than unsupported, which is the worse failure.

Pivot maps to Perspective's `split_by`. Two things it needs beyond that:

- **Restrict the columns first.** Perspective splits every column it is given,
  so an unrestricted pivot of this corpus produced **2,612 columns** — 373
  fields times each currency, all materialised — instead of 15.
- **Return `pivotResultFields`.** A split view names columns `AUD|marketValue`;
  AG-Grid cannot guess those and renders no pivot columns without being told.
  The fields are read from the DATA, because the set of splits is whatever
  values occur.

The separator matters more than it looks: Perspective uses `|`, AG-Grid defaults
to `_`, and a real instrument type in this corpus is `ABS_Auto`. With the default
separator the pivot key would be split in the wrong place.

Live: 60 pivot result columns, 0 failures.

### 5. `__search__` was special-cased in one path only

The same shape of bug as the earlier translator split: it was handled in
`toViewSpec` but not in the shared `filterModelToOps`, so the rows path saw the
search and the count/aggregate/export path asked the engine for a column called
`__search__`. It now lives in the one translator both callers use.

### Verified

526 tests, 11/11 turbo tasks green. Ten filter cases compared against CSRM on
the live table — quick search in several forms, regex metacharacters, OR,
`notContains`, `blank`/`notBlank`, case-insensitive equals, sets, ranges, and
search combined with column filters — **zero disagreements**.

### Still outstanding for SSRM

- **View creation at 500k × 160 has never been measured.** The corpus is 20,000
  rows, so the flat-vs-grouped mode thresholds rest on extrapolation from a
  dataset 25× smaller. This needs a synthesised fixture or a larger capture.
- **The backpressure ladder's degradation path is proven by unit test only.** No
  genuinely wedged tab has been driven against the live feed.

---

## 17. Perspective at 500k × 160 — the measurement the mode rule was missing

Every number behind the SSRM-vs-VRM rule came from a 20,000-row corpus, and the
rule is written for datasets 25× larger. `apps/dshub-spike/web/scale.html`
synthesises 500,000 rows × 160 columns and repeats the Phase 0 measurements.
Two independent runs; the contested one repeated three times and interleaved.

| measurement | 20k (Phase 0) | **500k × 160** |
|---|---:|---:|
| load | — | 500k rows in ~12 s (~42k rows/sec) |
| table memory | — | **1,184 MB** (14.8 bytes/cell) |
| flat filtered view | ~19 ms | **162 ms** |
| grouped view, 1 level | ~300 ms | **2,545–2,826 ms** |
| grouped view, 2 levels | — | 2,198–2,471 ms |
| grouped view, 3 levels | — | 2,382–2,628 ms |
| 50 grouped views held open | ~490 ms @100 | **181–185 ms each** |
| memory, 50 views open | — | **+1,055 MB** |
| ingest penalty, 50 views open | **3.3×** | **1.05×** (n=3) |
| read a 100-row window from the tree | 20 ms | **495 ms cold / 12 ms warm** |

### What this changes

**1. The ingest-throughput argument was an artefact of the small dataset.**

Phase 0 measured a 3.3× ingest penalty from holding a grouped view open, and
that number is quoted in `ssrm.mjs` as a reason to prefer VRM. At 500k it is
**1.05×** — busy samples 684/627/677 ms against idle 668/647/598 ms, i.e. inside
the noise. Interleaved and repeated precisely because it contradicts a published
number.

The 20k figure was dominated by fixed per-update overhead on a table small
enough for view maintenance to be a large fraction of the work. At realistic size
the update itself dominates. **"Holding views destroys ingest throughput" is not
true at scale**, and the comment in `ssrm.mjs` overstates it.

**2. Memory is the real constraint, and it is worse than throughput ever was.**

Fifty grouped views cost **+1,055 MB** on a 1,184 MB table — they nearly double
it. Against the ~3.8 GB process ceiling from §1a, one 500k table with fifty
expanded nodes is already ~2.2 GB. That is the binding limit on SSRM at scale,
and it is a much harder wall than a throughput penalty: throughput degrades,
memory ceilings terminate.

**3. Grouped view creation is an interaction-blocking 2.5 seconds.**

Not 300 ms. Expanding a node in SSRM at 500k means a ~2.5 s stall before the
children appear. That alone disqualifies SSRM for grouped views at this size,
and it is a stronger argument than the one currently written down.

**4. VRM's window reads are fast once warm, not fast always.**

The first read of a fresh tree cost **495 ms**; subsequent reads **12 ms**. The
20 ms figure from §10 is the warm case. VRM's advantage is real but its first
expansion is not free, and a UI that opens a tree and immediately reads it will
feel the half-second.

### Revised rule

Flat → SSRM: a filtered view is 162 ms and holds no meaningful memory.
Grouped → VRM: not because of ingest throughput, but because **fifty grouped
views cost a gigabyte** and each costs 2.5 s to create. VRM needs one.

### Caveat, stated because it matters

This fixture is **float-heavy** — five string dimensions and 155 numeric
measures — and reports 14.8 bytes/cell. The real corpus measured 30–42
bytes/cell because it is string-heavy. The memory *totals* here are therefore
optimistic for a real 500k × 160 book; the timings and the ratios are the
transferable part. A capture-based fixture at this size would settle it.

---

## 18. Driving a genuinely wedged tab — and what it caught

§15 proved the backpressure ladder by unit test and said plainly that no real
wedged tab had been driven against the live feed. Doing that found two defects
the unit tests could not have.

The wedge is realistic rather than synthetic: `control.ack` is replaced with a
no-op while everything else keeps running. From the hub's side that is exactly a
tab whose main thread is saturated — deltas keep arriving, nothing reports
having applied them.

### The ladder works end to end

```
t+120s   error  backpressure-disconnect
                "subscription dropped: 375 deltas unapplied (limit 500)"
         hub    slowDrops: 1,  subscriberRungs: []
```

Lag froze at **375** — the snapshot-refresh threshold, 75% of the limit — and the
drop came from the 30-second no-progress timer, not from lag. That is precisely
the time-based escalation §15 describes, confirmed against the real feed rather
than a fake clock.

### 1. The typed error was sent and never delivered

The first run dropped the tab correctly but the client saw **nothing**. An
unsolicited `error` correlates to no request, so `ControlClient.handle` fell
through to its late/unmatched branch and discarded it.

The whole reason for sending a typed error rather than silently removing the
subscription is that an unexplained stop is indistinguishable from a dead feed —
the tab sits showing stale prices believing they are current. Sending an
explanation that is then thrown away is the same outcome as not sending it.

Unsolicited errors are now emitted as an `error` event. Correlated errors still
reject their own request; broadcasting those instead would leave the caller
hanging until timeout.

### 2. The conflating rung did nothing at all

`late: 175` was the clue. `mergeDeltas` returns a bare `{columns, rows}`, and
`flush()` spread that plus a sequence number — losing `type`, `id` and `ref`.
The client matched the result to no event type and no pending request, counted
it late, and dropped it.

So the **middle rung of the ladder was inert**: a conflating subscriber received
merged batches it silently discarded, while the hub's own view of the world
looked entirely healthy. 175 messages went that way in two minutes. Reproduced
directly:

```
conflated message: {"columns":{...},"rows":1,"seq":5}     // no type, no id, no ref
```

`flush()` now carries the envelope from the queued deltas.

### 3. The refresh rung was unreachable for the client it was built for

The clean re-run still showed no `refresh`, and the numbers said why: the drop
came at 79 s with lag exactly **375** — the refresh threshold itself. The rung
was being entered and escalated past in the same call.

The grace period was measured as time since the last ACK. For a client that
never acks at all, `lastProgressAt` is frozen at construction, so by the time lag
climbs to the refresh threshold the grace period has long since elapsed.
Simulated at the real feed rate:

```
none          0s   lag 1
conflating   32s   lag 201
disconnecting 88s  lag 375      <- snapshot-refresh never visited
```

A subscriber was therefore dropped without ever being told to re-read — the
recoverable middle step skipped for precisely the case it exists to handle.

The grace period now measures time spent AT the refresh rung, and resets if the
subscriber recovers, so one stumble does not carry the clock forever.

### Verified end to end

Against the live STOMP feed, wedging a real tab by replacing `control.ack` with
a no-op:

```
t+88s    refresh   backpressure — "375 deltas behind; re-read the view"
t+118s   error     backpressure-disconnect
                   "subscription dropped: 375 deltas unapplied (limit 500)"

371 deltas delivered   |   0 discarded   |   30s grace between the two
```

All four rungs, in order, with the grace period exactly as designed — and
matching the simulation to the second.

### What this says about the testing

Three defects, none of which unit tests could have found:

| | hub's view | client's view |
|---|---|---|
| unsolicited error | sent successfully | discarded as a late reply |
| conflated delta | sent successfully | discarded, 175 in two minutes |
| refresh rung | never entered | nothing to see |

The first two share a shape: **both ends were correct on their own terms**, and
the defect lived only in the gap between them. The third was a timing assumption
that is invisible without a real clock and a real feed rate.

A ladder is a state machine whose whole value is the intermediate rungs, and
every intermediate rung here was broken while the endpoints worked. Unit tests
confirmed each rung in isolation and all of them passed.

---

## 19. Phase 7 — config store and admin UI

**Status: store, hot-reload dispatch and admin UI built and verified against
real IndexedDB. Hot reload is COMPUTED but not yet APPLIED to a running hub —
see the end.**

### The store

Two decisions that are cheap now and expensive to retrofit:

**Migrations from version 1**, even though the list has one entry. The first
version that ships without a migration path turns every later schema change into
a choice between losing users' config and writing the migration retroactively
against data you can no longer see. A fresh database runs the whole list from
`oldVersion: 0`, so a new install and an upgraded one reach the same shape —
which is what makes the list trustworthy rather than decorative.

**Validation on every write.** A malformed datasource in IndexedDB is not a
caught exception; it is a blotter that fails to start tomorrow morning with an
error pointing at the worker rather than at the typo. `validateForWrite` also
rejects password-shaped fields, which is the write half of "config carries a
`credentialRef`, never a secret" — export and import already had theirs.

**The IndexedDB trap this file is written around.** A transaction commits as
soon as the microtask queue drains with no pending request against it. So
`await` on anything that is not an IDB request — a fetch, a timer, a hash —
silently ends it, and the next write throws `TransactionInactiveError`. Every
method awaits only IDB requests, and validation is deliberately synchronous so
it can run inside a transaction without killing it.

### Hot reload is read out of the schema, not hard-coded

Every field already carries `x-reloadClass`. `reloadPlan` diffs two configs and
returns the strongest class implied, so a new field gets its reload behaviour by
being *annotated*, not by being added to a list in code.

Building it caught a real bug: **an annotation sitting beside a `$ref` was being
dropped.** `connection.id` is `{"$ref": "#/$defs/id", "x-reloadClass":
"restart"}`, and dereferencing first then reading the annotation off the target
reported `none` — so changing a connection's id would have been applied as a
live edit, when it invalidates every datasource pointing at it.

The Phase 7 exit criterion resolves straight from the schema:

```
conflation.defaultIntervalMs  ->  live
keyColumns                    ->  rebuild
```

### The editors are generated, and that is a correctness decision

A hand-written form is a SECOND definition of what a datasource is: add a field
to the schema and the form silently cannot set it; change an enum and the form
offers a value the validator rejects. `fieldsFor` turns a `$defs` entry into a
field list — 17 for a connection — carrying widget, enum, required and reload
class.

Discriminated unions expose only the ACTIVE branch. Showing every branch at once
offers `snapshot.triggerDestination` beside `snapshot.url` and lets someone build
a config that validates as neither.

### Flatten preview runs the real normalizer

A preview that agrees with itself and disagrees with production is worse than
none, so it imports the worker's `createNormalizer` rather than approximating it.
The value is the comparison — the same message under all four strategies:

| strategy | columns | child rows |
|---|---:|---:|
| `index-pin` | 6 | 0 |
| `aggregate` | 4 | 0 |
| `json-string` | 4 | 0 |
| `explode` | 3 | 3 |

Writing it caught two things. The strategies I first coded — `index`, `join`,
`drop` — **do not exist**; the schema declares `index-pin`, `aggregate`,
`json-string`, `explode`. And warnings were computed only on success, so the
most useful ones were unreachable: a key column the message does not carry makes
the normalizer *throw*, and it raises "missing key column(s)", which names the
symptom. Warnings are now computed first and survive the failure.

### Verified against real IndexedDB

| exit criterion | result |
|---|---|
| datasource created through the generated form | 17 fields, saved and persisted |
| invalid enum refused on write | `config-invalid` |
| password-shaped field refused on write | `config-invalid` |
| dangling `connectionRef` caught | `config-invalid` |
| **export → wipe → import** | **byte-identical checksum** |
| tampered checksum refused | "the bundle was altered or truncated" |
| newer `specVersion` refused | "bundle is spec 2.0; this app speaks 1.0" |
| embedded password refused on import | "password-shaped field" |
| **IDB migration over a populated store** | 2 rows survived, all rewritten, new store created, data intact |

The migration was exercised properly: open at v1, populate, reopen at v2 with a
migration that adds a store *and* rewrites existing rows via a cursor inside the
upgrade transaction.

### The worker now reads the store

Reading the static example file was fine while nothing could edit config. Once
the admin UI writes to IndexedDB, reading the file would mean edits appeared to
save and then had no effect — the worker serving one config while the editor
showed another, with nothing to indicate which was live.

The worker now reads IndexedDB, seeding from the example bundle exactly once
(re-seeding on every start would silently revert every edit, which is the same
failure as not persisting them). Verified end to end: clean IndexedDB → blotter
live at 20,000 rows, 52,231 updates, with all three connections and datasources
persisted and `bundleVersion: 1` recorded.

### Hot reload — now APPLIED to the running hub (§3.8)

The remaining half of the exit criterion. `pushConfig` (already in the protocol,
previously unhandled) now reaches `hub.applyConfig(nextBundle)`, which:

- computes the reload plan ITSELF via an injected planner (the schema loads once
  at the worker edge; the hub core stays free of it). Computed rather than passed
  in on purpose — a caller that could hand the hub a weaker class than the edit
  really is would turn a rebuild into a silent live-poke and leave the grid
  addressing rows that no longer exist;
- **live** → mutates the running actor's batch fields and every subscriber
  flow's `conflateMs` IN PLACE. Both are read fresh at runtime, so the change
  takes effect on the next tick with no reconnect and no re-snapshot;
- **resubscribe / rebuild / restart** → re-establishes the upstream, KEEPING the
  subscribers (a config edit must not silently drop a trader's blotter) but
  sending each a `refresh` BEFORE the table is torn down — after a key-column
  change their cached rows key on identities that no longer exist.

One bug surfaced building it: a live entry's key is `datasourceId#<superset
params>`, not the bare id, so looking it up by id found nothing and every change
reported `not-running`. Fixed to match every entry whose key starts with the id.

**Verified live through the worker:**

| change | plan | observed |
|---|---|---|
| conflation interval | `live / in-place` | no `snapshotting`, stayed live, data uninterrupted |
| key columns | `rebuild / re-established` | `refresh(reconnect)` → connecting → snapshotting → live |

The rebuild event order is the design working: the refresh reaches the client
before teardown, so its invalid rows are abandoned before the new schema lands.

### Not done
- **Test connection** and **sample-and-infer** are not built. The adapters
  support the read-only connect the plan describes, but the admin flows around
  them do not exist.
- **Seed URL** is explicitly optional in the plan and deliberately skipped.

### A verification mistake worth recording

Two runs failed before this worked, and neither was the code. `deleteDatabase`
fires `onblocked` when another tab holds the database open — and I resolved on
`onblocked` as though it had succeeded, so the reset silently did nothing and
the next open hung waiting for a lock. The admin tabs were the holders. Closing
them fixed it.

Worth writing down because the symptom — a hanging transaction — points
squarely at the transaction code, and the cause was in the test harness.

### Admin UI revision — progressive disclosure

Feedback: too verbose, too many inputs, non-intuitive. The cause was rendering
the schema's shape directly — 39 flat dotted-path inputs. The fix keeps the form
100% generated but layers three rules on top (`sectionsFor`):

1. Fields group into CARDS by top-level key (Basics, Snapshot, Updates, …),
   each carrying the strongest reload badge inside it.
2. A field renders when it is REQUIRED or already SET; the rest fold behind
   "+N more settings". Untouched optional cards start collapsed.
3. Labels are relative to their card: "End Of Snapshot › Kind", not
   `snapshot.endOfSnapshot.kind` (the full path moves to the tooltip).

New connection: 17 inputs → **3**. New datasource: 39 → **10**. Verified in the
browser: create through the reduced form, open a folded card, edit an advanced
field (`reconnect.initialMs`), save — all persist to IndexedDB.

### Borrowed from the stern provider editor

Studied `stern-bak/packages/react-grid/widgets-react/.../provider-editor` for
shape. Their trade: hand-written per-transport field groups (STOMP = 5 curated
inputs with helper prose and placeholders) — friendlier, but a second definition
of the config, which is the drift this project's generated forms exist to avoid.
Borrowed the presentation instead:

- **Help under the field, not in a tooltip** — the schema descriptions now
  render beneath visible inputs; a tooltip hides exactly the sentence that
  makes an unfamiliar field usable.
- **Test connection** (their `useProviderProbe`, our `probe.mjs`): drives the
  REAL adapter read-only — connect, subscribe, trigger, capture first N rows,
  report sentinel + timing + state timeline, tear the socket down. A probe with
  its own simplified client would pass configs the worker then fails on.
  Verified live: `LIVE in 939ms — 20,000 rows to the sentinel`, with the
  connecting → snapshotting → live timeline and 5 sample rows.
- Timeout diagnosis includes rows seen — "0 rows in 10s" and "5,270 rows then
  silence" are different faults.

Still not built from their feature set: infer-fields → column picker (their
Fields/Columns tabs), and the new-provider type picker.

### Second pass on verbosity: visible = required, full stop

The first cut showed required-or-set, and a populated datasource still rendered
~32 inputs — the seed config sets many optional fields, so "set" is no signal of
what a person needs on screen. Two rule changes:

- An optional field folds EVEN WHEN SET; the fold label carries "· N set" so a
  configured value is never hidden silently.
- A field required only *inside an optional parent that is absent* (opField.path,
  softDelete.column) is a conditional requirement, not an up-front decision — it
  folds until the parent gains a value.

Populated datasource: 32 → **11** visible inputs, matching the ~10 decisions a
human actually makes (stern's curated STOMP form is 5 for the connection slice
alone). Saving an untouched form round-trips every folded value byte-identically.

### Admin UI rebuilt as ONE entity (user decision, 2026-09-03)

Feedback against the stern editor: the connection/datasource split is not a user
concept — no two datasources share a connection — and the generic forms were
still too heavy. The editor is now stern-shaped: sidebar → Name → **Connection /
Fields / Columns / Behaviour / Diagnostics**, one entity.

The STORAGE model keeps the split (hub, bundle codec and refs depend on it):
`splitEntity`/`mergeEntity` write and read the pair, the connection id derived
from the datasource id so refs are consistent by construction and re-saves
overwrite. Curated per-transport tab lists (STOMP ≈ 7 inputs) can only reorder
and omit — labels, enums, help and validation still come from the schema walk,
and everything else lives behind "Advanced — all settings".

New pieces: **Infer Fields** (probe N rows → run the REAL flattener → checkbox
list, stern's union-by-field commit so header edits survive re-runs) and
**Columns** (key picker + editable header/type), saving a versioned artifact the
worker and blotter now resolve from IndexedDB.

Building it surfaced three real mismatches, all caught by the validator:
- id pattern forbade dots — `test.dp`-style names are the working convention;
- `schemaRef` pattern likewise;
- the curated tab omitted `replyDestination`, which stern proves is the same
  value as the listener topic on every server seen — it now defaults from it,
  and an explicit value is never overwritten.

**Exit criterion demonstrated end to end, all through the UI**: New STOMP →
name `test.dp`, URL + topic + trigger + sentinel (7 inputs) → Test Connection
(`LIVE in 962ms — 20,000 rows`) → Infer Fields (200 rows sampled, **372 fields
detected**) → pick 10 → key auto-suggested `positionId` → Save → blotter at
`?ds=test.dp` live with **exactly those 10 columns**, 4,919 updates in 5s.
No code, no engineer, no separate connection step.

---

## 20. Phase 8 — the parity and view-leak harnesses (two exit criteria)

Most of Phase 8 (SSRM/VRM, filter translation, grouping, pivot, quick-filter)
landed during the CSRM/SSRM work. Its EXIT CRITERIA — the automated proofs — did
not. Two now do.

### Parity harness (automated)

The 14-case CSRM-vs-hub comparison I had been running live by hand is now a
deterministic test: **61 cases across the filter / sort / group / aggregate
matrix**, every one asserting identical row keys and identical aggregates.

The oracle problem, handled honestly. CSRM resolves through `filter.mjs`; SSRM
translates to engine ops that Perspective executes, and a Node test has no
Perspective. So the harness runs the REAL translation (`toFilterOps`) and
evaluates the result with `evalOps` — a reference evaluator calibrated against
the live engine (§12, §16: case-insensitive equals and regex-substring were
measured, not assumed). It therefore catches TRANSLATION drift, which is what
actually broke repeatedly, while the live parity page keeps the oracle honest.

Building it caught a harness bug that was itself a lesson: comparing against the
bare `rowPredicate` reported CSRM finding 0 rows for a quick search while the
service finds 400 — because `rowPredicate` does not know the `__search__`
pseudo-column; `CsrmDataService.applyFilter` does. The harness must compare the
paths the modes actually RUN, not a lower-level primitive. Fixed to use
`applyFilter`, the same entry point `getRowCount` uses.

The corpus is deliberately shaped to break parity: 182 blanks including a true
null distinct from empty string, a zero quantity (blank-vs-zero), and rows on
both sides of a numeric boundary. `Math.random` is banned here and would be
irreproducible anyway, so it is index-derived.

### View-leak test (automated)

"500 expand/collapse cycles and 50 filter opens return the open-view count to
baseline." Split across the two layers that own views:

- **Provider** (`viewleak.test.mjs`): 50 distinct SSRM filter opens past a
  cap of 12 dispose the excess as they evict and drain to 0 on teardown; the
  same filter re-opened 30× opens exactly ONE view; **500 VRM expand/collapse
  cycles hold exactly one view throughout** — VRM's whole argument, and a leak
  here would be 500 orphans. Plus the `ViewCache` primitive under an interleaved
  open/clear stress that must never end above baseline.
- **Hub** (`hub.test.mjs`): 50 managed views opened by a session, then the
  session disconnects → `openViewCount` and the live engine-view count both
  return to baseline; a transient query view is disposed in its `finally` and
  never enters the managed map.

### Still open in Phase 8

- **Automatic mode selection** — `selectMode` exists but is not wired to a
  blotter from row count + grouping complexity.

---

## 21. Phase 8e — group-aggregate deltas ("what makes SSRM feel live")

The baseline refreshes every loaded SSRM block once a second: correct, but up to
a second behind and re-reading leaf blocks that never moved. The plan's fix is to
let the ENGINE do the work — watch a parallel grouped view, whose `on_update`
reports exactly which groups changed and to what.

**Three layers, each testable on its own:**

- **`groupwatch.mjs` — the differ** (11 tests). Successive grouped-view snapshots
  in, changed group paths out: new / changed / removed, with a float epsilon so a
  1e-12 wobble is not a change, the root total skipped, and a vanished group
  reported as removed so the client drops a stale node rather than leaving it.
- **`hub.watchGroups`** (7 tests). Per session and per grouping: opens a grouped
  view, attaches a differ to its `on_update` via a `watchView` seam, sends a
  `groupDelta`. Re-grouping REPLACES the view (no leak); the same grouping twice
  opens nothing new; a disconnect disposes it back to baseline — the leak test
  from §20 extended to cover it.
- **`SsrmMode.onGroupDelta`** (4 tests). Refreshes only the changed routes, and
  `routesToRefresh` (moved to the spec package, shared by both sides) collapses
  sibling changes into one refresh of their shared parent: ten desks ticking is
  ONE root refresh, not ten and not a whole-tree purge. The coarse `rowDelta`
  timer still runs for leaf-level changes — the two paths coexist.

**Verified live** on the SSRM blotter grouped by desk: in 8 seconds, **43 group
deltas** carrying 344 changed paths drove **43 targeted route refreshes**, and
all **8 top-level desk aggregates updated** with correct values (EM Debt dv01
14,566,535 → 14,553,117, Govies 12,718,973 → 12,728,394). The engine groups; the
hub forwards only what moved; the client refreshes only those routes.

---

## 22. Phase 8g — cell selection survives an SSRM scroll

AG-Grid tracks a cell range by ROW INDEX. In CSRM every row is loaded so an
index is stable; in SSRM the grid discards blocks as you scroll
(`maxBlocksInCache`), so the row at index 4,200 is a different node — or none — a
moment later. Drag a selection past the viewport and it evaporates: the range's
endpoints point at recycled indices.

The fix anchors the selection to ROW KEYS (stable) and reconciles back to indices
on every block load. `cellSelection.mjs` is the pure half — the reconcile math,
where the bugs live — with the ~20 lines that touch AG-Grid isolated in
`attachCellSelection`. The three cases that matter (12 tests):

- **both endpoints loaded** → restore at their CURRENT indices, which may have
  shifted since capture — that shift is the entire point;
- **one endpoint unloaded** → clamp to the visible half, so a partial drag keeps
  its on-screen part;
- **both unloaded** → hold the keys, restore nothing now; they come back on a
  later block load. Clearing would lose the selection for good.

A self-restore guard keeps the restore we trigger from being re-captured as a
user action — without it a partial restore would shrink the selection
permanently.

**Verified live**, the exit criterion exactly: a scripted drag past the viewport
at **three scroll speeds** (200 / 2,000 / 9,000-row jumps, blocks unloading and
reloading each time). The selection survived all three — the same two keys
restored to the same rows every time, 0 partials, the saved keys resolving to
real indices after each round trip.

### Phase 8 exit criteria — status

- **Parity harness passes** — §20, 61 cases automated.
- **View-leak test passes** — §20, provider + hub.
- **Cell selection survives a scripted drag at three speeds** — this section.
- **A trader cannot tell which mode they are in** — parity (§20) plus live group
  aggregates (§21) make the two indistinguishable in behaviour.

The one item left in the phase is cosmetic-adjacent: **automatic mode selection**
(`selectMode` exists but is not wired to a blotter from row count + grouping
complexity). Every correctness criterion is met.

### Cell selection under a live feed — the churn bug

Field report: mouse range selection was sluggish and clipped to a few cells. My
own fix caused it. `onModelUpdated` fires many times a second on a streaming
blotter, and each call ran `restore()`, which clears and re-adds the range — so
mid-drag, a live tick kept snapping the selection back to the previous tick's
extent. The persistence machinery was fighting the user.

Two guards, both in the pure layer: never restore while a drag is in progress
(`bindDrag` tracks mousedown→window mouseup, since AG-Grid's drag events are for
columns not cell ranges), and never restore a selection that is already intact
(`isIntact` compares the current range's endpoints to the saved keys, order-
independent). Restore now runs only when a scroll genuinely lost a block.

Verified live: an 81-cell range dragged across ~6 live-refresh intervals held at
81 throughout and stayed 81 after release — **0 restores during the drag**, where
before every tick clipped it.

---

## 23. Phase 9 — the DSL (parse / eval / compile)

Phase 9 (conditional styling, alerts, calculated columns, the write path) all
rests on one thing: a rule language that is safe to hand LLM output. The DSL is
built so `new Function` is never needed — text → tokens → AST → either a
tree-walk (client) or a Perspective expression string (engine). Nothing is ever
eval'd, which is both the OpenFin CSP requirement and the reason an
LLM-configurator cannot inject code.

**Tokenizer** — small grammar on purpose (comparisons, boolean logic,
arithmetic, a fixed function set, fields, literals): every construct has to be
reproducible in BOTH targets or explicitly refused, because a grammar that can
say things Perspective cannot is one that silently diverges between modes.
Strings escape with doubled quotes, never backslashes (a favourite injection
vector the DSL never needs); a bare `=` is diagnosed as the `==` mistake by name.

**Parser** — Pratt precedence climbing to an AST carrying source positions, so a
bad rule points at the offending token — which the LLM repair loop needs.
`fieldsOf` lists the columns a rule touches, for validating against the live
schema before persisting.

**Evaluator** — the client target. Compiles the AST into a nest of closures at
authoring time so the render hot path calls a closure, not an interpreter
dispatch. Fails SOFT: a rule referencing a renamed column yields null, never a
throw that blanks the grid mid-render. `&&`/`||` short-circuit; `==` folds case
the same way filter.mjs and the engine do.

**Compiler + capability matrix** — the engine target. Calc columns and alert
predicates MUST run in Perspective, because in SSRM the client sees only a window
and a client-evaluated alert would miss every out-of-viewport row (§9.1). Rules
that compile go to the engine; rules that cannot (`contains`/`startsWith` — no
substring predicate in Perspective) are refused with a typed
`unsupported-expression` and classified client-only, so a rule is never SILENTLY
divergent. `not` compiles to `== false`, the form the engine actually accepts
(§16).

27 tests. The property that matters — the same rule evaluates identically
client-side and is engine-capable, or is explicitly one-or-the-other — is
asserted directly.

Still to build in Phase 9: authoring validation (compile + dry-run against live
schema), the alert path (hub view per rule, on_update → alert event), the write
path (command RPC, optimistic apply, reconcile on echo), and the chatbot loop
(LLM emits DSL, structured compile errors feed repair).

---

## 24. Phase 9 — hub-side alerts, over the full table

An alert is a promise: tell me when ANY position crosses this line. In SSRM the
client holds only a window, so a client-side alert silently watches only the rows
scrolled into view — a trader who set "PnL < -900k" and is looking at the top of
the book would never hear about a blow-up 40,000 rows down. So the predicate runs
in the hub, over the whole table, independent of any client viewport or filter.

**Mechanism.** The DSL predicate compiles to a filter; a hub view over the full
table holds exactly the rows currently over the line. `AlertWatcher` diffs that
view's membership and fires on the TRANSITION in (a position parked over the
threshold alerts once, not once per tick — a per-tick alert is noise a trader
learns to ignore). A vanished match clears. Compiled hub-side from the safe DSL
grammar, so the client never hands the engine a raw expression, and a predicate
that cannot run in the engine is refused with its reason rather than silently
watching nothing.

**A real engine limitation, found by building on it.** The obvious path — compile
the predicate to a boolean expression column and filter on `expr == true` — does
NOT work in this Perspective build: expression-column COMPARISONS are broken
(`"pnl" < 0` returned `true` for every row, positive included; `> 1000000`
returned false for every row). Arithmetic expression columns work fine. So the
predicate compiles to the NATIVE filter the parity harness validated (§20), and
only arithmetic sub-expressions (`marketValue - costBasis > 1000`) are lifted
into an expression column the native filter then compares. `compileFilterOps` is
that translation: comparisons to filter ops, AND flattened, OR to an or-node,
literal-on-the-left normalised, text equality case-folded (§16), column-to-column
and substring predicates refused.

**Verified live, the exit criterion exactly.** With the grid filtered to show
ONLY Govies, an alert on `pnl < -900000` fired for all 8 desks — 7 of them
(Structured Products, Rates, EM Debt, …) rows the grid was actively hiding.
Every alert genuinely breached, zero false positives. The alert saw the whole
book while the trader saw one desk.

### Phase 9 — remaining

- Authoring validation (compile + dry-run against live schema before persisting).
- The write path (`command` RPC, optimistic apply, reconcile on echo).
- Chatbot loop (LLM emits DSL, structured compile errors feed repair).

---

## 25. Phase 9 — the write path (optimistic apply, reconcile on echo)

Perspective is a read model, so a write (v1 scope: annotations) does not edit it
directly — it goes to the authoritative store and returns through the normal
feed. A trader editing a cell must see it instantly, not after a round trip, so
the edit is applied OPTIMISTICALLY, marked pending, and reconciled when the echo
lands.

**`WriteManager` — the client state machine** (16 tests). `submit` applies the
value with a pending marker and sends a command; the resolution is one of:
- **confirmed** — the echo carries our value; clear the marker;
- **diverged** — the echo carries a DIFFERENT value (server adjusted or partially
  filled); the authoritative value wins silently, because the feed already
  delivered it and a guess being wrong is not an error;
- **rejected** — the commandResult said rejected, or nothing came back within the
  timeout; roll the cell back and surface it, because a silently-dropped order is
  the one failure a trader must never have.

Every write carries an `idempotencyKey` stable across retries, so a network retry
of an ambiguous timeout cannot double-apply. A second edit to the same cell
supersedes the first; an echo on one field leaves a pending write on another
alone.

**Hub side** — v1 applies the annotation as a keyed partial row update, which
echoes to every subscriber via the feed; deduped by idempotencyKey so a retry
hits the table exactly once.

**A correlation bug this surfaced.** `commandResult` was in the client's EVENTS
set, so the reply to a `command` request was emitted as an unsolicited broadcast
and the request promise hung forever. It is the correlated reply, not a
broadcast — removed from EVENTS, with a regression guard. Same shape as the
unsolicited-error bug in §18: a message routed to the wrong half of the client.

**Verified live end to end:** an edit showed `777.5` optimistically (pending),
the feed echo matched and confirmed it (marker cleared, 1 confirmed / 0
diverged); the same idempotencyKey twice returned applied then **duplicate**; a
malformed command returned **rejected** with its reason. A string written into a
float column correctly **diverged** — the engine coerced it and the authoritative
value won.

### Phase 9 — remaining

- Authoring validation (compile + dry-run a rule against the live schema before
  it is persisted).
- Chatbot loop (LLM emits DSL; structured compile errors feed a repair loop).

The DSL, alerts, and the write path — the phase's substance and its two hardest
exit criteria — are done.

## 26. Phase 10 — the sidecar transport (the hub, reached over socket.io)

The user's framing fixed the whole design: *"the rust side car is the exact
replica of the datasource hub that runs outside the browser, so it will behave
exactly like the current datasource hub, but the subscribers will subscribe to
this hub via socket.io."* That is not a new component — it is the **same Hub**,
in a different host, reached over a different transport. So Phase 10 in JS is not
a rewrite; it is proving the Hub is genuinely host- and transport-independent,
and pinning that with a conformance test the Rust twin must match.

Three things made this a small change rather than a large one, all of them
decisions from earlier phases finally paying out:

- **The Hub takes its host by injection** (`openSocket`, `createTable`,
  `createView`, `watchView`) — it names no `SharedWorker`, no `WebSocket`. A Node
  process satisfies the same constructor.
- **The control protocol is transport-neutral JSON** (§4). Nothing in a `hello`
  or a `subscribe` knows whether it arrived over a `MessagePort` or a socket.
- **The socket.io framing was already a small codec, not a dependency** (§17),
  so the same encode/decode runs on both ends.

**What was built.**
- `packages/dshub-spec/src/socketio-codec.mjs` — the Engine.IO / Socket.IO codec
  lifted out of the adapter so BOTH ends share one implementation, plus
  `encodeOpen(sid,…)` for the server's handshake. The adapter now imports it (and
  re-exports for existing importers — the re-export alone does not bring the
  names into local scope, so both are needed).
- `packages/dshub-provider/src/socketPort.mjs` — `socketIoPort(url,{openSocket})`
  returns a **MessagePort-shaped** object: it performs the Engine.IO OPEN
  handshake, joins the namespace, answers PING with PONG, and surfaces each
  `msg` event as `onmessage`. Because it is port-shaped, the existing `Transport`
  and `ControlClient` run against the sidecar UNCHANGED — the transport swap is
  invisible above the port.
- `packages/dshub-worker/src/sidecarServer.mjs` —
  `attachSidecarSocket(socket,{handleControl,hub,schema,validate})` is the server
  half: it sends the OPEN handshake, then routes every `msg` event through the
  **same `handleControl`** the SharedWorker uses, and wraps each reply as a
  socket.io event. The SharedWorker and the sidecar therefore share one control
  path; only the byte-plumbing differs.

**The conformance test is the deliverable** (`sidecar.conformance.test.mjs`, 4
cases). It stands up the real `Hub` behind `attachSidecarSocket` on a real `ws`
loopback, connects the provider's OWN `ControlClient`/`Transport` through
`socketIoPort`, and asserts the full exchange behaves as in-process:

- `hello → configAck` carries the sidecar hub's real bundle version — the answer
  came from across the socket, not a local stub;
- `subscribe → subscribed`, then a `rowCount` RPC round-trips;
- a malformed `subscribe` (no `ref`) is rejected identically over the wire;
- a protocol-version mismatch is refused, not silently degraded;
- **two clients on one sidecar collapse to ONE hub entry** — the superset-sharing
  guarantee (one upstream, many subscribers) holds over socket.io exactly as it
  does over the `MessagePort`.

**The hub runs outside the browser NOW — not someday in Rust.** The correction
that mattered: the sidecar is a *requirement*, and it does not have to be Rust to
be real. Because the Hub is host-agnostic JS and Perspective ships a Node build
(`@perspective-dev/client/.../perspective.node.js`), `apps/dshub-sidecar/` is a
runnable Node process that hosts the actual Hub on the actual engine and serves
subscribers over socket.io — the same tables, views, sharing, and diagnostics as
the SharedWorker, out of the browser.

- `apps/dshub-sidecar/server.mjs` — `serve()` builds the real Hub with Perspective's
  Node engine behind the SAME `createTable`/`createView`/`watchTable`/`watchView`
  seams the browser host wires (a line-for-line port of the spike's host), stands
  up a `ws` server, and attaches each connection through `attachSidecarSocket`.
- `apps/dshub-sidecar/smoke.mjs` — boots that process, connects the provider's OWN
  client over `socketIoPort`, subscribes, writes rows into the REAL Perspective
  table, and reads the count back over the socket (including an engine-evaluated
  filter). It prints `OK` having served real data from outside the browser.

Two complementary proofs, deliberately split: the conformance test pins the
**transport** with a stub engine (deterministic, in CI); the smoke pins the
**engine** with real Perspective (the "does it actually run out there" check).

**The Rust host is now an optimization, not the only way out of the browser.** A
Rust build on `perspective-server` still earns its place — lower memory overhead
than wasm, and the AMPS/Solace adapters a native process can open — and it must
pass this same conformance exchange to be the "exact replica" asked for. But the
out-of-browser requirement is satisfied today by the JS sidecar; Rust is the
faster/native second implementation of a host that already exists and runs.

**Suite:** 821 tests, 12/12 turbo tasks green (was 817 before Phase 10). The
sidecar smoke runs green against Perspective 5.3.0 (Node, memory64).
