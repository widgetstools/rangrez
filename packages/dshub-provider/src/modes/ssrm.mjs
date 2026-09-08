/**
 * SSRM mode — server-side row model.
 *
 * Parity study §2. Each `getRows` request becomes a view spec; the hub answers a
 * window. Blotter code never sees any of this — it goes through GridDataService
 * exactly as CSRM does.
 *
 * ── When to use this, per Phase 0's measurements ──────────────────────────────
 *
 * SSRM is the right mode for LARGE FLAT datasets. Filtered views are cheap:
 * ~19 ms to create, ~2.9 MB each.
 *
 * It is the WRONG mode for heavily grouped ones, but not for the reason first
 * recorded. Phase 0 measured a 3.3x ingest penalty from holding a grouped view
 * open; at 500k x 160 that is 1.05x — inside the noise (findings §17). The 20k
 * figure was fixed per-update overhead on a table small enough for view
 * maintenance to dominate, and it does not survive at realistic size.
 *
 * The real costs at 500k are:
 *
 *   grouped view creation   ~2.5 SECONDS   (a visible stall on every expand)
 *   50 grouped views        +1,055 MB      on a 1,184 MB table
 *
 * Memory is the binding constraint, not throughput: throughput degrades,
 * ceilings terminate. SSRM holds one such view per expanded node, continuously.
 * VRM needs one for the whole tree.
 *
 * So: flat -> SSRM, grouped -> VRM. The mode selector encodes that.
 */

import { rowKey, KEY_SEPARATOR as SEPARATOR } from '../../../dshub-spec/src/rowkey.mjs';
import { routesToRefresh } from '../../../dshub-spec/src/grouproutes.mjs';

/**
 * Stable signature for a getRows request.
 *
 * The view cache is keyed on this. Without it every scroll block opens a new
 * view and none is ever reused — "one view per expanded node leaks server
 * memory otherwise" (architecture §8.2).
 *
 * Deliberately EXCLUDES startRow/endRow: the same view serves every window of
 * the same query, and including the range would make the cache useless.
 */
export function requestSignature(req) {
  return stable({
    groupKeys: req.groupKeys ?? [],
    rowGroupCols: (req.rowGroupCols ?? []).map((c) => c.id),
    valueCols: (req.valueCols ?? []).map((c) => ({ id: c.id, agg: c.aggFunc })),
    pivotCols: (req.pivotCols ?? []).map((c) => c.id),
    pivotMode: !!req.pivotMode,
    filterModel: req.filterModel ?? null,
    sortModel: req.sortModel ?? [],
  });
}

/**
 * Key-order-independent JSON.
 *
 * `filterModel` is a plain object whose key order follows the order the user
 * happened to apply the filters. Under plain JSON.stringify the same two
 * filters applied in the other order produce a different signature, so the
 * cache misses and a fresh view is opened for a query already held — and a
 * grouped view costs ~300 ms to create and 3.3x on ingest throughput. Array
 * order is preserved, because there it is meaningful (sort precedence).
 */
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

/**
 * getRows request -> our ViewSpec.
 *
 * The subtle rule is `rowGroupCols`: group by ONLY the next level, not the whole
 * list. `groupKeys` is the path already expanded, so its length is the depth,
 * and the next level is the column at that index. Passing every rowGroupCol
 * would return the fully expanded tree for a single node expansion.
 */
