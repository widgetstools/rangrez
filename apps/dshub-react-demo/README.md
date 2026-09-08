# dshub-react-demo

A Vite + React 19 + TypeScript app that drives an **AG-Grid** blotter from a
**DataSource Hub**, in both **SSRM** and **CSRM** modes, over a single
`HubDataProvider`.

```
<AgGridReact>  ⟶  HubDataProvider  ⟶  hub (Rust sidecar :8787)  ⟶  STOMP view server :8081
   the grid        the bridge          caches + pushes              the real upstream feed
```

The app never speaks the hub's wire protocol directly. It *describes* a datasource
and wires the grid — that's the whole integration, about 15 lines.

---

## Tutorial: using the hub in this app

### The mental model

Three layers, each with one job:

- **The hub** caches an upstream feed once and publishes it to many subscribers
  (snapshots + live deltas). It runs *outside* the browser (the Rust sidecar), so
  a 20k-row feed is fetched and cached once, not per tab.
- **`HubDataProvider`** is the only thing that speaks the hub's protocol. It hands
  the grid its column definitions, feeds it data, and pushes live updates.
- **Your app** just describes a datasource and wires the grid.

You touch four files, in increasing rarity:

| File | Role | How often you edit it |
| --- | --- | --- |
| [`src/datasource.ts`](src/datasource.ts) | *what* data to show | per datasource |
| [`src/App.tsx`](src/App.tsx) | wire the grid | per screen |
| [`src/hub/useHubProvider.ts`](src/hub/useHubProvider.ts) | React lifecycle | almost never |
| [`src/hub/HubDataProvider.ts`](src/hub/HubDataProvider.ts) | the bridge | almost never |

### Step 1 — Describe the datasource

You don't fetch anything. You describe the upstream feed and let the hub connect
to it. From [`src/datasource.ts`](src/datasource.ts):

```ts
export const POSITIONS: DatasourceConfig = {
  id: 'positions',                 // the hub keys its shared cache on this
  keyColumns: ['positionId'],      // row identity — drives getRowId + delta upserts
  columns: [
    { name: 'positionId', type: 'string' },
    { name: 'desk', type: 'string' },
    { name: 'marketValue', type: 'integer' },
    { name: 'dv01', type: 'float' },
    // …
  ],
  connection: {                    // how the HUB reaches upstream (not the browser)
    transport: 'stomp',
    url: 'ws://127.0.0.1:8081',
    heartbeat: { outMs: 1000, inMs: 10000 },
  },
  snapshot: { mode: 'trigger-reply', triggerDestination: '/snapshot/positions/{clientId}/{rate}/{batchSize}', /* … */ },
  updates:  { destination: '/snapshot/positions/{clientId}', bodyShape: 'record-array' },
};

export const GRID_HINTS = {
  group: ['desk', 'trader'],                                 // row-group columns, outermost first
  agg:   { marketValue: 'sum', notionalAmount: 'sum', dv01: 'sum' },
};

export const HUB_URL = 'ws://127.0.0.1:8787';
```

- **`columns`** is the schema — the provider turns it into AG-Grid column
  definitions (types decide right-alignment, number formatting, and which filter
  each column gets).
- **`connection` / `snapshot` / `updates`** are how the *hub* talks to the upstream
  STOMP server. The browser never touches `:8081`.
- **`GRID_HINTS`** is presentation: what to group by and how to aggregate.

### Step 2 — Own a provider for the component's lifetime

React needs the provider created once, connected on mount, disposed on unmount.
That's the whole hook — [`src/hub/useHubProvider.ts`](src/hub/useHubProvider.ts):

```ts
export function useHubProvider(config: HubProviderConfig) {
  const ref = useRef<HubDataProvider | null>(null);
  if (ref.current === null) ref.current = new HubDataProvider(config);  // created ONCE
  const dp = ref.current;

  const [state, setState] = useState<HubState>('connecting');

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      dp.connect().then(() => !cancelled && setState('live'))
                  .catch((e) => !cancelled && setState(`error: ${/* … */ e}`));
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); dp.dispose(); };  // close socket on unmount
  }, [dp]);

  return { dp, state };
}
```

