import type { SsrmComputedColumnSpec, SsrmExprNode } from './ssrmExpression.js';

export type { SsrmComputedColumnSpec, SsrmExprNode };

/** AG Grid 36 SSRM getRows request (subset we persist across the worker port). */
export interface SsrmColRef {
  id: string;
  field?: string;
  displayName?: string;
  aggFunc?: string;
}

export interface SsrmGetRowsRequest {
  startRow?: number;
  endRow?: number;
  /**
   * Engine-computed columns riding this view (contract wire form v1,
   * `compileToEngineExpression` output). The engine evaluates them per row —
   * they are addressable by the same request's sort/filter/group under their
   * `as` name, and each returned row carries the value.
   */
  computedColumns?: readonly SsrmComputedColumnSpec[];
  rowGroupCols?: readonly SsrmColRef[];
  valueCols?: readonly SsrmColRef[];
  pivotCols?: readonly SsrmColRef[];
  pivotMode?: boolean;
  groupKeys?: readonly unknown[];
  filterModel?: Record<string, unknown> | null;
  sortModel?: readonly { colId: string; sort: 'asc' | 'desc' }[];
  quickFilterText?: string;
}

export interface SsrmGetRowsResult {
  rowData: readonly Record<string, unknown>[];
  rowCount: number;
  groupData?: Record<string, unknown>;
  grandTotalData?: Record<string, unknown>;
  pivotResultFields?: string[];
  /**
   * Filter conditions the engine had no translation for. The block was served
   * WITHOUT them, so it holds more rows than the grid's filter asks for — the
   * main thread must surface this rather than paint it as a correct result.
   */
  unsupportedFilters?: readonly string[];
}

/**
 * Rows edited in a grid — cell edits, clipboard paste, fill handle — written
 * into the engine cache so every grid on the provider sees the same values
 * and a block refresh keeps them. Each row must carry the key column(s);
 * send the full row, since the engine upserts whole records.
 *
 * The upstream feed is NOT written to. To keep a whole-row upstream resend
 * from silently reverting the edit, name the edited columns: the plane holds
 * each named column as an overlay and reapplies it over incoming upstream
 * rows until the upstream value itself CHANGES (a genuinely new value wins)
 * or echoes the edited value back (confirmed). Without `editedColumns` no
 * overlay is kept and the row's next upstream tick wins — the pre-overlay
 * behaviour.
 */
export interface SsrmApplyEditsRequest {
  rows: readonly Record<string, unknown>[];
  /**
   * Index-aligned with `rows`: the columns the user actually edited in each
   * row. Only these are overlaid; the rest of the row is carried solely so
   * the engine's whole-row upsert does not blank it.
   */
  editedColumns?: ReadonlyArray<readonly string[]>;
}

export interface SsrmApplyEditsResult {
  applied: number;
}

export interface SsrmTickPayload {
  kind: 'rowDelta' | 'groupDelta' | 'viewDelta';
  upserts?: readonly Record<string, unknown>[];
  removals?: readonly string[];
  reset?: boolean;
  groups?: readonly Record<string, unknown>[];
  removed?: readonly string[];
  /** viewDelta: the watched predicate this delta belongs to. */
  ruleId?: string;
  /** viewDelta: keys that ENTERED the predicate's row set this tick. */
  entered?: readonly string[];
  /** viewDelta: keys that LEFT it. */
  left?: readonly string[];
  /** viewDelta: entered rows at current values (capped engine-side at 200). */
  rows?: readonly Record<string, unknown>[];
  /**
   * viewDelta: the session that registered the watch. The worker fans ticks
   * out per provider; this pins the delta to the ONE grid whose rule it is,
   * so two windows with the same profile do not both fire the same alert.
   */
  watchSubId?: string;
}

export interface SsrmWatchGroupsRequest {
  groupBy: readonly string[];
  aggregates?: Record<string, string>;
}

/**
 * Watch a boolean predicate over the whole dataset: the engine keeps the
 * predicate's row set per revision and reports which keys ENTER and LEAVE
 * (`viewDelta` ticks) — alert rules fire on transitions across ALL rows,
 * not just loaded blocks. The predicate is a compiled contract expression
 * (same wire form as computed columns).
 */
export interface SsrmWatchPredicateRequest {
  ruleId: string;
  expr: SsrmExprNode;
}

/**
 * The engine's filter operator set — NOT AG Grid's. Anything outside it has no
 * translation and is reported as unsupported rather than sent and silently
 * dropped (a filter the engine never sees shows MORE rows than the user asked
 * for, which looks like working software).
 */
