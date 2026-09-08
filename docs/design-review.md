# DataSource Hub — Design Review

**Version:** 1.0
**Reviewed:** `architecture.md` v1.0, `ssrm-parity-study.md`, `implementation-plan.md`
**Repo state at review:** scaffolding only — no source under `packages/`, `apps/demo/` is a stub

---

## 0. Verdict

The design is sound and unusually well-informed. Ship it, with the five defects in §2 fixed first, one sequencing change in §3, and explicit answers to the open questions in §8.

The strongest structural decisions — the two-channel socket, the single-writer table actor, and `GridDataService` as the parity contract — are the ones the rest of the system rests on, and they are all correct. The weakest areas are not architecture but coverage: entitlements, the write path, and migration are each asserted in a paragraph where they need a section.

This review separates **defects** (the design is wrong or silently broken as written) from **scope judgements** (the design is defensible; I would choose differently) from **gaps** (absent rather than wrong). Only §2 is non-negotiable.

---

## 1. What the design gets right

Recorded so it does not get refactored away by someone who has not been burned yet.

| Decision | Where | Why it matters |
|---|---|---|
| Two channels, one socket — text is control, binary is Perspective | arch §7.1 | Eliminates the entire class of multiplexing and envelope bugs. The best decision in the set |
| Single writer per table via bounded channel | arch §5.4 | Concurrent `update()` is a race not worth debugging in production, and the bound gives free upstream backpressure |
| `GridDataService` as the deliverable, not the SSRM datasource | parity §6, arch §8.5 | Blotter code never branches on mode. The CSRM implementation unblocks all UI work with zero hub dependency |
| Subscribe before snapshot; three independent EOS guards; fail loud on count mismatch | arch §5.5, §3.4 | Correct, and correctly identified as the highest-consequence failure in the system |
| Perspective `on_update` does not surface removals — soft-delete flag plus client-side CSRM filter model | arch §8.4 | Non-obvious, and the source of "ghost rows" bugs that take days to diagnose |
| Alerts evaluate hub-side over the full dataset | arch §9.1 | In SSRM the client sees only a window; a client-side alert silently misses most of the book |
| Never `.` as flatten separator | arch §5.2 | AG-Grid resolves dotted `field` as a deep property path and fails silently |
| `\u0001` as composite key separator | parity §2.3 | `-` collides the day someone books a hyphenated trade id |
| No `new Function` in the DSL evaluator | arch §9.2 | OpenFin CSP blocks it, and it is an injection surface for LLM-authored rules |
| Diagnostics as Phase 5, explicitly before UAT | plan §5 | The largest hidden schedule item in systems like this is integration-phase debugging |
| Conformance corpus for dual-host normalization | arch §11, plan §10 | The only mechanism that makes the two-host claim survive contact with maintenance |
| Inference is offline, reviewed, never auto-applied; first-batch inference banned | arch §4.1 | An all-null first batch becoming `string`, or a whole-numbered float batch becoming `integer`, corrupts silently and forever |

---

## 2. Defects — fix before Phase 1

### 2.1 The config reconcile diverges silently

`architecture.md` §3.6 reconciles app and sidecar on `bundleVersion` alone:

```
app  > hub   → app pushes
hub  > app   → hub pushes down
equal        → nothing
```

`bundleVersion` is a client-side monotonic counter. Two OpenFin apps editing while the sidecar is down both bump `12 → 13` with different content. They meet at `equal → nothing` and stay permanently divergent under the same version number, with no signal to either user.

The bundle format already carries `checksum` (§3.7). **Reconcile on `(bundleVersion, checksum)`.** Equal version with differing checksum is a conflict: refuse the silent no-op, surface it in the admin UI, and require the user to pick a side — the existing import diff view is exactly the right surface for this.

Cost: a few lines in `control.rs` and the handshake schema. Cost of not doing it: two traders with different topic configs and no way to know.

### 2.2 Entitlements are asserted, not designed

`architecture.md` §6 covers entitlements in two sentences — a hub-side check at table-open time plus a mandatory filter clause the subscriber cannot remove. That is the right shape, but nothing else in the design supports it:

- No entitlement source in the connection profile or datasource definition (§3.1, §3.2)
- No entitlement message in the control protocol (§7.2)
- No representation in the schema artifact (§4)
- No statement of what happens when the entitlement source is unreachable — fail closed, or serve cached?

This collides directly with superset sharing. §6 has one table hold `book=*` while each subscriber gets a filtered view, which means a per-subscriber filter clause is the *only* thing separating desks inside a shared table. A bug there is a cross-desk data leak, not a rendering glitch.

**Needs its own section**, covering: the entitlement source and its caching and failure semantics; how the mandatory clause composes with user filters and is proven non-removable; whether an entitlement change mid-session forces a re-subscribe; and an exit criterion stronger than "an unentitled subscriber cannot open a table" — specifically, a test that a subscriber inside a shared superset table cannot reach rows outside their entitlement by any filter manipulation.

### 2.3 The reconnect diff has no memory budget

`architecture.md` §5.6 re-snapshots into a shadow table and diffs against the live table to emit a minimal transaction set. That is the right call for avoiding scroll jump and full repaint. But the doc describes the cost as "a little memory" — it is transiently **2× the table**, at precisely the moment the system is already under stress.

Worse, the triggering event is usually shared. An upstream server bounce drops every datasource on that connection simultaneously, so the spike is 2× across all of them at once, not one table at a time.

`lifecycle.maxRows` (§3.2, §6) is a per-table guard. There is **no process-level memory budget or admission control anywhere in the design.**

Two fixes, both cheap:

- **Serialise reconnect diffs.** One shadow table at a time per sidecar; the rest wait in `recovering`.
- **Add a process-level ceiling** alongside the per-table one, with a stated policy on breach — refuse new subscriptions, or tear down the least-recently-used idle table.

The known working-set ceiling of 10 tables per trader (§5.4) bounds the blast radius, which is reassuring for the *count*. It does not settle the *size*: at an estimated ~500 MB for a 500k × 160 table, a doubling on even two or three simultaneously is a multi-gigabyte transient. Serialising the diffs is what turns that from a spike into a queue, and it is a few lines in `registry.rs`.

### 2.4 Custom aggregations are measured but not mitigated

Phase 0 item 4 tests whether the top five FI aggregations are expressible in Perspective, and `ssrm-parity-study.md` §3 correctly flags custom `aggFunc`s as the hard ceiling — Perspective's aggregate set is fixed with no extension point. But the only stated output is "record which are impossible."

DV01-weighted spread and notional-weighted average price are not exotic; they are table stakes on a rates or credit blotter. The mitigation options have very different costs and should be pre-committed **before** the spike, not negotiated after it:

| Option | Works when | Cost |
|---|---|---|
| Compute the weighted numerator at ingest, divide client-side | The metric decomposes into a ratio of two summable columns | Cheap, and covers more than it first appears — most weighted averages are `sum(w·x) / sum(w)` |
| Hub-side post-aggregation pass over group results | Anything expressible over a group's aggregate row | Moderate. Needs a second pass in `queries.rs` and a place in the response shape |
| Accept the loss, document it | Never, for a metric a desk trades on | Free, and the reason the project loses credibility |

Option 1 dissolves most weighted-average cases outright, provided the ingest pipeline emits the product column. Decide this before Phase 0 runs, so the spike measures the right question: not "can Perspective express DV01-weighted spread" but "which of the five survive the sum-decomposition trick, and what do the survivors need."

Related: `implementation-plan.md` Phase 0 states that three-of-five failing is decisive. **It does not say what two-of-five means.** Pre-commit that threshold too, or it becomes a negotiation after two weeks of sunk cost.

### 2.5 The documented repo layout does not exist

`architecture.md` §2 describes a `datasource-hub/` tree with `spec/`, `hub-rust/`, `hub-worker/`, `provider/`, `admin-ui/`, `tools/`. The actual repository is `rangrez` — a pnpm/turbo monorepo for `@wellsfargo-starui` packages, with an empty `packages/` and a stub `apps/demo`.