- **`useRef` + create-once** — re-renders must not spawn new hub connections.
- **`dispose()` on cleanup** closes the transport. When the last subscriber leaves,
  the hub stops that datasource's upstream ingestor — no leaks.
- **The `setTimeout(0)` + `cancelled`** is the StrictMode guard: React's dev
  mount→unmount→mount would otherwise open a socket and immediately close it
  mid-handshake. Deferring one tick lets the cleanup cancel it cleanly.

### Step 3 — Wire the grid

Once `state === 'live'`, hand the grid what the provider produces —
[`src/App.tsx`](src/App.tsx):

```tsx
function Blotter({ mode }: { mode: GridMode }) {
  const { dp, state } = useHubProvider({
    hubUrl: HUB_URL,
    mode,
    params: { clientId: `react-demo-${mode}`, rate: 2000, batchSize: 10 },
    grid: { group: [...GRID_HINTS.group], agg: { ...GRID_HINTS.agg } },
    datasource: POSITIONS,
  });

  if (state !== 'live') return <div className="boot">{state}</div>;

  return (
    <AgGridReact
      theme={blotterTheme}
      columnDefs={dp.columnDefs()}          // ← from the datasource schema
      defaultColDef={defaultColDef}
      {...dp.gridOptions()}                 // ← getRowId, cell-flash, + SSRM row model
      onGridReady={(e) => dp.attach(e.api)} // ← snapshot + live deltas
    />
  );
}
```

The provider gives the grid three things:

1. **`columnDefs()`** — column definitions derived from the schema.
2. **`gridOptions()`** — the row-id function, cell-flash timings, and (for SSRM)
   `rowModelType: 'serverSide'` + `autoGroupColumnDef`.
3. **`attach(api)`** — subscribes the grid to the live data (differs by mode).

Two subtleties, both handled:

- **Gate on `'live'`.** Rendering the grid only after `connect()` resolves
  guarantees `onGridReady` → `attach` runs *after* the datasource is bootstrapped
  and subscribed.
- **`<Blotter key={mode} />`** in `App` — changing the key forces a clean remount
  (fresh provider + subscription) when you flip SSRM/CSRM.

### What `connect()` actually does

Three control messages, in order:

```ts
await this.control.request({ type: 'hello', appId: 'hub-data-provider', protocolVersion: 1 });
await this.control.request({ type: 'bootstrap', datasources: [this.datasource] });
await this.control.request({ type: 'subscribe', ref: this.ref, delivery: 'rows' });
```

- **`hello`** — handshake.
- **`bootstrap`** — "here's the datasource config; go cache it." The hub reconciles
  by checksum: if `positions` is already cached (another tab, another app), you
  *share* the existing cache; otherwise it connects upstream and fills it. This is
  the multi-tenancy story — one cache, many subscribers.
- **`subscribe`** — start receiving live row deltas for this datasource.

Under `connect` sits only the thin shared transport — `ControlClient`
(request/reply + events) over a `socketIoPort`. Its types are declared in
[`src/hub/dshub-provider.d.ts`](src/hub/dshub-provider.d.ts); the runtime code is
the real `@wellsfargo-starui/dshub-provider` package.

### Two modes, one provider

`attach()` branches on `mode`:

| | **CSRM** (client-side) | **SSRM** (server-side) |
| --- | --- | --- |
| Snapshot | reads the whole table into `rowData` | `getRows` fetches one block at a time |
| Grouping/agg | the grid does it, in the browser | the **hub** does it, per request |
| Live updates | `applyTransactionAsync` (add-or-update stream) | `applyServerSideTransaction` per group route |
| Good for | up to ~100k rows, rich client interactions | very large datasets; browser holds only what's visible |

Same `columnDefs()`, same `connect()` — only `attach` and `gridOptions` differ.
You pick with one field: `mode: 'ssrm' | 'csrm'`.

