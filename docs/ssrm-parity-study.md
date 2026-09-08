# SSRM Parity Study — DataProvider over Perspective

**Goal:** a trader switching a blotter from CSRM to SSRM should notice a difference in *memory and load time*, and in nothing else.

This document catalogues the AG-Grid SSRM interface surface, the parity gaps against CSRM, and the helper API layer the DataProvider must expose to close them.

> **Version sensitivity.** SSRM APIs have churned across AG-Grid v29→v34 (store types collapsed into `suppressServerSideInfiniteScroll`, Range Selection renamed to Cell Selection, `storeInfo` → `groupLevelInfo`). Treat this document as a map of *concerns*, not a copy-paste API reference.
>
> **Pinned version is 36.0.0** (`architecture.md` §2.1) — two majors past the window this study was written against. A partial re-verification has been done:
>
> **Confirmed unchanged in v36.** `IServerSideDatasource` is still `{ getRows(params), destroy?() }`. `IServerSideGetRowsRequest` still carries exactly `startRow`, `endRow`, `rowGroupCols`, `valueCols`, `pivotCols`, `pivotMode`, `groupKeys`, `filterModel`, `sortModel`. §2.1's translation table therefore stands as written.
>
> **Known drift, fix before implementing §2.4.** `applyServerSideRowData` now takes `{ successParams, route?, startRow? }`, not the `{route, rowData, rowCount}` shown below. And `IServerSideGetRowsParams` gained **`needsGrandTotal`**, which bears directly on the "group footers / grand total" row in §3 — the grid now tells you when a grand total is required rather than leaving you to infer it.
>
> **Not yet verified.** Everything in §2.2 (grid options), §2.4 (the remaining transaction and refresh APIs), §2.5 (selection state), and the v35/v36 release notes generally. Do that pass in Phase 1 alongside codegen, while the cost of being wrong is a doc edit rather than a rewrite.

---

## 1. Set filter values — the trigger for this study

### 1.1 The mechanism

In CSRM the set filter derives its value list by scanning the row data. In SSRM there is no row data to scan, so values must be supplied asynchronously:

```ts
const colDef: ColDef = {
  field: 'counterparty',
  filter: 'agSetColumnFilter',
  filterParams: {
    values: (params: SetFilterValuesFuncParams) => {
      dataService
        .getDistinctValues('counterparty', currentContext())
        .then(vals => params.success(vals))
        .catch(() => params.success([]));
    },
    refreshValuesOnOpen: true,
    suppressSorting: false,
  } as ISetFilterParams,
};
```

The callback fires when the filter is first opened, and again on `refreshValuesOnOpen`. `filterInstance.refreshFilterValues()` forces a re-fetch.

### 1.2 Serving distinct values from Perspective

Two viable paths:

**Grouped view (preferred).** Create a transient view with `group_by: [colId]`, `set_depth(1)`, read `__ROW_PATH__` from the window. The engine already maintains group keys, so this is close to free.

**Expression + aggregate.** Only if you need counts alongside values (`"Broker A (1,204)"`), which traders often like on a busy column.

Either way: **dispose the view immediately.** A distinct-values view left open per column per grid is exactly the leak that will show up as sidecar memory growth two weeks into UAT.

### 1.3 Caching and invalidation

| Concern | Approach |
|---|---|
| Repeat opens | Cache per `(datasourceId, colId, contextHash)`, TTL ~30s |
| New value arrives via update | Watch inserts for unseen values on set-filter columns; mark cache dirty, don't re-query eagerly |
| Value disappears | Let TTL handle it — showing a stale value that matches nothing is harmless |
| Cache stampede | Single-flight per key; concurrent opens share one in-flight promise |

Track which columns are *set-filter columns* in the schema artifact so the update path only pays the "unseen value" check on the handful that need it, not all 160.

### 1.4 Cardinality guard

AG-Grid's set filter has no server-side paging of its value list — the whole list ships to the browser and renders into a virtualized list. Beyond roughly 10k distinct values the UX degrades badly regardless of virtualization.

Encode a threshold in the schema artifact from the inference pass (you already capture observed cardinality):