This must be resolved before Phase 1, because Phase 1's deliverable is `spec/` plus codegen, and the codegen output paths are decided by it. Two viable answers:

- **Map onto the workspace**, respecting its convention that `packages/` is libraries and `apps/` is demos and test harnesses. Everything the desk's OpenFin app consumes is a package — including `dshub-admin`, whose screens the host *mounts* rather than launches, so it is a library despite being UI. `apps/` gets `dshub-blotter` (the Phase 4 demoable, later the parity-harness target) and `dshub-console` (a standalone host for the admin screens). `hub-rust/` is neither a library nor a demo, so it sits as a top-level sibling built by cargo and wired into turbo as an external task.
- **Separate repo.** `datasource-hub` stands alone, and `rangrez` consumes `@wellsfargo-starui/dshub-provider` as a published package.

The first is better while the provider and admin UI change weekly. The second is better once the provider is stable and other desks consume it. Since Phases 1–8 are one continuous change to both sides of the seam, **start with the first.**

---

## 3. Sequencing — one change with outsized effect

### 3.1 The VRM probe belongs in Phase 0

`architecture.md` §8.2 makes an observation that is load-bearing and then does nothing with it:

> Perspective's expanded tree is already a flat indexed list, which is exactly what viewport row model wants.

If that holds, VRM sidesteps most of `ssrm-parity-study.md` §5 — route computation, group-key change as remove-plus-add, `StoreNotFound` handling, sort-position drift, aggregate staleness, and the cell-selection-past-viewport bug. That is the bulk of the hardest and longest phase in the plan.

Yet VRM is Phase **8f**, half a week, sequenced *after* every piece of SSRM work it might make unnecessary. The plan spends 8e — a full week on live update routing — and part of 8g on the cell selection fix, solving problems VRM may not have.

**Add a VRM feasibility probe to Phase 0.** The Perspective spike is already stood up for items 1–3; this is roughly a day on top:

1. Build a grouped view over the 500k × 160 fixture; `expand`/`collapse` a few levels.
2. Read `to_columns({start_row, end_row})` against the expanded tree; confirm indices are stable and contiguous.
3. Wire it to a trivial AG-Grid viewport row model with a `__ROW_PATH__` tree cell renderer.
4. Drive updates into it and observe what the viewport datasource actually has to do on a row change.

VRM has real costs of its own, and the probe should surface them honestly: a custom tree cell renderer instead of AG-Grid's native grouping UI, different selection semantics, and a much thinner base of community answers when something breaks. It may lose on those grounds. But finding that out in week 2 costs a day; finding it out in week 14 costs the difference between needing 8e and 8g and not needing them.

**AG-Grid's own guidance is genuinely two-sided here**, and worth quoting rather than paraphrasing. The v36 docs warn that "many of our users use Viewport Row Model when they don't need to and end up with more complicated applications as a result" — then describe its fit as "a large amount of changing data" where you "want to push updates to the client when the server-side data changes," noting that VRM alone tells the server which rows the user is actually looking at. The warning is against reaching for VRM casually. The described fit is this system, exactly. That is not a verdict either way; it is a reason the probe is worth a day rather than a reason to skip it.

**This is the single highest-leverage change to the plan.**

---

## 4. Scope judgements

The design is defensible on each of these. I would choose differently, and the reasoning is worth recording either way.

### 4.1 The write path is a paragraph for a subsystem

`architecture.md` §8.6 covers orders, amends, cancels and annotations in one paragraph: a `command` RPC with correlation id, timeout, typed errors, optimistic apply with a pending marker, and reconciliation on echo. That is the correct *sketch*. What an order entry path also needs, and what is absent:

- **Idempotency keys.** A network retry on a `command` must not double-submit an order.
- **Timeout state resolution.** A command that times out has ambiguous state — did it execute? This needs a query-by-idempotency-key path, not just a timeout error.
- **Ordering.** Amend-then-cancel arriving out of order at the venue.
- **Reconciliation failure.** What the pending marker does when the authoritative echo never arrives.

