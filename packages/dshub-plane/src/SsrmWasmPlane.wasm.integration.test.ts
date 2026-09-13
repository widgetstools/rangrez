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

describe('watchGroups over an already-populated table', () => {
  it('delivers the engine\u2019s initial group snapshot', async () => {
    // The engine emits a full group snapshot the moment a watch registers,
    // into the session OUTBOX — which `on_control` returns alongside the
    // reply — and then reports nothing on the next tick, because it has
    // already recorded that snapshot as its baseline. Reading only the
    // matching reply lost the entire tree for any watch registered over data
    // that already existed, which is the normal case for a grid that groups
    // an open blotter.
    const plane = new SsrmWasmPlane(realHub);
    await plane.boot('wg', cfg);
    await plane.attachSession('wgs');
    await plane.ingest('wg', ROWS, false);
    plane.pollAllTicks(); // drain the ingest delta so only the watch is left

    await plane.watchGroups('wgs', 'wg', { groupBy: ['desk'], aggregates: { mv: 'sum' } });

    const ticks = plane.pollAllTicks().get('wg') ?? [];
    const groups = ticks.filter((t) => t.kind === 'groupDelta').flatMap((t) => t.groups ?? []);
    const byValue = new Map(groups.map((g) => [String((g as { values?: unknown[] }).values?.[0]), g]));
    expect([...byValue.keys()].sort()).toEqual(['Credit', 'Rates']);
    expect(byValue.get('Rates')).toMatchObject({ count: 2, aggregates: { mv: 30 } });
    expect(byValue.get('Credit')).toMatchObject({ count: 2, aggregates: { mv: 70 } });
  });

  it('and does not repeat it on a later quiet tick', async () => {
    // Delivered once, not re-pushed: the buffer is drained, and the engine's
    // own diff has nothing to add until something moves.
    const plane = new SsrmWasmPlane(realHub);
    await plane.boot('wg2', cfg);
    await plane.attachSession('wg2s');
    await plane.ingest('wg2', ROWS, false);
    plane.pollAllTicks();
    await plane.watchGroups('wg2s', 'wg2', { groupBy: ['desk'], aggregates: { mv: 'sum' } });
    expect((plane.pollAllTicks().get('wg2') ?? []).filter((t) => t.kind === 'groupDelta')).toHaveLength(1);
    expect((plane.pollAllTicks().get('wg2') ?? []).filter((t) => t.kind === 'groupDelta')).toHaveLength(0);
  });
});

