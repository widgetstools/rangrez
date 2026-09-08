# dshub-react-perspective

A Vite + React 19 + TypeScript blotter driven by the **in-browser Perspective
SharedWorker hub** (not the Rust sidecar), in **SSRM** mode — with runtime row
grouping, aggregation, and pivot.

```
<AgGridReact>  ⟶  SsrmMode + HubDataService  ⟶  MessagePort  ⟶  SharedWorker { Hub + Perspective wasm }
   the grid          the AG-Grid adapter          transport          one cache, all tabs, upstream STOMP
```

The whole React integration is one hook — [`src/useSsrm.ts`](src/useSsrm.ts):
connect to the SharedWorker, `hello` → `subscribe`, wait for `live`, build a
`HubDataService` + `SsrmMode`. The component ([`src/App.tsx`](src/App.tsx)) feeds
those to `<AgGridReact>` and re-arms `watchGroups` on grouping/pivot changes.

## How the worker is served (the one non-obvious part)

The SharedWorker script must be **same-origin** with the app, and it imports flat
`/packages/*`, `/node_modules/@perspective-dev/*`, and `/apps/dshub-spike/*` paths
plus the Perspective wasm. Rather than bundle Perspective through Vite's worker
pipeline, [`vite.config.ts`](vite.config.ts) adds a tiny dev middleware that serves
those exact paths **raw** from the repo root — so the SharedWorker runs
byte-identical to the proven spike worker, while the React app itself is a normal
bundled Vite app.

**No COOP/COEP headers.** The `perspective.inline.js` build is single-threaded and
uses no `SharedArrayBuffer`, so cross-origin isolation is not required. (The
spike's `serve.mjs` sets those headers, but they are unnecessary.)

## Prerequisites

- **STOMP view server** on `ws://localhost:8081` — the worker connects to it
  directly (from the browser) and snapshots the 20k-row `positions` feed.

The hub (Perspective) runs inside the browser SharedWorker; there is no separate
hub process to start.

## Run

```sh
npm install                                              # from the monorepo root
npm run dev -w @wellsfargo-starui/dshub-react-perspective # → http://localhost:5174
```

Open the URL. Drag columns into **Row Groups** / **Pivot**, change agg functions —
the grid re-queries the hub automatically, and group totals tick live.

- `npm run typecheck -w @wellsfargo-starui/dshub-react-perspective`
- `npm run build -w @wellsfargo-starui/dshub-react-perspective`

## What's wired for SSRM + runtime grouping/pivot

- `rowModelType: 'serverSide'`, `serverSideDatasource: ssrm.datasource()`,
  `getRowId: ssrm.getRowId`.
- `rowGroupPanelShow` / `pivotPanelShow` for interactive grouping and pivot; columns
  carry `enableRowGroup` / `aggFunc` / `enablePivot`.
- `serverSidePivotResultFieldSeparator: '|'` — Perspective names split columns
  `AUD|marketValue`, so AG-Grid needs the `|` separator to build pivot columns.
- On `columnRowGroupChanged` / `columnValueChanged` / `columnPivotChanged`, the app
  re-arms `ssrm.watchGroups(groupBy, aggregates)` (aggregates derived from the
  grid's current value columns) so live group-aggregate deltas track the current
  grouping.

### Grand total row

AG-Grid's native `grandTotalRow` does **not** populate under SSRM here — SSRM
aggregates on the server, so the grid's client-side grand-total path never fires
(confirmed with `grandTotalRow` + `getGroupRowAgg` + `alwaysAggregateAtRootLevel`).
Instead, `useGrandTotal` ([`src/App.tsx`](src/App.tsx)) reads the **root** of a
grouped Perspective view — its `__ROW_PATH__: []` row is the true total over *all*
rows — and shows it as a pinned bottom row. It is the correct server total (not a
sum of loaded blocks), it **respects the active filter**, and it re-reads on the
~1 s tick so it stays live.

Full walkthrough of the browser Perspective hub + SSRM: [../dshub-spike/README.md](../dshub-spike/README.md).

## Verified

Against the running STOMP feed + browser Perspective hub:

- Perspective wasm boots in the SharedWorker with **no COOP/COEP**; SSRM grid goes
  live (8 desks, ~20k rows), group aggregates tick every ~1 s.
- **Runtime grouping** — adding `trader` and expanding a desk fetches nested
  subgroups with correct per-trader aggregates.
- **Runtime pivot** — pivoting by `currency` produces 21 secondary columns
  (`AUD|marketValue` … `USD|dv01`) with correct per-currency values.
- **Grand total row** — pinned "Grand Total" (~500 B market value over 20k rows);
  follows filters (USD filter → ~71.6 B, restores on clear).
- **Real-time ticking** — ~**6–7 Hz** visible group-cell updates (past the 200 ms
  target). See below.

## Real-time note

The upstream (stern-bak) runs at `LIVE_TICK_MS=40` (25/s) and the worker's actor
flushes to the table every 50 ms — but the browser hub originally propagated only
~1/s. The cause was **not** the Perspective wasm engine (its own datagrid streams
thousands/s): the worker's `watchTable` rebuilt a whole Perspective table from the
delta on *every* update, even for notify-only SSRM subscribers that just need a
"changed" signal — saturating the single wasm thread into a ~1 Hz feedback loop.

The fix (in [`packages/dshub-worker/src/hub.mjs`](../../packages/dshub-worker/src/hub.mjs)
+ the worker's `watchTable` in [`../dshub-spike/web/dshub.worker.mjs`](../dshub-spike/web/dshub.worker.mjs)):
skip the per-delta decode when no row-delivery subscriber is attached and fan out
a lightweight signal instead. Measured result: ~1 Hz → **~7 Hz** hub pushes and
~6.4 Hz visible ticks, at `refreshMs: 200`. All 268 dshub-worker tests still pass.