It shares Phase 9 — two weeks — with the entire DSL parser, evaluator, Perspective compiler, capability matrix, authoring validation, alerts engine, and chatbot integration.

**Recommendation:** scope v1 to annotations, which genuinely is a one-paragraph feature, and leave orders on the existing OMS path. Split the trading write path into its own phase when a desk asks for it, and design it against the four points above.

### 4.2 The dual-host requirement is never justified

The SharedWorker host drives a large share of the design's complexity: principle 2, principle 3, the entire `spec/` layer, the conformance corpus, and the standing constraint that `normalize.rs` and its TypeScript twin produce byte-identical Arrow forever. That last one is not a Phase 10 cost — it is a tax on every future coercion, array strategy, and flatten tweak.

The mitigation is right (spec plus corpus, not a shared abstraction), and building the worker last on a proven design is right. What is missing is the **requirement**. No document states why both hosts must exist, and in OpenFin you control the desktop install — which is the usual reason a sidecar is not viable.

If the answer is "some users are browser-only and cannot install a sidecar," that is a real requirement and the plan stands as written. If it is insurance against a case that may not arise, then:

- Scope the worker as a **deliberately reduced-capability host**. AMPS and Solace are already conceded as sidecar-only (plan §10), so the precedent exists.
- Ask whether it needs **byte-identical** normalization or merely **behaviourally equivalent** output. Byte-identical Arrow is a far stronger property than "the grid shows the same thing," and it is the expensive half.

Answer this before Phase 1, because it determines how much the `spec/` layer has to carry.

### 4.3 The hybrid fallback is a re-plan, not a fallback

`architecture.md` §12 says that if the Phase 0 view-scaling or aggregation tests fail, "the hybrid is legitimate and not a compromise": Perspective wasm in the worker for small and medium datasets, CQServer in the sidecar for heavy ones, same adapter.

It is legitimate. It is also two engines behind one seam, which means the conformance problem now spans *engines* rather than hosts — and engines diverge far more than two implementations of one spec do. Aggregation semantics, null ordering, string collation and filter inclusivity would all have to match across Perspective and CQServer, and the parity harness would have to run its full matrix against both.

Treat a Phase 0 failure as triggering a **re-plan with a revised schedule**, not a branch already priced into the existing one.

### 4.4 The file-count leanness rule will get gamed

`implementation-plan.md` caps source files at 60, excluding generated types and the admin UI. Counting the design as specified — six adapters plus roughly twelve hub modules, doubled across hosts, plus fifteen provider files, plus spec and tools — lands near 55 before tests. It will cross 60, and the rule will be satisfied by writing fewer, larger files rather than by building less.

Keep it as a smell test that prompts a conversation, not a gate. The genuinely valuable checkpoint in that list is the last one:

> Adding a datasource touches zero source files.

That is objectively testable, it is the actual thesis of the spec-driven design, and it should be enforced hard.

---

## 5. Gaps — absent rather than wrong

### 5.1 Migration and coexistence

`ssrm-parity-study.md` references an existing 250-field FI catalog, existing blotters, a `useAgGridKeyboardNavigation` hook, and a custom undo/redo system. Nothing in any document describes how a live blotter moves onto the hub.

A trading desk cutover needs a dual-run period with both paths live, automated row-level diffing between old and new, a per-blotter cutover switch, and a rollback that does not require a redeploy. On desks this is frequently the most expensive phase of the project, and it is absent from the schedule entirely.

**Add a phase.** Two weeks minimum, after Phase 8.

### 5.2 Version skew and sidecar distribution

`hello` carries a protocol version (arch §7.2), but no document states the policy on mismatch — refuse, degrade, or warn. Nor is there anything about how the sidecar reaches trader machines, or how it is updated.

With config living client-side and a binary installed per machine, version skew across a desk is not a risk, it is the steady state. Needed: a stated compatibility rule (provider requires sidecar ≥ X, refuses below with a typed error the UI can act on), and an update path.

### 5.3 Soak testing

The test matrix (arch §11) has a view-leak test at 500 expand/collapse cycles. Nothing runs the system for a full trading day at market rates.