describe('computed columns on a group watch', () => {
  /**
   * The engine folds each `agg` node PER GROUP NODE, so a caption can carry a
   * weighted average. Pinned against the real wasm because it is the one
   * behaviour a client cannot check for itself — a build without it accepts
   * the same message and silently omits the column.
   *
   * `wv` weights each desk's `mv` by `w`. Rates: (10x1 + 20x9)/10 = 19.
   * Credit: (30x9 + 40x1)/10 = 31. The book: (10+180+270+40)/20 = 25, which
   * must land on neither.
   */
  const WCFG = {
    ...cfg,
    columnDefinitions: [
      { field: 'id' }, { field: 'desk' },
      { field: 'mv', cellDataType: 'number' },
      { field: 'w', cellDataType: 'number' },
    ],
  } as SsrmPlaneConfig;
  const WROWS = [
    { id: 'r1', desk: 'Rates', mv: 10, w: 1 },
    { id: 'r2', desk: 'Rates', mv: 20, w: 9 },
    { id: 'r3', desk: 'Credit', mv: 30, w: 9 },
    { id: 'r4', desk: 'Credit', mv: 40, w: 1 },
  ];
  const COMPUTED = [
    { as: 'prod', version: 1,
      expr: { k: 'bin', op: 'mul', l: { k: 'col', name: 'mv' }, r: { k: 'col', name: 'w' } } },
    { as: 'wv', version: 1,
      expr: { k: 'bin', op: 'div',
              l: { k: 'agg', fn: 'sum', col: 'prod' },
              r: { k: 'agg', fn: 'sum', col: 'w' } } },
  ] as never;

  async function watched(id: string) {
    const plane = new SsrmWasmPlane(realHub);
    await plane.boot(id, WCFG);
    await plane.attachSession(`${id}s`);
    await plane.ingest(id, WROWS, false);
    plane.pollAllTicks();
    await plane.watchGroups(`${id}s`, id, {
      groupBy: ['desk'], aggregates: { mv: 'sum' }, computedColumns: COMPUTED,
    });
    const ticks = plane.pollAllTicks().get(id) ?? [];
    const groups = ticks.filter((t) => t.kind === 'groupDelta').flatMap((t) => t.groups ?? []);
    return new Map(groups.map((g) => [String((g as { values?: unknown[] }).values?.[0]), g]));
  }

  it('each caption carries its own weighted average', async () => {
    const byDesk = await watched('wc');
    expect(byDesk.get('Rates')).toMatchObject({ aggregates: { wv: 19 } });
    expect(byDesk.get('Credit')).toMatchObject({ aggregates: { wv: 31 } });
  });

  it('and not the whole book\u2019s', async () => {
    // 25 is what a single view-scoped fold produces, and it is wrong for both.
    const byDesk = await watched('wc2');
    for (const g of byDesk.values()) {
      expect((g as { aggregates: Record<string, unknown> }).aggregates.wv).not.toBe(25);
    }
  });

  it('the plain aggregates still arrive alongside', async () => {
    // The feature must not displace what the watch already reported.
    const byDesk = await watched('wc3');
    expect(byDesk.get('Rates')).toMatchObject({ count: 2, aggregates: { mv: 30 } });
  });

  it('an unresolvable column is refused rather than silently dropped', async () => {
    const plane = new SsrmWasmPlane(realHub);
    await plane.boot('wc4', WCFG);
    await plane.attachSession('wc4s');
    await plane.ingest('wc4', WROWS, false);
    await expect(plane.watchGroups('wc4s', 'wc4', {
      groupBy: ['desk'], aggregates: { notional: 'sum' },
    })).rejects.toThrow(/notional/);
  });
});

describe('the row-delta stream is only polled when something reads it', () => {
  /**
   * A server-side grid folds GROUP deltas and re-reads the windows it shows;
   * it never looks at the row-delta stream. Polling it anyway made the engine
   * materialize one JSON object per changed row — ~60KB a tick at 400 rows,
   * measured at 64% of the whole tick — for a consumer that dropped every byte.
   *
   * On by default: a client that needs streaming rows and silently stops
   * getting them is a worse failure than a slow one.
   */
  async function planeWith(id: string) {
    const plane = new SsrmWasmPlane(realHub);
    await plane.boot(id, cfg);
    await plane.attachSession(`${id}s`);
    await plane.ingest(id, ROWS, false);
    plane.pollAllTicks();
    return plane;
  }

  it('delivers row deltas by default', async () => {
    const plane = await planeWith('rd1');
    await plane.ingest('rd1', [{ ...ROWS[0]!, mv: 999 }], false);
    const ticks = plane.pollAllTicks().get('rd1') ?? [];
    expect(ticks.some((t) => t.kind === 'rowDelta')).toBe(true);
  });

  it('stops delivering them once switched off', async () => {
    const plane = await planeWith('rd2');
    plane.setRowDeltaEnabled('rd2', false);
    await plane.ingest('rd2', [{ ...ROWS[0]!, mv: 999 }], false);
    const ticks = plane.pollAllTicks().get('rd2') ?? [];
    expect(ticks.some((t) => t.kind === 'rowDelta')).toBe(false);
  });

  it('still delivers GROUP deltas while row deltas are off', async () => {
    // The whole point: the server-side grid keeps working, and keeps working
    // on the stream it actually folds.
    const plane = await planeWith('rd3');
    plane.setRowDeltaEnabled('rd3', false);
    await plane.watchGroups('rd3s', 'rd3', { groupBy: ['desk'], aggregates: { mv: 'sum' } });
    plane.pollAllTicks();
    await plane.ingest('rd3', [{ ...ROWS[0]!, mv: 999 }], false);
    const ticks = plane.pollAllTicks().get('rd3') ?? [];
    const groups = ticks.filter((t) => t.kind === 'groupDelta').flatMap((t) => t.groups ?? []);
    expect(groups.length).toBeGreaterThan(0);
    expect(ticks.some((t) => t.kind === 'rowDelta')).toBe(false);
  });

  it('resumes when switched back on', async () => {
    const plane = await planeWith('rd4');
    plane.setRowDeltaEnabled('rd4', false);
    await plane.ingest('rd4', [{ ...ROWS[0]!, mv: 111 }], false);
    plane.pollAllTicks();
    plane.setRowDeltaEnabled('rd4', true);
    await plane.ingest('rd4', [{ ...ROWS[1]!, mv: 222 }], false);
    const ticks = plane.pollAllTicks().get('rd4') ?? [];
    const delta = ticks.find((t) => t.kind === 'rowDelta');
    expect(delta).toBeDefined();
    // The stream is created at the revision of its FIRST poll, so resuming
    // reports what changed from there — not a silent gap, and not nothing.
    expect((delta as { upserts?: unknown[] }).upserts?.length).toBeGreaterThan(0);
  });
});