### How an SSRM request flows

When you scroll or expand a group, AG-Grid calls `getRows`. The provider
translates that request into a hub *view*:

```
grid getRows(request)
   │  request = { groupKeys, rowGroupCols, valueCols, sortModel, filterModel, startRow, endRow }
   ▼
build a view:
   filter     = [ groupKeys as equals ]  +  [ filterModel translated to hub ops ]
   sort       = sortModel
   groupBy    = next level's column          (if there's a deeper group level)
   aggregates = { marketValue: 'sum', … }
   ▼
openView(view) → readWindow(startRow..endRow) → disposeView
   ▼
params.success({ rowData, rowCount })
```

So the hub filters, sorts, groups, and aggregates 20k rows *server-side* and
returns just the 100-row block the grid asked for. The grid never holds the full
dataset.

### How a live tick flows

The upstream feed changes a price → the hub updates its cache → it pushes a delta
→ the provider applies it as a transaction, then acks:

```
STOMP update → hub cache tick → pushes 'rowDelta' / 'groupDelta'
   ▼  (in attachSsrm)
if a live column is sorted OR a filter is active → refreshServerSide({purge:false})   // re-fetch, stay correct
else → applyServerSideTransaction({ route, update })                                  // patch in place
   ▼
dp.ack(seq)   // flow control — tells the hub we kept up
```

Two things make this blotter-grade:

- **The ack** — the hub runs a backpressure ladder; a subscriber that stops acking
  gets throttled then dropped. Acking every pushed message keeps the stream
  continuous (no periodic freeze).
- **The refetch guard** — pushed deltas are *unfiltered/unsorted*; applying them
  directly under an active filter or a sorted live column would show wrong values
  or fail to re-order, so the provider re-fetches instead. In CSRM the grid handles
  sort/filter itself, so it just streams add-or-update transactions.

### Filtering

Because SSRM has no client rows, the Set Filter can't enumerate itself. The
provider wires it two ways in `columnDefs()`:

- **Populate:** dimension columns get `filter: 'agSetColumnFilter'` with an async
  `values` callback that fetches the column's distinct values via the hub's
  `distinctValues`. (Numeric → number filter; the high-cardinality key → text filter.)
- **Apply:** `getRows` translates AG-Grid's `filterModel` (set / text / number,
  incl. AND-OR and ranges) into hub filter conditions. The hub's op vocabulary
  mirrors AG-Grid's, so it's a near 1:1 map.

---

## Prerequisites

Two servers must be running (the hub and its upstream):

1. **Rust sidecar hub** on `ws://127.0.0.1:8787`
   ```sh
   ./hub-rust/target/release/dshub-sidecar-rs
   ```
2. **STOMP view server** on `ws://127.0.0.1:8081` (the 20k-row `positions` feed).

## Run

From the monorepo root (installs the workspace, including this app's dev deps):

```sh
npm install
npm run dev -w @wellsfargo-starui/dshub-react-demo
```

Then open the URL Vite prints (http://localhost:5173 by default) and toggle
**SSRM / CSRM** in the header.

- `npm run typecheck -w @wellsfargo-starui/dshub-react-demo` — strict TS check
- `npm run build -w @wellsfargo-starui/dshub-react-demo` — production bundle

---

## Cheat sheet — where to change things

| I want to… | Edit |
| --- | --- |
| Show more/fewer columns | `POSITIONS.columns` in [`src/datasource.ts`](src/datasource.ts) |
| Group/aggregate differently | `GRID_HINTS` in [`src/datasource.ts`](src/datasource.ts) |
| Point at a different hub | `HUB_URL` in [`src/datasource.ts`](src/datasource.ts) |
| Add a second datasource | export another `DatasourceConfig`, pass it to a second `useHubProvider` |
| Default to CSRM | initial `useState<GridMode>('csrm')` in [`src/App.tsx`](src/App.tsx) |
| Change filter / row-model behaviour | [`src/hub/HubDataProvider.ts`](src/hub/HubDataProvider.ts) (rare) |