export type SsrmFilterOp =
  | 'equals' | 'notEqual' | 'equalsIgnoreCase' | 'notEqualIgnoreCase'
  | 'contains' | 'notContains' | 'startsWith' | 'endsWith'
  | 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual'
  | 'inRange' | 'in' | 'blank' | 'notBlank';

export interface SsrmFilterCondition {
  column: string;
  op: SsrmFilterOp;
  value?: unknown;
  /** Upper bound — `inRange` only. */
  valueTo?: unknown;
}

/**
 * A disjunction. The engine ANDs the top-level filter list, so AG Grid's
 * OR-combined conditions become one of these instead of being flattened —
 * flattening an OR shows fewer rows than the user asked for.
 */
export interface SsrmFilterOr {
  op: 'or';
  conditions: SsrmFilterNode[];
}

export type SsrmFilterNode = SsrmFilterCondition | SsrmFilterOr;

/**
 * Separator the engine joins pivot key paths with when a `splitBy` view
 * names its result fields (`US|USD|marketValue` — probed, not documented).
 * The grid must hand the SAME separator to AG Grid
 * (`serverSidePivotResultFieldSeparator`) so the secondary column tree
 * splits where the engine joined. A pivot key VALUE containing `|` is folded
 * to `¦` by the engine before joining, so a value cannot forge field
 * boundaries (plan §12 T7).
 */
export const SSRM_PIVOT_FIELD_SEPARATOR = '|';


export interface SsrmViewSpec {
  /** ANDed together. */
  filter: SsrmFilterNode[];
  /**
   * The engine reads the direction from `sort` — a `dir` key is silently
   * ignored and the view comes back ascending, which is how every descending
   * sort in this stack was wrong before this shape was verified against the
   * WASM directly.
   */
  sort: Array<{ column: string; sort: 'asc' | 'desc' }>;
  groupBy?: string[];
  splitBy?: string[];
  aggregates?: Record<string, string>;
  columns?: string[];
  depth?: number;
  /** Engine-computed columns (`[{as, expr}]`, contract wire form v1). */
  computed?: Array<{ as: string; expr: SsrmExprNode }>;
  /** Membership watch — the engine reports entered/left keys per revision. */
  watch?: boolean;
}

/**
 * Row count for a filter the grid has NOT applied — the saved-filter pill
 * badges. The client can't scan for this under SSRM: it only holds the blocks
 * it has loaded, so a client-side count reports block statistics, not totals.
 */
export interface SsrmRowCountRequest {
  filterModel?: Record<string, unknown> | null;
  quickFilterText?: string;
}

export interface SsrmRowCountResult {
  rowCount: number;
}

/** One aggregation the status bar (or a grouped view) can ask the engine for. */
export type SsrmAggFn =
  | 'sum' | 'avg' | 'min' | 'max' | 'count'
  | 'median' | 'stdev' | 'variance' | 'distinct_count';

export interface SsrmAggSpec {
  column: string;
  fn: SsrmAggFn;
  /** Result key. Defaults to `${column}_${fn}`. */
  as?: string;
}

export interface SsrmAggregatesRequest {
  filterModel?: Record<string, unknown> | null;
  quickFilterText?: string;
  specs: readonly SsrmAggSpec[];
}

export interface SsrmAggregatesResult {
  values: Record<string, number>;
}

/** Distinct values for one column — populates an AG Grid set filter. */
export interface SsrmColumnValuesRequest {
  column: string;
  /** Cap on returned values; the engine's group read is bounded. */
  limit?: number;
  /** Narrow the distinct scan to the other columns' active filters. */
  filterModel?: Record<string, unknown> | null;
  /** Narrow the distinct scan to the active quick filter, like any other filter. */
  quickFilterText?: string;
}

export interface SsrmColumnValuesResult {
  column: string;
  values: readonly unknown[];
  /** True when `limit` cut the list short. */
  truncated: boolean;
}

/**
 * What the plane reads off a provider config — the whole of it.
 *
 * Structural on purpose: starui's `SsrmPlaneConfig` satisfies this without
 * either side importing the other, which is what keeps this package
 * dependency-free. The plane touches exactly these four fields; anything else
 * on a caller's config is its own business.
 */
export interface SsrmPlaneConfig {
  /** Column metadata — field names and `cellDataType` drive the engine schema. */
  columnDefinitions?: ReadonlyArray<{ field?: string; cellDataType?: string; [k: string]: unknown }>;
  /** Row identity. String or composite, matching the engine's `__key`. */
  keyColumn?: string | readonly string[];
  /** Tick conflation window handed to the engine at boot. */
  publishWindowMs?: number;
  /** Columns a free-text search scans. */
  searchColumns?: readonly string[];
}