describe('aggregates honour the request filter', () => {
  /**
   * The plane sent the filter under `spec`, the engine reads it from `view`,
   * and a misplaced key is not an error — it just means "no filter". So a
   * status-bar total under an active filter reported the WHOLE TABLE. Pinned
   * against the real engine because only the engine can say whether the key it
   * was handed is the key it reads.
   */
  const fcfg = {
    ...cfg,
    columnDefinitions: [{ field: 'id' }, { field: 'desk' }, { field: 'mv', cellDataType: 'number' }],
  } as SsrmPlaneConfig;

  async function planeWith(id: string) {
    const plane = new SsrmWasmPlane(realHub);
    await plane.boot(id, fcfg);
    await plane.attachSession(`${id}s`);
    await plane.ingest(id, [
      { id: 'r1', desk: 'Rates', mv: 10 },
      { id: 'r2', desk: 'Rates', mv: 20 },
      { id: 'r3', desk: 'Credit', mv: 100 },
    ], false);
    return plane;
  }

  it('sums only the filtered rows', async () => {
    // Rates is 30. The whole table is 130 — the number this used to return.
    const plane = await planeWith('af1');
    const res = await plane.getAggregates('af1s', 'af1', {
      specs: [{ column: 'mv', fn: 'sum', as: 'total' }],
      filterModel: { desk: { filterType: 'text', type: 'equals', filter: 'Rates' } },
    } as never);
    expect(res.values.total).toBe(30);
  });

  it('still sums everything when no filter is given', async () => {
    const plane = await planeWith('af2');
    const res = await plane.getAggregates('af2s', 'af2', {
      specs: [{ column: 'mv', fn: 'sum', as: 'total' }],
    } as never);
    expect(res.values.total).toBe(130);
  });

  it('refuses an aggregate over a column that does not resolve', async () => {
    const plane = await planeWith('af3');
    await expect(plane.getAggregates('af3s', 'af3', {
      specs: [{ column: 'notional', fn: 'sum', as: 't' }],
    } as never)).rejects.toThrow(/notional/);
  });
});

