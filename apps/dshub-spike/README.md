# Using the Perspective SharedWorker hub in the browser

The DataSource Hub, running entirely in the browser: the **real Perspective wasm
engine inside a SharedWorker**, shared across every tab. This is the in-browser
counterpart to the sidecar — same control protocol, different transport.

```
 <AgGridReact>  ⟶  SsrmMode + HubDataService  ⟶  MessagePort  ⟶  SharedWorker { Hub + Perspective wasm }
    the grid          the AG-Grid adapter          the transport        one cache, all tabs
```

Reference implementation: [web/dshub.worker.mjs](web/dshub.worker.mjs) (the worker)
and [../dshub-blotter/ssrm.html](../dshub-blotter/ssrm.html) (a full SSRM client).

---

## What's different in the browser

Same `openView` / `readWindow` / `watchGroups` / `distinctValues` protocol as any
hub, but three things change:

1. **The transport is a `MessagePort`, not a WebSocket.** A `SharedWorker.port`
   is already "port-like" (`postMessage`/`onmessage`/`close`/`start`), so it plugs
   straight into the provider's `Transport`. Control messages are JSON; Perspective's
   Arrow buffers ride a separate binary channel ([../../packages/dshub-worker/src/port.mjs](../../packages/dshub-worker/src/port.mjs)).
2. **Config is pre-seeded — there is no `bootstrap`.** The worker loads datasources
   from IndexedDB (seeded from a config bundle), so you **subscribe** to one that
   already exists. Runtime changes go through `pushConfig`.
3. **Perspective does the querying.** Your `getRows` sends a *view spec*; the engine
   filters / sorts / groups / aggregates and returns a window.

---

## Step 1 — Connect

A `SharedWorker` port drops into `Transport` directly. The worker sends an
unsolicited `{ payload: { ready: true } }` once Perspective boots — wait for it
before `hello`:

```js
import { Transport } from '/packages/dshub-provider/src/transport.mjs';
import { ControlClient } from '/packages/dshub-provider/src/control.mjs';

const worker = new SharedWorker('/apps/dshub-spike/web/dshub.worker.mjs', { type: 'module', name: 'dshub' });

const control = new ControlClient({ send: (m) => transport.send(m), timeoutMs: 60_000 });

let onReady; const ready = new Promise((r) => (onReady = r));
const transport = new Transport({
  connect: () => worker.port,                       // MessagePort is port-like
  onControl: (m) => { if (m.type === 'result' && m.payload?.ready) return onReady(); control.handle(m); },
});
transport.open();                                    // starts the port

await ready;                                         // Perspective engine up in the worker
await control.hello({ appId: 'blotter' });           // → configAck  (NO bootstrap)

const ref = { datasourceId: 'positions', params: { clientId: 'trd1', rate: 2000, batchSize: 10 } };
await control.subscribe(ref, { delivery: 'notify' }); // SSRM re-fetches its own blocks; it only needs the signal
```

`delivery: 'notify'` matters for SSRM: the grid owns its blocks and re-fetches
them, so shipping delta *rows* would just decode and discard them — `notify` sends
only the "something changed" signal.

---

## Step 2 — Wire AG-Grid for SSRM

The hub-facing data layer is `HubDataService` (open/read/dispose views, distinct
values, and the columnar→row transpose); the AG-Grid adapter is `SsrmMode`.

```js
import { buildColDefs } from '/packages/dshub-provider/src/coldefs.mjs';
import { HubDataService } from '/packages/dshub-provider/src/hubDataService.mjs';
import { SsrmMode } from '/packages/dshub-provider/src/modes/ssrm.mjs';
import { ModuleRegistry } from 'ag-grid-community';
import { AllEnterpriseModule } from 'ag-grid-enterprise';

ModuleRegistry.registerModules([AllEnterpriseModule]);          // SSRM is Enterprise

const artifact = await (await fetch('/packages/dshub-spec/corpus/positions/artifact.json')).json();
const dataService = new HubDataService({ control, ref, artifact, mode: 'ssrm', keyColumns: ['positionId'] });
const ssrm = new SsrmMode({ dataService, artifact, keyColumns: ['positionId'], maxViews: 12 });

const gridApi = createGrid(el, {
  columnDefs: buildColDefs(artifact, dataService),
  rowModelType: 'serverSide',                        // (1) server-side row model
  getRowId: (p) => ssrm.getRowId(p),                 // (2) distinct group vs leaf identity
  cacheBlockSize: 200,
  maxBlocksInCache: 10,                              // bounds browser memory — without it SSRM is CSRM with extra steps
  blockLoadDebounceMillis: 80,
});

// (3) only after the table is live — SSRM starts fetching immediately, and
// fetching before the snapshot exists reads an empty table.
gridApi.setGridOption('serverSideDatasource', ssrm.datasource());
ssrm.attach(control, gridApi, { refreshMs: 1000, ref }); // (4) live: rowDelta/groupDelta → refreshServerSide
```