- **< 500** — set filter, values eagerly cached at subscription time
- **500 – 10k** — set filter, lazy fetch on open, mini filter enabled
- **> 10k** — do not use set filter. Fall back to a **custom search-select filter**: a text input that queries the engine for values matching a prefix, debounced, returning the top N. This is a custom filter component, and it is worth building once because CUSIP, ISIN and account columns will all need it.

### 1.5 Cascading values — the subtle CSRM behaviour

In CSRM, set filter values narrow as other filters are applied (filter on `book=CMBS`, and the `trader` filter now only offers CMBS traders). SSRM does not do this by default; you get all values always.

To mimic it:

1. On `filterChanged`, invalidate the distinct-value cache for every *other* set-filter column.
2. Pass the current filter model (minus the column's own filter) as `contextFilters` into `getDistinctValues`.
3. Apply those as a Perspective `filter` on the grouped view.

This is a real cost — every filter change invalidates N caches — so make it a **per-column opt-in flag** in the schema artifact (`cascadingValues: true`). Turn it on for the two or three columns where traders expect it, off elsewhere.

There is a correctness wrinkle worth documenting for users: with cascading on, a value can vanish from the list while still being *selected*, because CSRM and SSRM disagree about whether selected-but-now-invisible values stay checked. Decide the behaviour and hold it consistently.

---

## 2. The full SSRM interface surface

### 2.1 Datasource contract

```ts
interface IServerSideDatasource {
  getRows(params: IServerSideGetRowsParams): void;
  destroy?(): void;
}

interface IServerSideGetRowsRequest {
  startRow?: number;
  endRow?: number;
  rowGroupCols: ColumnVO[];
  valueCols: ColumnVO[];
  pivotCols: ColumnVO[];
  pivotMode: boolean;
  groupKeys: string[];        // path to the parent node being expanded
  filterModel: FilterModel | AdvancedFilterModel | null;
  sortModel: SortModelItem[];
}
```

`params.success({ rowData, rowCount, groupLevelInfo })` / `params.fail()`.

The translation each field needs:

| Request field | Engine translation | Notes |
|---|---|---|
| `groupKeys` | Equality filters, one per level | Parent path; empty array = top level |
| `rowGroupCols` | `group_by: [rowGroupCols[groupKeys.length].id]` | **Only the next level**, not the whole list |
| `valueCols` | `aggregates` map | Custom aggFuncs are the known Perspective limit |
| `sortModel` | `sort` | Null ordering and collation must match CSRM |
| `filterModel` | `filter` / expression | See §4 |
| `startRow` / `endRow` | `to_columns({start_row, end_row})` | Direct |
| `pivotCols` | `split_by` | Plus `pivotResultFields` in the response |

`set_depth(1)` on the view so you get exactly one level of children back.

### 2.2 Grid options that materially change behaviour

| Option | Why it matters |
|---|---|
| `cacheBlockSize` | Block size per level; too small = request storm, too large = latency spikes |
| `getServerSideGroupLevelParams` | Per-level block size and cache limits — leaf levels usually want larger blocks than group levels |
| `maxBlocksInCache` | Bounds browser memory; **unset it and you have CSRM with extra steps** |
| `blockLoadDebounceMillis` | Critical for fast scrolling; without it you fire a request per scroll frame |
| `suppressServerSideInfiniteScroll` | Full-store vs infinite mode; full store enables client-side sort/filter at a level but needs a bounded row count |
| `serverSideInitialRowCount` | Initial scrollbar sizing before the first block returns |
| `serverSideSortAllLevels` | Whether a sort change purges group levels too |
| `serverSideOnlyRefreshFilteredGroups` | Limits refresh blast radius on filter change |
| `getChildCount` | Group row counts without expanding |
| `isServerSideGroup` / `getServerSideGroupKey` | Tree data mode |
| `getRowId` | **Non-negotiable** — see §2.3 |

### 2.3 Row identity

`getRowId` must be stable across block reloads, and must be distinct for group rows and leaf rows:

```ts
getRowId: (params) => {
  if (params.level >= 0 && params.parentKeys) {
    // group row: level + full path
    return `g:${params.level}:${params.parentKeys.join('\u0001')}:${params.data[groupColId]}`;
  }
  return `r:${keyColumns.map(c => params.data[c]).join('\u0001')}`;
}
```

Use a separator that cannot appear in data (`\u0001`), not `|` or `-`. Composite keys with a `-` separator will collide the day someone books a trade with a hyphen in the ID.

The leaf-row form must be **byte-identical** to the key encoding the hub uses, or transactions will not route.

### 2.4 Transaction and refresh APIs

| API | Use |
|---|---|
| `applyServerSideTransaction({route, add, update, remove, addIndex})` | Synchronous, returns a result telling you what actually applied |
| `applyServerSideTransactionAsync(tx, cb)` | Batched; **this is the SSRM analogue of `applyTransactionAsync`** |
| `applyServerSideRowData({route, rowData, rowCount})` | Replace an entire group level's data wholesale |
| `refreshServerSide({route, purge})` | Force a reload of a route; `purge: true` discards and shows loading |
| `getServerSideGroupLevelState()` | Introspect what's loaded — useful for diagnostics |
| `retryServerSideLoads()` | Recovery after upstream failure |

The transaction result codes (`Applied`, `StoreNotFound`, `StoreLoading`, `Cancelled`) must be handled. `StoreNotFound` means the route isn't loaded — that is a **normal, expected outcome**, not an error, and it means "drop this update, the user will get it when they expand that node."

### 2.5 Selection

`getServerSideSelectionState()` / `setServerSideSelectionState({ selectAll, toggledNodes })` gives you select-all-across-unloaded-rows. The state is a *predicate plus exceptions*, not a row list, which is exactly right — but it means any action on the selection ("cancel selected orders") must send the predicate to the server, not a list of IDs. Design the action API around that from the start.

---

## 3. Parity gap matrix

Legend: **Free** = works identically; **Server** = works but the engine must implement it; **Build** = needs a helper API and custom UI; **Lost** = accept the difference and document it.

### Data operations

| CSRM feature | SSRM status | What to build |
|---|---|---|
| Sorting | Server | Engine sort. Must match CSRM's null ordering and string collation exactly, or users see reordering when switching modes |
| Custom `comparator` | **Lost** | Client comparators are never called in SSRM. Replace with a sort key column computed at ingest (e.g. rating ordinal for `AAA` > `AA+`) |
| Column filters | Server | Filter model translation (§4) |
| Advanced Filter | Server | Tree-structured `advancedFilterModel`; recursive translation |
| Quick filter | **Lost** | Not supported at all. Build a search-all-columns helper: engine-side OR of `contains` across a configured subset of columns. Do **not** search all 160 |
| Find (v33+) | **Lost** | Client-side only. Route to the same search helper |
| External filter (`isExternalFilterPresent`) | **Lost** | Fold into the filter model instead |
| Row grouping | Free | Grouping itself works |
| Aggregation | Server | Built-in aggFuncs map cleanly; **custom aggFuncs do not** — this is the Perspective ceiling flagged earlier |
| Group footers / grand total | Server | Must be computed server-side and injected; not derived from loaded rows |
| Pivot | Server | Supported, but requires `pivotResultFields` in the response and dynamic column generation. Highest-effort item on this list |
| Tree data | Free | Via `isServerSideGroup` / `getServerSideGroupKey` |
| Master–detail | Free | Detail datasource is independent |

### Interaction

| CSRM feature | SSRM status | What to build |
|---|---|---|
| Cell selection (ex-Range Selection) | **Degraded** | *Known issue: drag past the viewport edge into unloaded rows loses the range.* Mitigations in §5 |
| Fill handle | Degraded | Same root cause |
| Clipboard copy (selected) | Free | Loaded rows only, which matches what's selected |
| Clipboard copy (all / Ctrl+A) | **Build** | Ctrl+A selects loaded rows only. Needs an `exportAll` path through the hub |
| CSV / Excel export | **Build** | Client export sees loaded rows only. Server-side export streaming the full filtered+sorted result |
| Cell editing | Free | Works, but edits must reconcile against the update stream |
| Undo/redo | Degraded | Your custom system needs stable row identity across block eviction; an undone row may no longer be loaded |
| Keyboard nav | Free | Your `useAgGridKeyboardNavigation` hook should port unchanged |
| `ensureIndexVisible` / scroll-to-row | **Build** | Requires a server-side rank lookup: "what is the index of key K under this sort and filter?" |
| Row dragging | Lost | Accept |
| Integrated charts | Degraded | Charts only see loaded rows. Route to a snapshot helper for full-dataset charts |

### API and introspection

| CSRM API | SSRM status | Replacement |
|---|---|---|
| `forEachNode` | Loaded rows only | `dataService.scanAll(filterModel, cb)` streaming from the hub |
| `getDisplayedRowCount` | Displayed only | `rowCount` from `success()`; status bar reads server total |
| `getModel().getRowCount()` | Misleading | Same |
| `autoSizeAllColumns` | Rendered only | Size from schema artifact metadata (max observed string length) instead |
| `getDataAsCsv` | Loaded only | Server export |
| Status bar aggregations | Loaded only | Server-computed aggregate helper |

---

## 4. Filter model translation

A single translator, AST-based, shared by all backends (per the DSL decision):

| AG-Grid filter | Model shape | Engine translation |
|---|---|---|
| `agTextColumnFilter` | `{filterType:'text', type:'contains', filter:'abc'}` | `contains` / `starts_with` / `=` etc. Case sensitivity must match CSRM's default (insensitive) |
| `agNumberColumnFilter` | `{type:'inRange', filter, filterTo}` | Comparison ops; `inRange` inclusivity must match |
| `agDateColumnFilter` | `{dateFrom, dateTo}` | Timezone handling is the trap — CSRM compares in local time |
| `agSetColumnFilter` | `{filterType:'set', values:[...]}` | `IN` list. Empty array = match nothing, **not** match all |
| `agMultiColumnFilter` | Nested conditions | Recursive |
| Combined | `{operator:'AND', conditions:[...]}` | Recursive |
| Blank handling | `type:'blank'/'notBlank'` | Must distinguish null from empty string, consistently with ingest |

Two rules that prevent slow divergence bugs:

1. **Golden-file test the translator.** A corpus of filter models with expected engine output, run in CI.
2. **Parity-test the results.** Same dataset in CSRM and SSRM, apply the same filter model, assert identical row keys. This catches the semantic mismatches (blank handling, case sensitivity, range inclusivity) that unit tests on the translator alone will not.

---

## 5. Live updates into SSRM

The hardest part, and the main source of "SSRM feels different."

### 5.1 Route computation

For each changed row, compute its route under the *current* grouping:

```
route = rowGroupCols
  .slice(0, expandedDepth)
  .map(col => row[col.id])
```

Then `applyServerSideTransactionAsync({ route, update: [row] })`.

### 5.2 The cases

| Event | Handling |
|---|---|
| Update, no group-key change | Transaction on the row's route |
| Update changing a group key | `remove` from old route + `add` to new route, as two transactions |
| Update changing a sort key | Row is now in the wrong position. Options: leave it (position drift), or `refreshServerSide` that route (flicker). See 5.3 |
| Insert | `add` to route; row count at every ancestor level changes |
| Delete | `remove`; same ancestor problem |
| Route not loaded | `StoreNotFound` — drop silently, this is correct |
| Aggregate change | Ancestor group rows are now stale; AG-Grid does not recompute them for you |

### 5.3 Sort position drift

This is the index-vs-key delta problem. Perspective tells you *what changed*, not *where it moved to*. Three strategies, pick per column:

- **Sort-stable columns** (IDs, static ref data) — no action needed.
- **Volatile non-sort columns** (price, PV) — in-place update, position unchanged, correct.
- **Volatile sort columns** — mark the column in the schema artifact. When a sorted-on column changes, either accept drift until the next natural refresh, or debounce a `refreshServerSide({route})`. Aggressive refresh on a price column sorted descending will make the grid unusable; make this a configurable policy, defaulting to drift.

### 5.4 Aggregate staleness

When a leaf changes, every ancestor group row's aggregate is stale. Real options:

1. Refresh ancestor routes on a slow timer (500ms–2s). Simple, visibly laggy on the group rows.
2. Have the hub emit **group-level deltas** alongside leaf deltas by maintaining a parallel grouped view and forwarding its `on_update`. More engine work, much better UX.

Option 2 is the right answer for a live blotter and is a strong argument for the hub being view-aware rather than a pure cache.

### 5.5 Cell selection loss past the viewport

Your known issue. Mitigations, roughly in order of effort:

- Raise `cacheBlockSize` and `maxBlocksInCache` so the drag stays in loaded territory.
- `blockLoadDebounceMillis` tuned so a fast drag doesn't thrash.
- Prefetch the adjacent block on drag start toward an edge.
- Track the drag range yourself in a hook (anchor key + focus key), reconcile against the grid's range on `cellSelectionChanged`, and restore it after blocks load.

The last is what actually fixes it, and it belongs in the shared provider, not in each blotter.

---

## 6. The helper API — the parity layer

Everything above collapses into one facade that both modes implement. App code and grid config should never branch on mode.

```ts
interface GridDataService {
  readonly mode: 'csrm' | 'ssrm' | 'vrm';

  // Set filter support
  getDistinctValues(colId: string, ctx?: FilterModel): Promise<unknown[]>;
  searchValues(colId: string, prefix: string, limit: number): Promise<unknown[]>;

  // Counts and aggregates for status bar / footers
  getRowCount(filter?: FilterModel): Promise<number>;
  getAggregates(specs: AggSpec[], filter?: FilterModel): Promise<Record<string, number>>;

  // Quick-filter replacement
  search(text: string, cols?: string[]): FilterModel;

  // Whole-dataset operations
  exportAll(fmt: 'csv' | 'xlsx', view: ViewSpec): Promise<Blob>;
  copyAll(view: ViewSpec): Promise<string>;
  scanAll(view: ViewSpec, cb: (rows: unknown[]) => void): Promise<void>;
  snapshotForChart(view: ViewSpec, limit: number): Promise<unknown[]>;

  // Navigation
  rankOf(key: string, view: ViewSpec): Promise<number | null>;

  // Selection as predicate
  resolveSelection(state: ServerSideSelectionState, view: ViewSpec): Promise<SelectionRef>;
}
```

The CSRM implementation answers all of these locally from row data — trivial. The SSRM implementation goes to the hub. Blotter code, toolbars, status bars and your config chatbot all call the same interface.

**This facade is the actual deliverable of the parity work.** The AG-Grid datasource implementation is the easy half.

---

## 7. Mode selection

Don't make traders choose. Pick automatically per datasource from the schema artifact:

| Rows | Mode | Rationale |
|---|---|---|
| < 50k | CSRM | Everything works, no parity layer engaged |
| 50k – 200k | CSRM if simple grouping, SSRM otherwise | Judgement call, configurable per blotter |
| > 200k | SSRM or VRM | Browser memory forces it |
| > 200k **and** heavily grouped | VRM | Push-shaped; avoids most of §5 |

Expose the chosen mode in diagnostics so support can answer "why does this blotter behave differently."

---

## 8. Test plan

**Parity harness.** Load the same fixture dataset in CSRM and SSRM with identical column and filter configuration. For a matrix of operations — sort combinations, filter models, group expansions, aggregation specs — assert that the rendered row keys and aggregate values are identical. This is the only way to catch the accumulated small divergences.

**Update-routing property test.** Generate a random sequence of inserts, updates (including group-key and sort-key changes) and deletes. Apply to both a naive in-memory model and the SSRM path. Assert convergence after quiescence. Same technique as the CQServer convergence oracle.

**View leak test.** Expand and collapse 500 group nodes, open and close 50 set filters, assert the hub's open-view count returns to baseline.

**Cell selection regression.** Scripted drag past the viewport edge at several scroll speeds, assert the range survives.

---

## 9. Sequencing

1. `GridDataService` interface + CSRM implementation. Unblocks all UI work with zero hub dependency.
2. Distinct values + cardinality guard. The immediate ask, and it exercises the transient-view lifecycle.
3. Filter model translator + golden-file tests.
4. Basic SSRM datasource: flat, sorted, filtered, no grouping.
5. Grouping and aggregation.
6. Live update routing (§5.1–5.2).
7. Export / copy-all / scan.
8. Group-level deltas (§5.4 option 2).
9. Cell selection fix.
10. Pivot. Last, and only if a desk actually asks.

Items 1–4 give a usable SSRM blotter. Items 5–8 are what make it feel like CSRM.