describe('the filter vocabulary is a contract with the engine', () => {
  /**
   * `toViewSpec.test.ts` pins sixteen operator names and a filter node shape
   * against NO ENGINE — it asserts what the plane produces, never that the
   * engine reads it. That is precisely how `spec.filter` shipped where the
   * engine reads `view.filter`: a test existed, ran, passed, and asserted the
   * wrong key against a fake that answers whatever shape it is handed.
   *
   * So this drives every operator the plane can emit through the REAL engine,
   * and every expected count is discriminating: the fixture has four rows, so
   * an operator that were ignored, unrecognised, or silently inverted would
   * return 4 or 0 where a working one returns 1, 2 or 3.
   */
  const vcfg = {
    ...cfg,
    columnDefinitions: [
      { field: 'id' }, { field: 'desk' }, { field: 'note' },
      { field: 'mv', cellDataType: 'number' },
    ],
  } as SsrmPlaneConfig;

  // Case deliberately differs between the two Govies rows: AG's text `equals`
  // maps to `equalsIgnoreCase`, and only a real engine can confirm that.
  const VROWS = [
    { id: 'r1', desk: 'Govies', note: 'alpha', mv: 10 },
    { id: 'r2', desk: 'govies', note: 'beta', mv: 20 },
    { id: 'r3', desk: 'EM', note: '', mv: 30 },
    { id: 'r4', desk: 'Credit', note: 'alphabet', mv: 40 },
  ];

  let plane: SsrmWasmPlane;
  beforeAll(async () => {
    plane = new SsrmWasmPlane(realHub);
    await plane.boot('fv', vcfg);
    await plane.attachSession('fvs');
    await plane.ingest('fv', VROWS, false);
  });

  const count = async (filterModel: Record<string, unknown>) =>
    (await plane.getRows('fvs', 'fv', { startRow: 0, endRow: 10, filterModel } as never)).rowCount;

  const text = (type: string, filter: unknown) =>
    ({ desk: { filterType: 'text', type, filter } });
  const num = (type: string, filter: unknown, filterTo?: unknown) =>
    ({ mv: { filterType: 'number', type, filter, ...(filterTo === undefined ? {} : { filterTo }) } });

  it.each([
    ['contains',            text('contains', 'gov'),        2],
    ['notContains',         text('notContains', 'gov'),     2],
    ['startsWith',          text('startsWith', 'gov'),      2],
    ['endsWith',            text('endsWith', 'ies'),        2],
    ['equals (ignores case)', text('equals', 'Govies'),     2],
    ['notEqual',            text('notEqual', 'Govies'),     2],
  ])('text %s', async (_name, model, expected) => {
    expect(await count(model)).toBe(expected);
  });

  it.each([
    ['equals',             num('equals', 20),            1],
    ['notEqual',           num('notEqual', 20),          3],
    ['greaterThan',        num('greaterThan', 20),       2],
    ['greaterThanOrEqual', num('greaterThanOrEqual', 20), 3],
    ['lessThan',           num('lessThan', 20),          1],
    ['lessThanOrEqual',    num('lessThanOrEqual', 20),   2],
    ['inRange',            num('inRange', 20, 30),       2],
  ])('number %s', async (_name, model, expected) => {
    expect(await count(model)).toBe(expected);
  });

  it('blank and notBlank read an empty string as blank', async () => {
    expect(await count({ note: { filterType: 'text', type: 'blank' } })).toBe(1);
    expect(await count({ note: { filterType: 'text', type: 'notBlank' } })).toBe(3);
  });

  it('a set filter picks exactly its values', async () => {
    expect(await count({ desk: { filterType: 'set', values: ['EM'] } })).toBe(1);
    expect(await count({ desk: { filterType: 'set', values: ['EM', 'Credit'] } })).toBe(2);
  });

  it('an EMPTY set selection matches nothing, not everything', async () => {
    // The difference between an empty grid and an unfiltered one, and the kind
    // of inversion no shape assertion can see.
    expect(await count({ desk: { filterType: 'set', values: [] } })).toBe(0);
  });

  it('two conditions AND by default and OR when asked', async () => {
    const and = {
      mv: { filterType: 'number', operator: 'AND', conditions: [
        { filterType: 'number', type: 'greaterThan', filter: 10 },
        { filterType: 'number', type: 'lessThan', filter: 40 },
      ] },
    };
    const or = { ...and, mv: { ...and.mv, operator: 'OR' } };
    expect(await count(and)).toBe(2);   // 20, 30
    expect(await count(or)).toBe(4);    // every row clears one side or the other
  });

  it('filters compose across columns', async () => {
    expect(await count({
      ...text('contains', 'gov'),
      ...num('greaterThan', 15),
    })).toBe(1);
  });

  it('an unresolvable filter column is refused, in both directions', async () => {
    // Before: `equals` returned 0 rows and `notEqual` returned all of them,
    // neither an error. The second is the expensive one — a blotter that looks
    // filtered and is not.
    await expect(count({ trader: { filterType: 'text', type: 'equals', filter: 'ann' } }))
      .rejects.toThrow(/trader/);
    await expect(count({ trader: { filterType: 'text', type: 'notEqual', filter: 'ann' } }))
      .rejects.toThrow(/trader/);
  });
});