The AG-Grid deltas from a normal grid, in one list: **(1)** `rowModelType:'serverSide'`,
**(2)** `getRowId`, **(3)** a `serverSideDatasource`, **(4)** a live-refresh subscription.
Everything else is `SsrmMode` internals.

### What `getRows` does, and the Perspective gotchas

```
getRows(request)  →  toViewSpec  →  { filter, sort, groupBy:[nextLevel], aggregates, depth:1 }
                  →  openView (cached & pinned, one view per query)
                  →  readWindow  →  { columns:{…}, rowCount }   ← COLUMNAR
                  →  pivot()  transposes to rows,  mapGroupRows drops the __ROW_PATH__ root
                  →  success({ rowData, rowCount })
```

- **Columnar payload** — `readWindow` returns `{ columns, rowCount }` (Perspective
  `to_columns()`); `HubDataService.pivot()` transposes it.
- **Root offset** — a grouped view puts the grand total (`__ROW_PATH__: []`) at
  index 0, so `SsrmMode` reads from `startRow + 1` and drops it. Skip this and
  every block shifts by one and a group vanishes.
- **No transaction deltas** — SSRM re-fetches loaded blocks (coalesced ~1 Hz for
  leaves) or refreshes exact group routes (`groupDelta`). By design: holding many
  grouped Perspective views open is memory-bound.

---

## Step 3 — Runtime row grouping, aggregation & pivot

When the user drags a column into row-groups, changes an aggFunc, or toggles pivot
**at runtime**, the data side is **automatic**: AG-Grid resets its store and
re-issues `getRows` with the current column state (`rowGroupCols`, `valueCols`
with their `aggFunc`, `pivotCols`, `pivotMode`), and `toViewSpec` rebuilds the
Perspective view spec from it. You write no per-change fetch code.

What you *do* wire:

### 1. Enable the interactions

```js
// colDefs: mark which columns can be grouped / aggregated / pivoted
{ ...pick('trader'),      enableRowGroup: true },
{ ...pick('bookName'),    enableRowGroup: true },
{ ...pick('marketValue'), aggFunc: 'sum' },          // enableValue on numerics
{ ...pick('currency'),    enablePivot: true },

// gridOptions: show the panels and decode pivot columns
rowGroupPanelShow: 'always',
pivotPanelShow: 'always',
serverSidePivotResultFieldSeparator: '|',            // REQUIRED — see below
```

**Pivot needs `serverSidePivotResultFieldSeparator: '|'`.** Perspective names split
columns `AUD|marketValue`; AG-Grid's default separator is `_`, and with the wrong
one it cannot decompose the field into pivot-key + value-column, so the pivot
renders **empty despite correct data**. `SsrmMode.getRows` returns `pivotResultFields`
(derived from the block) so AG-Grid knows the dynamically-created pivot columns.

### 2. Re-arm `watchGroups` whenever grouping changes

This is the one piece you must not forget. The group-aggregate delta stream has to
track *whatever grouping the user just chose*, or live group totals stop ticking
surgically (they fall back to the coarse 1 Hz block refetch). Derive the aggregates
from the grid's current value columns so a runtime aggFunc change is honored too:

```js
const requestGroupWatch = () => {
  const groupBy = gridApi.getRowGroupColumns().map((c) => c.getColId());
  if (!groupBy.length) return;                                 // ungrouped → nothing to watch
  const aggregates = Object.fromEntries(
    gridApi.getValueColumns().map((c) => [c.getColId(), c.getAggFunc() ?? 'sum']),
  );
  ssrm.watchGroups(groupBy, aggregates);                       // hub opens a matching grouped view
};
requestGroupWatch();
gridApi.addEventListener('columnRowGroupChanged', requestGroupWatch);  // grouping changed
gridApi.addEventListener('columnValueChanged',    requestGroupWatch);  // aggFunc changed
gridApi.addEventListener('columnPivotChanged',    requestGroupWatch);  // pivot changed
```

### Caveats specific to Perspective