export function toViewSpec(req, { softDeleteColumn } = {}) {
  const groupKeys = req.groupKeys ?? [];
  const rowGroupCols = req.rowGroupCols ?? [];
  const spec = { filter: [], sort: [] };

  // The expanded path becomes equality filters, one per level.
  groupKeys.forEach((value, i) => {
    const col = rowGroupCols[i];
    if (col) spec.filter.push({ column: col.id, op: 'equals', value });
  });

  // Soft-deleted rows are not data.
  if (softDeleteColumn) spec.filter.push({ column: softDeleteColumn, op: 'notEqual', value: true });

  for (const [colId, model] of Object.entries(req.filterModel ?? {})) {
    for (const f of filterModelToOps(colId, model)) spec.filter.push(f);
  }

  const next = rowGroupCols[groupKeys.length];
  if (next) {
    spec.groupBy = [next.id];
    spec.aggregates = {};
    for (const v of req.valueCols ?? []) spec.aggregates[v.id] = v.aggFunc ?? 'sum';
    // One level of children per expansion.
    spec.depth = 1;
  }

  /**
   * Pivot maps to Perspective's `split_by`.
   *
   * `requestSignature` already keyed the view cache on pivotCols and pivotMode,
   * so two different pivots got two different views — but nothing ever READ
   * them, so both views were built identically and a pivoted grid was served
   * unpivoted data. Silently wrong rather than unsupported, which is the worse
   * of the two failures.
   */
  if (req.pivotMode && (req.pivotCols ?? []).length) {
    spec.splitBy = req.pivotCols.map((c) => c.id);
    /**
     * Restrict the columns BEFORE splitting.
     *
     * Perspective splits every column it is given, so an unrestricted pivot of
     * this corpus produced 2,612 columns — 373 fields times each currency —
     * when AG-Grid wants only the aggregated value columns. That is not merely
     * untidy: every one of those is materialised in the view.
     */
    const values = (req.valueCols ?? []).map((v) => v.id);
    if (values.length) spec.columns = values;
  }

  for (const s of req.sortModel ?? []) spec.sort.push({ column: s.colId, dir: s.sort });
  return spec;
}

/**
 * Operations the server side can actually execute.
 *
 * NOTE the absence of `notContains`: Perspective has `contains` but no negation
 * of it, so there is nothing to translate to. AG-Grid offers "Not contains" in
 * the DEFAULT text filter menu, so leaving this implicit meant a trader could
 * pick it, every getRows would throw, and the grid would go blank with no
 * indication why.
 *
 * `SERVER_FILTER_OPTIONS` below is derived from this map so the menu can only
 * offer what the translator can execute — the two cannot drift apart.
 */
const OPS = {
  equals: 'equals', notEqual: 'notEqual',
  contains: 'contains', startsWith: 'startsWith', endsWith: 'endsWith',
  greaterThan: 'greaterThan', greaterThanOrEqual: 'greaterThanOrEqual',
  lessThan: 'lessThan', lessThanOrEqual: 'lessThanOrEqual',
  blank: 'blank', notBlank: 'notBlank',
};