The leak that reaches production will not be the one 500 cycles finds. Add an **8-hour soak at realistic update rates with periodic subscribe/unsubscribe churn**, asserting flat memory and flat open-view count. Run it nightly from Phase 6 onward.

### 5.4 Multi-datasource resource budget

**Partially answered.** The working set is bounded: at most **2 datasources and 10 tables** per trader at any time. That is small, and it resolves the concurrency half of this gap — the sidecar is per-user, so 10 tables is the ceiling, not a starting point that grows with desk size.

What remains open is the **size distribution**, and it is the number that decides whether the sidecar is comfortable or impossible.

A 500k × 160 table on Arrow-columnar storage estimates to roughly **500 MB**, assuming a blotter mix of ~60 float, ~30 int, ~20 datetime, ~40 dictionary-encoded string and ~10 boolean columns, plus dictionaries. Phase 0 item 1 measures the real figure; this arithmetic only sets the stakes:

| Shape of the 10 tables | Resident |
|---|---|
| All ten at 500k × 160 | ~4.9 GB — not viable on a trader desktop |
| Two large, eight at 50k | ~1.4 GB — comfortable |

The two scenarios are a factor of three-and-a-half apart, and they lead to different products. So the question is no longer "how many tables" but **how many of the ten are large.** If the honest answer is more than three, the process-level ceiling in §2.3 stops being a safety net and becomes a scheduling constraint — the sidecar must be able to refuse or evict, and the blotters must tolerate it.

**This also lands on the dual-host question (§4.2).** *Updated by Phase 0 measurement — see `phase-0-findings.md` §1a.* The estimate below assumed a ~2 GB practical ceiling; measured in Chrome 152 it is **4.29 GB accepted, ~3.76 GB committable**, and Perspective 5.x's Memory64 build buys **no additional headroom in the browser** despite its probe passing. So the worker has roughly double the assumed room — but it is still a hard ceiling shared with the engine, the grid and the page, so the §6.2 budget and admission control remain required rather than optional.

Phase 0 should measure **ten concurrent tables at the real size mix**, not one synthetic 500k table.

---

## 6. Schedule

`implementation-plan.md` is honest about its own optimism — it revises 14 weeks up to 17–18 for two engineers and names Phases 2 and 8 as the ones that will slip. That self-correction is credible. What it excludes:

| Excluded | Estimate |
|---|---|
| Phase 0 fallout — the hybrid decision, or a re-plan | 0–4 weeks |
| Migration and coexistence (§5.1) | 2 weeks |
| Integration and UAT with a real desk | 2–3 weeks |
| Human review of ~40 inferred artifacts × ~250 fields | 1–2 weeks of someone's time, not necessarily an engineer's |
| Buffer | — |

**Plan for 25–30 weeks with two engineers.** The 17–18 figure is a defensible *build* estimate for the code named in the phases. It is not a *delivery* estimate for a working desk.

The LOC cross-check in the plan (~200/day against ~27k lines) is a reasonable sanity mechanism, and its own caveat is the right one: 80–120/day including tests is realistic for `table_actor.rs` and `modes/ssrm.ts`. Those two files carry most of the risk.

---

## 7. Proposed edits

Concrete changes, ready to apply against the source documents.