- **AggFunc names go straight to Perspective — no translation.** `toViewSpec` does
  `spec.aggregates[col] = v.aggFunc ?? 'sum'` and the hub passes it verbatim to
  `to_columns()`. AG-Grid built-ins that Perspective also has (`sum`, `avg`,
  `count`, `min`, `max`) work; a **custom** aggFunc, or a name Perspective doesn't
  know, fails the whole view (blank block). If you register custom agg funcs, map
  their names before `watchGroups`/`getRows`.
- **Grouping is the memory-bound case in SSRM.** Each distinct grouping/pivot/filter/
  sort is a *separate* Perspective view; the view cache bounds them (`maxViews`) and
  disposes on eviction, but at 500k rows a grouped-view creation is ~2.5 s and ~50
  open grouped views is ~1 GB. SSRM is tuned for **large flat** data. If users
  *live* in deep grouped/pivoted trees, that is what **VRM**
  ([../../packages/dshub-provider/src/modes/vrm.mjs](../../packages/dshub-provider/src/modes/vrm.mjs))
  exists for — one view for the whole tree, expanded in place.

---

## Using it from React

Wrap the boot sequence in a hook — create once, connect on mount, dispose on unmount:

```tsx
function useSsrm(ref, artifact) {
  const [ssrm, setSsrm] = useState(null);
  useEffect(() => {
    let live = true, transport, mode;
    (async () => {
      const worker = new SharedWorker(
        new URL('/apps/dshub-spike/web/dshub.worker.mjs', import.meta.url),
        { type: 'module', name: 'dshub' },
      );
      let onReady; const ready = new Promise((r) => (onReady = r));
      const control = new ControlClient({ send: (m) => transport.send(m), timeoutMs: 60_000 });
      transport = new Transport({
        connect: () => worker.port,
        onControl: (m) => { if (m.type === 'result' && m.payload?.ready) return onReady(); control.handle(m); },
      });
      transport.open();
      await ready;
      await control.hello({ appId: 'blotter' });
      await control.subscribe(ref, { delivery: 'notify' });
      const dataService = new HubDataService({ control, ref, artifact, mode: 'ssrm', keyColumns: ['positionId'] });
      mode = new SsrmMode({ dataService, artifact, keyColumns: ['positionId'] });
      mode.__control = control;                       // stash for onGridReady
      if (live) setSsrm(mode); else { mode.destroy(); transport.close(); }
    })();
    return () => { live = false; mode?.destroy(); transport?.close(); };
  }, []);
  return ssrm;
}

function Blotter({ ref, artifact, columnDefs }) {
  const ssrm = useSsrm(ref, artifact);
  if (!ssrm) return <div>connecting…</div>;
  return (
    <AgGridReact
      columnDefs={columnDefs}                          // with enableRowGroup / aggFunc / enablePivot
      rowModelType="serverSide"
      serverSideDatasource={ssrm.datasource()}
      getRowId={(p) => ssrm.getRowId(p)}
      rowGroupPanelShow="always"
      pivotPanelShow="always"
      serverSidePivotResultFieldSeparator="|"
      onGridReady={(e) => {
        ssrm.attach(ssrm.__control, e.api, { refreshMs: 1000, ref });
        const rearm = () => {
          const groupBy = e.api.getRowGroupColumns().map((c) => c.getColId());
          if (!groupBy.length) return;
          const aggregates = Object.fromEntries(e.api.getValueColumns().map((c) => [c.getColId(), c.getAggFunc() ?? 'sum']));
          ssrm.watchGroups(groupBy, aggregates);
        };
        rearm();
        e.api.addEventListener('columnRowGroupChanged', rearm);
        e.api.addEventListener('columnValueChanged', rearm);
        e.api.addEventListener('columnPivotChanged', rearm);
      }}
    />
  );
}
```

> Bundler note: the worker imports absolute `/packages/*` and `/node_modules/*`
> paths, which the spike's flat static server resolves. Under Vite you'd bundle
> the worker instead — `new SharedWorker(new URL('./dshub.worker.mjs', import.meta.url), { type: 'module' })`
> with the worker's imports rewritten to package specifiers.

---

## Run it

```sh
node apps/dshub-spike/web/serve.mjs      # serves the worker + pages, rooted at the repo
```

Open [../dshub-blotter/ssrm.html](../dshub-blotter/ssrm.html). The SharedWorker
boots Perspective once and serves every tab — open two tabs on the same datasource
and it is still one upstream connection.