/** The filter menus a server-backed column may offer, per AG-Grid filter type. */
export const SERVER_FILTER_OPTIONS = {
  // `notContains` is offered again: it has no Perspective operator but it does
  // have an expression form, so it is translatable even though it is not in OPS.
  text: ['contains', 'notContains', 'equals', 'notEqual', 'startsWith', 'endsWith', 'blank', 'notBlank']
    .filter((o) => o === 'notContains' || o in OPS),
  number: ['equals', 'notEqual', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual', 'inRange', 'blank', 'notBlank']
    .filter((o) => o === 'inRange' || o in OPS),
  date: ['equals', 'notEqual', 'greaterThan', 'lessThan', 'inRange', 'blank', 'notBlank']
    .filter((o) => o === 'inRange' || o in OPS),
};

/** AG-Grid FilterModel -> our filter ops. Blank/set/range semantics per filter.mjs. */
export function filterModelToOps(colId, model) {
  if (!model) return [];

  /**
   * The quick-filter pseudo-column.
   *
   * `searchFilterModel` produces one entry whose conditions each name their OWN
   * column — it is "any of these columns contains this text", not a filter on a
   * column called `__search__`.
   *
   * Handled HERE rather than in toViewSpec because there are two callers: the
   * rows path and the count/aggregate/export path. Special-casing it in one of
   * them is what made the grid and the status bar disagree the last time.
   */
  if (colId === '__search__') {
    const conditions = (model.conditions ?? []).map((c) => ({
      column: c.colId, op: c.type ?? 'contains', value: c.filter,
    }));
    return conditions.length ? [{ op: 'or', conditions }] : [];
  }
  if (model.operator) {
    /**
     * AG-Grid's combined form.
     *
     * AND flattens into the filter list, because that list is ANDed anyway. OR
     * cannot: Perspective's filter array has no OR. It becomes a single `or`
     * node which the view translation turns into a computed boolean column.
     *
     * This used to throw. That was better than the alternative at the time —
     * silently dropping an OR branch shows a trader FEWER rows than they asked
     * for — but it meant an ordinary two-condition filter failed the block.
     */
    const parts = (model.conditions ?? []).flatMap((c) => filterModelToOps(colId, c));
    if (model.operator !== 'OR') return parts;
    return [{ op: 'or', conditions: parts }];
  }

  const t = model.filterType ?? 'text';
  if (t === 'set') {
    const values = model.values ?? [];
    // Empty set means NOTHING, not everything.
    if (values.length === 0) return [{ column: colId, op: 'in', value: [] }];
    return [{ column: colId, op: 'in', value: values }];
  }

  if (model.type === 'inRange') {
    return [{ column: colId, op: 'inRange', value: model.filter, valueTo: model.filterTo }];
  }
  // Text equality is case-INSENSITIVE in AG-Grid but case-sensitive in the
  // engine, so it translates to a folded comparison rather than a raw one.
  // contains/startsWith/endsWith need no such help — those are already
  // case-insensitive in Perspective, measured rather than assumed.
  if (t === 'text' && (model.type === 'equals' || model.type === 'notEqual')) {
    return [{ column: colId, op: `${model.type}IgnoreCase`, value: model.filter }];
  }

  // Perspective has no "not contains" OPERATOR, but its expression language has
  // `not()`. Excluding it from the menu was the right call while expressions
  // were unavailable; now that they are, the option can simply work.
  if (t === 'text' && model.type === 'notContains') {
    return [{ column: colId, op: 'notContains', value: model.filter }];
  }

  const op = OPS[model.type];
  if (!op) throw Object.assign(new Error(`filter type "${model.type}" on "${colId}" is not translatable`), { code: 'unsupported-expression' });
  return [{ column: colId, op, value: model.filter }];
}

/**
 * A grouped Perspective view returns `__ROW_PATH__`, not a field named after
 * the group column — and its first row is the ROOT (`__ROW_PATH__: []`), the
 * grand total over everything.
 *
 * AG-Grid expects neither. It wants the group value on the column it grouped
 * by, and it must never see the root as a sibling of the real groups. Passing
 * the raw rows through renders one blank row and nothing else.
 */
export function mapGroupRows(rows, groupColId) {
  if (!groupColId) return rows;
  const out = [];
  for (const r of rows) {
    const path = r.__ROW_PATH__;
    // No path at all means this is not a grouped result; leave it alone.
    if (path === undefined) { out.push(r); continue; }
    if (!Array.isArray(path) || path.length === 0) continue;   // the root
    out.push({ ...r, [groupColId]: path[path.length - 1] });
  }
  return out;
}

/**
 * The split column names present in a block, excluding the tree path.
 *
 * Taken from the DATA rather than computed from the pivot columns, because the
 * set of splits is whatever values actually occur — computing it would mean
 * knowing every currency in the book before reading it.
 */
export function pivotFieldsOf(rows) {
  const fields = new Set();
  for (const r of rows ?? []) {
    for (const k of Object.keys(r)) {
      if (k === '__ROW_PATH__' || !k.includes('|')) continue;
      fields.add(k);
    }
  }
  return [...fields];
}

/** Bounded view cache; evicting disposes, which is the whole point. */
export class ViewCache {
  constructor({ max = 20, dispose = async () => {} } = {}) {
    this.max = max;
    this.dispose = dispose;
    this.map = new Map();
    this.evictions = 0;
    /**
     * Handles currently being read from, by use count.
     *
     * getRows takes a handle from the cache and then awaits a window read. A
     * concurrent getRows can evict and dispose that very handle in between —
     * the read then fails against a deleted view and the block renders empty.
     * AG-Grid issues block loads concurrently, so this is a normal fast scroll,
     * not a rare interleaving.
     */
    this.inUse = new Map();
  }

  pin(v) { this.inUse.set(v, (this.inUse.get(v) ?? 0) + 1); }

  async unpin(v) {
    const n = (this.inUse.get(v) ?? 0) - 1;
    if (n > 0) { this.inUse.set(v, n); return; }
    this.inUse.delete(v);
    // Evicted while pinned: dispose now that the last reader is done.
    if (this.condemned?.delete(v)) { this.evictions++; await this.dispose(v); }
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key); this.map.set(key, v);   // refresh recency
    return v;
  }
  async set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      // Oldest first, but never the entry just inserted (with everything else
      // pinned it is the only unpinned candidate, and evicting it would throw
      // away the view this call exists to cache) and never one being read from.
      let victim = null;
      for (const [k, v] of this.map) {
        if (k === key || this.inUse.has(v)) continue;
        victim = [k, v];
        break;
      }
      if (!victim) break;   // all pinned: briefly over the cap beats a failed block
      this.map.delete(victim[0]);
      this.evictions++;
      await this.dispose(victim[1]);
    }
  }

  async clear() {
    for (const v of this.map.values()) {
      if (this.inUse.has(v)) { (this.condemned ??= new Set()).add(v); continue; }
      await this.dispose(v);
    }
    this.map.clear();
  }
  get size() { return this.map.size; }
}

