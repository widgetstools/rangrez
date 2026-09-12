/**
 * SsrmWasmPlane against the REAL engine — `hub-rust/pkg` in this repo.
 *
 * The engine is a black box — its behaviours here (the `sort` key, the `|`
 * pivot separator, whole-row upserts, splitBy-needs-groupBy) were learned by
 * probing, not from documentation, so this suite pins them: a vendored WASM
 * bump that changes any of them fails here instead of rendering silently
 * wrong grids. Everything else in the plane's suite runs against fakes; keep
 * this one small and fast.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SsrmPlaneConfig } from './ssrmTypes.js';
import { SsrmWasmPlane } from './SsrmWasmPlane.js';
import type { RustHubLike } from './RustHubHost.js';

// The engine lives in THIS repo, so the plane tests the build sitting beside
// it rather than a vendored copy that can lag. That is the point of moving
// the plane here: a wasm rebuild fails these probed-behaviour tests in the
// same commit, instead of surfacing in a downstream repo weeks later.
//
// `import.meta.url` is a vite-transformed non-file URL under vitest, so the
// directory is resolved from the run cwd (the package under turbo, the repo
// root when run directly).
const VENDOR_DIR = ['../../hub-rust/pkg', 'hub-rust/pkg']
  .map((p) => resolve(process.cwd(), p))
  .find((p) => existsSync(p))!;

async function realHub(): Promise<RustHubLike> {
  const mod = await import(pathToFileURL(`${VENDOR_DIR}/dshub.js`).href) as {
    initSync: (opts: { module: Buffer }) => void;
    RustHub: { new(): RustHubLike };
  };
  mod.initSync({ module: readFileSync(`${VENDOR_DIR}/dshub_bg.wasm`) });
  return mod.RustHub.new();
}

const cfg = {
  providerType: 'stomp-ssrm',
  websocketUrl: 'ws://x',
  listenerTopic: '/t',
  snapshotEndToken: 'Success',
  requestBody: '',
  keyColumn: 'id',
  columnDefinitions: [
    { field: 'id' },
    { field: 'desk' },
    { field: 'region' },
    { field: 'trader' },
    { field: 'mv', cellDataType: 'number' },
  ],
} as SsrmPlaneConfig;

const ROWS = [
  { id: 'r1', desk: 'Rates', region: 'US', trader: 'ann', mv: 10 },
  { id: 'r2', desk: 'Rates', region: 'EU', trader: 'bob', mv: 20 },
  { id: 'r3', desk: 'Credit', region: 'US', trader: 'cat', mv: 30 },
  { id: 'r4', desk: 'Credit', region: 'EU', trader: 'dan', mv: 40 },
];

describe('SsrmWasmPlane × the in-repo engine', () => {
  let plane: SsrmWasmPlane;

  beforeAll(async () => {
    plane = new SsrmWasmPlane(realHub);
    await plane.boot('p1', cfg);
    await plane.attachSession('s1');
    await plane.ingest('p1', ROWS, false);
  });

  it('honours a descending sort (the `sort`-not-`dir` contract)', async () => {
    const page = await plane.getRows('s1', 'p1', {
      startRow: 0,
      endRow: 10,
      sortModel: [{ colId: 'mv', sort: 'desc' }],
    });
    expect(page.rowData.map((r) => r.id)).toEqual(['r4', 'r3', 'r2', 'r1']);
  });

  it('pivots a grouped view and derives the `|`-separated result fields', async () => {
    const page = await plane.getRows('s1', 'p1', {
      startRow: 0,
      endRow: 10,
      pivotMode: true,
      rowGroupCols: [{ id: 'desk' }],
      pivotCols: [{ id: 'region' }],
      valueCols: [{ id: 'mv', aggFunc: 'sum' }],
    });
    expect(page.rowCount).toBe(2);
    expect(page.pivotResultFields).toEqual(['EU|mv', 'US|mv']);
    const byDesk = new Map(page.rowData.map((r) => [r.desk, r]));
    expect(byDesk.get('Credit')).toMatchObject({ 'EU|mv': 40, 'US|mv': 30, __count: 2 });
    expect(byDesk.get('Rates')).toMatchObject({ 'EU|mv': 20, 'US|mv': 10, __count: 2 });
  });

  it('T2: retains rows ingested before any session subscribes (no anchor needed)', async () => {
    // A fresh plane + fresh engine: ingest FIRST, subscribe after — the
    // pre-T2 engine dropped these rows (cache lifetime was subscriber-
    // refcounted), which the worker's anchor session papered over.
    const fresh = new SsrmWasmPlane(realHub);
    await fresh.boot('t2', cfg);
    await fresh.ingest('t2', ROWS, false);
    await fresh.attachSession('t2s');
    const page = await fresh.getRows('t2s', 't2', { startRow: 0, endRow: 10 });
    expect(page.rowCount).toBe(4);

    // …and survives every viewer leaving.
    await fresh.detachSession('t2s');
    await fresh.attachSession('t2s2');
    expect((await fresh.getRows('t2s2', 't2', { startRow: 0, endRow: 10 })).rowCount).toBe(4);

    // Provider stop frees the table — deferred to the last live subscriber
    // (unpin with viewers keeps the entry until they leave, by design).
    await fresh.detachSession('t2s2');
    fresh.dropTable('t2');
    await fresh.ingest('t2', [ROWS[0]], false); // re-pins a FRESH table with one row
    await fresh.attachSession('t2s3');
    expect((await fresh.getRows('t2s3', 't2', { startRow: 0, endRow: 10 })).rowCount).toBe(1);
  });

  it('T2: a shrinking restart shows exactly the new snapshot, removals ride the delta', async () => {
    const fresh = new SsrmWasmPlane(realHub);
    await fresh.boot('t2r', cfg);
    await fresh.attachSession('t2rs');
    await fresh.ingest('t2r', ROWS, false);
    expect((await fresh.getRows('t2rs', 't2r', { startRow: 0, endRow: 10 })).rowCount).toBe(4);
    fresh.pollAllTicks(); // drain the snapshot delta

    // Restart whose snapshot LOST r2/r3, changed r1, added r5.
    await fresh.ingest('t2r', [], true); // restart flush (truncate)
    await fresh.ingest('t2r', [
      { ...ROWS[0], mv: 11 },
      { id: 'r5', desk: 'FX', region: 'US', trader: 'eve', mv: 50 },
    ], false);

    const page = await fresh.getRows('t2rs', 't2r', { startRow: 0, endRow: 10 });
    expect(page.rowCount).toBe(2);
    expect(page.rowData.map((r) => r.id).sort()).toEqual(['r1', 'r5']);

    // The delta stream: stale keys removed; the surviving key (r1) must ride
    // the upserts and NEVER the removals (superseded-deletion rule).
    const ticks = fresh.pollAllTicks().get('t2r') ?? [];
    const removals = ticks.flatMap((t) => t.removals ?? []);
    const upsertIds = ticks.flatMap((t) => (t.upserts ?? []).map((r) => String(r.id)));
    expect([...removals].sort()).toEqual(['r2', 'r3', 'r4']);
    expect(removals).not.toContain('r1');
    expect(upsertIds).toContain('r1');
    expect(upsertIds).toContain('r5');
  });

  it('T2: delete_rows removes by key and reaches subscribers as removals', async () => {
    const fresh = new SsrmWasmPlane(realHub);
    await fresh.boot('t2d', cfg);
    await fresh.attachSession('t2ds');
    await fresh.ingest('t2d', ROWS, false);
    fresh.pollAllTicks();

    expect(await fresh.deleteRows('t2d', ['r2', 'nope'])).toBe(1);
    expect((await fresh.getRows('t2ds', 't2d', { startRow: 0, endRow: 10 })).rowCount).toBe(3);
    const ticks = fresh.pollAllTicks().get('t2d') ?? [];
    expect(ticks.flatMap((t) => t.removals ?? [])).toEqual(['r2']);
  });

  it('holds an engine-side edit over a whole-row upstream resend', async () => {
    await plane.applyEdits('p1', [{ ...ROWS[0], trader: 'EDITED' }], [['trader']]);
    // The legacy wire resends the whole pre-edit row.
    await plane.ingest('p1', [ROWS[0]], false);
    const page = await plane.getRows('s1', 'p1', { startRow: 0, endRow: 10 });
    const r1 = page.rowData.find((r) => r.id === 'r1');
    // Whole-row upsert semantics are real here: without the overlay the
    // resend would have reverted `trader` to 'ann'.
    expect(r1).toMatchObject({ trader: 'EDITED', mv: 10 });

    // Upstream genuinely moves the column — it wins again.
    await plane.ingest('p1', [{ ...ROWS[0], trader: 'eve' }], false);
    const after = await plane.getRows('s1', 'p1', { startRow: 0, endRow: 10 });
    expect(after.rowData.find((r) => r.id === 'r1')).toMatchObject({ trader: 'eve' });
  });

  it('T3: a computed column filters, sorts, and rides every returned row', async () => {
    const notional = {
      as: 'dblMv',
      version: 1,
      expr: { k: 'bin', op: 'mul', l: { k: 'col', name: 'mv' }, r: { k: 'lit', v: 2 } },
    } as const;
    const page = await plane.getRows('s1', 'p1', {
      startRow: 0,
      endRow: 10,
      computedColumns: [notional],
      filterModel: { dblMv: { filterType: 'number', type: 'greaterThan', filter: 40 } },
      sortModel: [{ colId: 'dblMv', sort: 'desc' }],
    });
    // 2×mv > 40 keeps r3 (60) and r4 (80); desc by the computed value.
    expect(page.rowData.map((r) => [r.id, r.dblMv])).toEqual([['r4', 80], ['r3', 60]]);
    expect(page.unsupportedFilters).toBeUndefined();
  });

  it('T3: a half-parsed computed column fails the read loudly, never silently', async () => {
    await expect(plane.getRows('s1', 'p1', {
      startRow: 0,
      endRow: 1,
      computedColumns: [{ as: 'bad', version: 1, expr: { k: 'fn', name: 'REGEX_MATCH', args: [] } as never }],
    })).rejects.toThrow(/REGEX_MATCH/);
  });

  it('T4: median / stdev / distinct_count aggregate per group engine-side', async () => {
    const page = await plane.getRows('s1', 'p1', {
      startRow: 0,
      endRow: 10,
      rowGroupCols: [{ id: 'desk' }],
      groupKeys: [],
      valueCols: [{ id: 'mv', aggFunc: 'median' }],
    });
    const byDesk = new Map(page.rowData.map((r) => [r.desk, r]));
    expect(byDesk.get('Rates')).toMatchObject({ mv: 15 });
    expect(byDesk.get('Credit')).toMatchObject({ mv: 35 });
  });

  it('T5: a watched predicate reports rows ENTERING it as viewDelta ticks', async () => {
    const fresh = new SsrmWasmPlane(realHub);
    await fresh.boot('t5', cfg);
    await fresh.attachSession('t5s');
    await fresh.ingest('t5', ROWS, false);
    await fresh.watchPredicate('t5s', 't5', {
      ruleId: 'rule-1',
      expr: { k: 'bin', op: 'gt', l: { k: 'col', name: 'mv' }, r: { k: 'lit', v: 35 } },
    });
    fresh.pollAllTicks(); // priming tick: r4 is already in the set — silent
    await fresh.ingest('t5', [{ id: 'r1', desk: 'Rates', region: 'US', trader: 'ann', mv: 99 }], false);
    const ticks = fresh.pollAllTicks().get('t5') ?? [];
    const delta = ticks.find((t) => t.kind === 'viewDelta');
    expect(delta).toMatchObject({ ruleId: 'rule-1', entered: ['r1'], left: [], watchSubId: 't5s' });
    expect(delta?.rows?.[0]).toMatchObject({ id: 'r1', mv: 99 });
    // Dropping the watch silences it.
    fresh.unwatchPredicate('t5s', 'rule-1');
    await fresh.ingest('t5', [{ id: 'r2', desk: 'Rates', region: 'EU', trader: 'bob', mv: 77 }], false);
    expect((fresh.pollAllTicks().get('t5') ?? []).some((t) => t.kind === 'viewDelta')).toBe(false);
  });

  it('T6: a typed date column range-filters and sorts as instants, displays its string', async () => {
    const dateCfg = {
      ...cfg,
      columnDefinitions: [...cfg.columnDefinitions!, { field: 'traded', cellDataType: 'dateString' }],
    } as SsrmPlaneConfig;
    const fresh = new SsrmWasmPlane(realHub);
    await fresh.boot('t6', dateCfg);
    await fresh.attachSession('t6s');
    await fresh.ingest('t6', [
      { id: 'a', desk: 'Rates', mv: 1, traded: '2026-03-05' },
      { id: 'b', desk: 'Rates', mv: 2, traded: '2025-06-01' },
      { id: 'c', desk: 'Rates', mv: 3, traded: '2026-07-20' },
    ], false);
    const sorted = await fresh.getRows('t6s', 't6', {
      startRow: 0,
      endRow: 10,
      sortModel: [{ colId: 'traded', sort: 'asc' }],
    });
    expect(sorted.rowData.map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(sorted.rowData[0].traded).toBe('2025-06-01');
    const h1 = await fresh.getRows('t6s', 't6', {
      startRow: 0,
      endRow: 10,
      filterModel: { traded: { filterType: 'date', type: 'inRange', dateFrom: '2026-01-01 00:00:00', dateTo: '2026-06-30 00:00:00' } },
    });
    expect(h1.rowData.map((r) => r.id)).toEqual(['a']);
    expect(h1.unsupportedFilters).toBeUndefined();
  });

  it('T7: a pivot with no row groups serves the one grand-total row', async () => {
    const page = await plane.getRows('s1', 'p1', {
      startRow: 0,
      endRow: 10,
      pivotMode: true,
      pivotCols: [{ id: 'region' }],
      valueCols: [{ id: 'mv', aggFunc: 'sum' }],
    });
    expect(page.rowCount).toBe(1);
    expect(page.rowData[0]).toMatchObject({ 'EU|mv': 60, 'US|mv': 40 });
    expect(page.pivotResultFields).toEqual(['EU|mv', 'US|mv']);
    expect(page.unsupportedFilters).toBeUndefined();
  });
});