| # | Document | Section | Change | Class |
|---|---|---|---|---|
| 1 ✅ | architecture.md | §3.6 | Reconcile on `(bundleVersion, checksum)`; equal version with differing checksum is a surfaced conflict, not a no-op | Defect |
| 2 ✅ | architecture.md | new §6.1 | Entitlement source, caching, failure policy, composition with user filters, mid-session change behaviour | Defect |
| 3 ✅ | architecture.md | §5.6 | Serialise reconnect diffs, one shadow table at a time; state the 2× transient cost | Defect |
| 4 ✅ | architecture.md | §3.2 / §6 | Process-level memory ceiling alongside `lifecycle.maxRows`, with a stated breach policy | Defect |
| 5 ✅ | implementation-plan.md | Phase 0 | Add the sum-decomposition test to item 4; pre-commit the two-of-five threshold | Defect |
| 6 ✅ | implementation-plan.md | Phase 0 | Add the VRM feasibility probe as item 7 | Sequencing |
| 7 ✅ | implementation-plan.md | Phase 0 | Extend item 1 to **10 concurrent tables at the real size mix**, not one synthetic 500k table; record resident memory per table and in total | Gap |
| 7b ✅ | implementation-plan.md | Phase 0 | Add a wasm32 headroom measurement to the worker path: how many large tables fit before the address space is exhausted | Gap |
| 8 ✅ | architecture.md | §2 | Re-map the tree onto the rangrez workspace, honouring `packages/`=libraries and `apps/`=demos; admin screens are a package, blotter and console are demos | Defect |
| 9 | architecture.md | §8.6 | Scope v1 to annotations; add idempotency, timeout-state resolution, ordering and reconciliation failure to the trading path when it is scheduled | Scope |
| 10 | implementation-plan.md | Phase 9 | Remove the write path; it is not a line item in a two-week DSL phase | Scope |
| 11 | implementation-plan.md | new Phase 8.5 | Migration and coexistence — dual-run, row diffing, per-blotter cutover, rollback | Gap |
| 12 | architecture.md | §7.2 | Protocol version mismatch policy | Gap |
| 13 | architecture.md | §11 | 8-hour soak test, nightly from Phase 6 | Gap |
| 14 | implementation-plan.md | Schedule | Revise to 25–30 weeks for two engineers, with the exclusions named | Scope |
| 15 | architecture.md | §12 | Reframe the hybrid as triggering a re-plan | Scope |
| 16 | implementation-plan.md | Leanness | File count as a smell test; "adding a datasource touches zero source files" as the enforced gate | Scope |

**Status:** items 1–8 (and 7b) are **applied** to `architecture.md` and `implementation-plan.md`. Items 9–16 are scope judgements left for the author to accept or reject — none has been applied.

Item 8 is the one applied edit that encodes a decision not yet made: the tree in `architecture.md` §2 is remapped onto the rangrez workspace per the recommendation above, which also moved paths in Phases 1, 4, 5 and 7. Flip it to a separate repo and those revert together.

---

## 8. Open questions for the author

These cannot be resolved from the documents, and each changes the plan materially. **Four are now answered** — 1, 2, 5 and 7 — and the host answer re-sequenced the whole plan. Live ViewServer/STOMP access was also confirmed, so Phase 3's inference pass can run against real messages rather than synthetic ones.

1. ~~**Why two hosts?**~~ **Answered, and it re-planned the project: the SharedWorker ships first, the sidecar is Phase 10.** Recorded in architecture §2.2. Phases 0–9 become TypeScript-only, wasm32 headroom becomes a front-line constraint rather than a footnote, AMPS and Solace are unavailable in v1, and §3.6 cross-app config sync and §7.3 localhost security both defer to Phase 10.
2. ~~**Where do entitlements come from?**~~ **Answered: deferred — v1 is single-desk.** Admission is a no-op and the mandatory clause is empty. Architecture §6.1 stays written and unimplemented; the control protocol carries no entitlement surface in v1. Revisit when a second desk arrives, and note §6.1's exit criterion is the thing to run *then*, not a v1 gate.
3. **What are the actual five aggregations?** Which of them decompose into `sum(w·x) / sum(w)`? (§2.4 — determines what Phase 0 should measure.)
4. **Does v1 need order entry, or only annotations?** (§4.1 — a phase's worth of difference.)
5. ~~**How many datasources, and how large?**~~ **Answered: 2 datasources, 10 tables, 1–2 of them large.** That estimates to ~1.4 GB against a ~2 GB practical wasm32 ceiling — it fits, with roughly 30% headroom. Thin enough that §6.2's process ceiling must be real, and thin enough that Phase 0 item 1 measures headroom before anything else is built. Refused-subscription UI is not needed at this ratio.
6. **What is the migration path for the existing blotters?** Dual-run, or big-bang per blotter? (§5.1.)
7. **Rangrez workspace, or separate repo?** (§2.5 — blocks Phase 1.)