export class SsrmMode {
  /**
   * @param {object} o
   * @param {object} o.dataService   hub-backed GridDataService
   * @param {object} o.artifact
   * @param {string[]} o.keyColumns
   * @param {string} [o.softDeleteColumn]
   * @param {number} [o.maxViews]
   */
  constructor({ dataService, artifact, keyColumns, softDeleteColumn, maxViews = 20 }) {
    this.mode = 'ssrm';
    this.dataService = dataService;
    this.artifact = artifact;
    this.keyColumns = keyColumns ?? artifact?.keyColumns ?? [];

    /**
     * Only honour a soft-delete column the TABLE actually has.
     *
     * CSRM tolerates a missing one silently — a filter on an absent field sees
     * `undefined`, which passes — so a misconfiguration survives all the way to
     * SSRM, where the predicate is pushed to the engine and Perspective rejects
     * the whole view with "Invalid column". Every getRows then fails and the
     * grid shows one blank row, with the real cause three layers away.
     */
    const known = new Set([
      ...(artifact?.columns ?? []).map((c) => c.column),
      ...(artifact?.columns ?? []).map((c) => c.id),
    ]);
    this.softDeleteColumn = softDeleteColumn && known.has(softDeleteColumn) ? softDeleteColumn : undefined;
    this.ignoredSoftDelete = Boolean(softDeleteColumn) && !this.softDeleteColumn;

    this.cache = new ViewCache({ max: maxViews, dispose: (v) => dataService.disposeView?.(v) });
    /**
     * Quick-filter state, held HERE rather than in the grid's filter model.
     *
     * `searchFilterModel` produces a `__search__` pseudo-column, and AG-Grid's
     * `setFilterModel` silently ignores entries for columns that do not exist —
     * so the search never reached `getRows` and the grid stayed unfiltered with
     * no error anywhere. CSRM does not hit this because it filters rows itself.
     *
     * Merged into every request instead, which also keeps it in the view-cache
     * signature: two different searches must not share a view.
     */
    this.searchModel = null;
    this.requests = 0;
    this.failures = 0;
    this.refreshes = 0;
    this.refreshTimer = null;
    this.pendingRefresh = false;
  }

  /**
   * Row identity, distinct for group rows and leaf rows.
   *
   * A group row and a leaf row can otherwise collide, and the leaf form must be
   * byte-identical to the hub's key encoding or transactions will not route
   * (parity study §2.3).
   */
  getRowId = (params) => {
    if (params.parentKeys?.length || params.level >= 0) {
      const groupCol = params.api?.getRowGroupColumns?.()?.[params.level]?.getColId?.();
      if (groupCol && params.data?.[groupCol] !== undefined) {
        return `g:${params.level}:${(params.parentKeys ?? []).join(SEPARATOR)}:${params.data[groupCol]}`;
      }
    }
    return `r:${rowKey(params.data, this.keyColumns)}`;
  };