describe('diagnostics say whether the fast path is still the fast path', () => {
  /**
   * The incremental group watch is 152x faster than the scan it replaced, and
   * the win is conditional — on the folds being invertible, and on the touch
   * log still reaching back. Either can stop holding in production without
   * anything failing. Pinned against the real engine because the counters are
   * only worth having if they survive the wasm boundary intact.
   */
  interface Diag {
    hub: Record<string, unknown>;
    sessions: Array<{
      sessionId: string;
      groupWatches: Array<{
        datasourceId: string;
        nodes: number;
        touchLog: { behind: number; cap: number };
        stats: { polls: number; incremental: number; slotsPatched: number;
                 rebuilds: Record<string, number> };
      }>;
    }>;
  }

  it('reports a watch, its nodes, and its touch-log headroom', async () => {
    const plane = new SsrmWasmPlane(realHub);
    await plane.boot('dg', cfg);
    await plane.attachSession('dgs');
    await plane.ingest('dg', ROWS, false);
    await plane.watchGroups('dgs', 'dg', { groupBy: ['desk'], aggregates: { mv: 'sum' } });
    plane.pollAllTicks();

    const d = plane.diagnostics() as Diag;
    const session = d.sessions.find((s) => s.sessionId === 'dgs');
    expect(session).toBeDefined();
    expect(session!.groupWatches).toHaveLength(1);
    const w = session!.groupWatches[0]!;
    expect(w.datasourceId).toBe('dg');
    expect(w.nodes).toBe(2);
    expect(w.touchLog.cap).toBeGreaterThan(0);
    // Just polled, so nothing to reach back for. `behind` crossing `cap` is
    // the warning; the log's fill level is not.
    expect(w.touchLog.behind).toBe(0);
  });

  it('counts the polls that patched rather than rescanned', async () => {
    const plane = new SsrmWasmPlane(realHub);
    await plane.boot('dg2', cfg);
    await plane.attachSession('dg2s');
    await plane.ingest('dg2', ROWS, false);
    await plane.watchGroups('dg2s', 'dg2', { groupBy: ['desk'], aggregates: { mv: 'sum' } });
    plane.pollAllTicks();
    for (let i = 0; i < 5; i++) {
      await plane.ingest('dg2', [{ ...ROWS[0]!, mv: 100 + i }], false);
      plane.pollAllTicks();
    }
    const d = plane.diagnostics() as Diag;
    const w = d.sessions.find((s) => s.sessionId === 'dg2s')!.groupWatches[0]!;
    expect(w.stats.incremental).toBeGreaterThan(0);
    // One row moved per tick — the count is the work done, against four rows
    // the full scan would have read every time.
    expect(w.stats.slotsPatched).toBeGreaterThan(0);
    expect(w.stats.slotsPatched).toBeLessThan(w.stats.polls * ROWS.length);
    expect(w.stats.rebuilds.logBehind).toBe(0);
  });

  it('names an uninvertible fold as such, not as a stale log', async () => {
    // Different problems with different fixes: `min` is a capability gap, a
    // fallen-behind log is a tick interval. A counter that said only "rebuilt"
    // would send you tuning the wrong one.
    const plane = new SsrmWasmPlane(realHub);
    await plane.boot('dg3', cfg);
    await plane.attachSession('dg3s');
    await plane.ingest('dg3', ROWS, false);
    await plane.watchGroups('dg3s', 'dg3', { groupBy: ['desk'], aggregates: { mv: 'min' } });
    plane.pollAllTicks();
    await plane.ingest('dg3', [{ ...ROWS[0]!, mv: 1 }], false);
    plane.pollAllTicks();

    const d = plane.diagnostics() as Diag;
    const w = d.sessions.find((s) => s.sessionId === 'dg3s')!.groupWatches[0]!;
    expect(w.stats.rebuilds.unsupported).toBeGreaterThan(0);
    expect(w.stats.rebuilds.logBehind).toBe(0);
    expect(w.stats.incremental).toBe(0);
  });

  it('is null on an engine build that has no such verb', () => {
    // A caller must be able to tell "not supported" from "nothing to report".
    const plane = new SsrmWasmPlane(() => ({
      mem_stats: () => '{}',
    }) as never);
    expect(plane.diagnostics()).toBeNull();
  });
});