  /**
   * Set (or clear) the quick filter.
   *
   * @param {object|null} filterModel a `searchFilterModel` result, or null
   * @param {object} [gridApi] refreshed automatically when given
   */
  setSearch(filterModel, gridApi = this.gridApi) {
    const next = filterModel && Object.keys(filterModel).length ? filterModel : null;
    if (JSON.stringify(next) === JSON.stringify(this.searchModel)) return;
    this.searchModel = next;
    // purge: the previous blocks were filtered differently and are now wrong.
    gridApi?.refreshServerSide?.({ purge: true });
  }

  /** The grid's filter model plus our quick filter. */
  effectiveFilterModel(req) {
    if (!this.searchModel) return req.filterModel ?? {};
    return { ...(req.filterModel ?? {}), ...this.searchModel };
  }

  /** @returns {object} an IServerSideDatasource */
  datasource() {
    return {
      getRows: (params) => this.getRows(params),
      destroy: () => this.cache.clear(),
    };
  }

  async getRows(params) {
    this.requests++;
    const req = params.request;
    let pinned = null;
    try {
      // The quick filter is merged in BEFORE both the spec and the signature,
      // so two different searches never share a cached view.
      const effective = { ...req, filterModel: this.effectiveFilterModel(req) };
      const spec = toViewSpec(effective, { softDeleteColumn: this.softDeleteColumn });
      const signature = requestSignature(effective);

      /**
       * Acquire PINNED.
       *
       * The pin has to be taken in the same synchronous step as the cache
       * lookup. Pinning after the insert leaves a window in which a concurrent
       * getRows evicts and disposes this very handle, and the read then fails
       * against a deleted view.
       */
      let handle = this.cache.get(signature);
      if (handle) {
        this.cache.pin(handle);
      } else {
        handle = await this.dataService.openView(spec);
        this.cache.pin(handle);              // before the insert, so set() cannot take it
        await this.cache.set(signature, handle);
      }
      pinned = handle;

      /**
       * A grouped Perspective view puts the ROOT (`__ROW_PATH__: []`, the grand
       * total) at index 0, so grid row N is view row N+1.
       *
       * Windowing first and dropping the root afterwards costs a row per block:
       * block [0,100) returns root + 99 groups, so the grid gets 99 rows for a
       * 100-row request, leaves a HOLE at index 99, and every later block is
       * shifted by one with one group never delivered at all.
       *
       * Invisible with a handful of groups — the demo has four desks — and
       * corrupting with any realistic grouping. So the offset belongs on the
       * REQUEST, not on the response.
       */
      const groupCol = spec.groupBy?.[0];
      const rootOffset = groupCol ? 1 : 0;

      const { rows, rowCount } = await this.dataService.readWindow(handle, {
        startRow: (req.startRow ?? 0) + rootOffset,
        endRow: req.endRow === undefined ? undefined : req.endRow + rootOffset,
      });

      // mapGroupRows still drops any root it sees: with endRow undefined the
      // whole view is read and the root is genuinely in the block.
      const rowData = mapGroupRows(rows, groupCol);

      /**
       * Pivot result fields.
       *
       * A split view names its columns `AUD|marketValue`. AG-Grid cannot guess
       * those — without `pivotResultFields` it renders no pivot columns at all
       * and the grid looks empty despite correct data. The separator is
       * Perspective's, so the grid must be told via
       * `serverSidePivotResultFieldSeparator: '|'`.
       */
      const result = { rowData, rowCount: Math.max(0, rowCount - rootOffset) };
      if (spec.splitBy?.length) {
        result.pivotResultFields = pivotFieldsOf(rows);
      }
      params.success(result);
    } catch (e) {
      this.failures++;
      // Keep it. Swallowing the cause entirely left every SSRM fault looking
      // identical from the outside — one blank row and nothing to go on.
      this.lastError = { message: String(e?.message ?? e), code: e?.code, at: Date.now() };
      // fail() rather than an empty success: an empty block reads as "no data
      // here" and the grid never retries.
      params.fail?.();
    } finally {
      if (pinned) await this.cache.unpin(pinned);
    }
  }

  /**
   * Live updates.
   *
   * SSRM has no delta path: the grid owns its blocks and the only way to show
   * new values is to re-fetch the loaded ones. Without this an SSRM blotter
   * renders the snapshot it started with and never changes again — on a
   * trading desk, silently wrong prices.
   *
   * `purge: false` keeps the rendered rows in place while the refetch runs, so
   * the grid does not blank out on every tick.
   *
   * Coalesced HARD, and deliberately slower than CSRM's transaction path: each
   * refresh re-reads every loaded block, so this is the expensive way to be
   * live and the interval is the throttle.
   */
  attach(control, gridApi, { refreshMs = 1000, setTimer = (fn, ms) => setTimeout(fn, ms), ref } = {}) {
    this.gridApi = gridApi;
    this.control = control;
    this.ref = ref ?? this.dataService?.ref;
    this.refreshMs = refreshMs;
    this.setTimer = setTimer;
    this.detach = control.on('rowDelta', () => this.onUpstreamChange());
    /**
     * Group-aggregate deltas (Phase 8e). When the hub is watching a grouped
     * view it sends `groupDelta` with the exact group paths that moved, so we
     * refresh only those routes immediately instead of re-reading every loaded
     * block on the 1 Hz timer. Both paths coexist: leaf-level changes still fall
     * back to the coarse refresh, group aggregates get the surgical one.
     */
    this.detachGroup = control.on('groupDelta', (m) => this.onGroupDelta(m));
    return () => {
      this.detach?.(); this.detachGroup?.();
      this.detach = null; this.detachGroup = null; this.refreshTimer = null;
    };
  }

  /**
   * Refresh exactly the group routes that changed — no timer, no full re-read.
   *
   * A group's aggregate is returned by its PARENT's getRows, so a changed group
   * refreshes its parent route; `routesToRefresh` collapses sibling changes into
   * one refresh of the shared parent. Ten desks ticking is one root refresh, not
   * ten and not a whole-tree purge.
   */
  /**
   * Tell the hub which grouping to watch for aggregate deltas (§8e).
   *
   * Call this when the grid's row grouping changes. The hub opens a matching
   * grouped view and forwards group deltas; without it, group aggregates fall
   * back to the coarse 1 Hz refresh. `control` and the last ref are captured at
   * attach().
   */
  watchGroups(groupBy, aggregates) {
    if (!this.control || !this.ref || !groupBy?.length) return;
    this.control.watchGroups(this.ref, groupBy, aggregates).catch(() => {});
  }

  onGroupDelta(msg) {
    if (!this.gridApi?.refreshServerSide) return;
    const routes = routesToRefresh((msg.changed ?? []).map((c) => c.path));
    for (const route of routes) this.gridApi.refreshServerSide({ route, purge: false });
    this.groupRefreshes = (this.groupRefreshes ?? 0) + routes.length;
  }

  onUpstreamChange() {
    this.pendingRefresh = true;
    if (this.refreshTimer !== null && this.refreshTimer !== undefined) return;
    this.refreshTimer = this.setTimer(() => {
      this.refreshTimer = null;
      if (!this.pendingRefresh) return;
      this.pendingRefresh = false;
      this.refresh();
    }, this.refreshMs);
    if (this.refreshTimer && typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();
  }

  refresh() {
    this.refreshes++;
    // purge:false — refetch in place rather than blanking the grid.
    this.gridApi?.refreshServerSide?.({ purge: false });
  }

  async destroy() {
    this.detach?.();
    this.detach = null;
    this.refreshTimer = null;
    await this.cache.clear();
  }
}
