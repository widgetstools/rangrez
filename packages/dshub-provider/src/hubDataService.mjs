/**
 * HubDataService — the SSRM/VRM half of the parity layer.
 *
 * Satisfies exactly the same contract as CsrmDataService (parity study §6), so
 * blotter code, toolbars, status bars and the config chatbot never branch on
 * mode. CSRM answers locally from row data; this one goes to the hub over
 * control RPC.
 *
 * Where CSRM defines the reference SEMANTICS, this defines the reference
 * PLUMBING: caching, single-flight, and the cardinality guard that stops a set
 * filter shipping 500k values to the browser.
 */

import { searchFilterModel } from './filter.mjs';
import { filterModelToOps } from './modes/ssrm.mjs';

/**
 * Distinct-value cache (parity study §1.3).
 *
 * Keyed on (colId, contextHash) with a short TTL, and SINGLE-FLIGHT: several
 * grids opening the same filter at once share one in-flight request rather than
 * starting a stampede against the hub.
 */
class DistinctCache {
  constructor({ ttlMs = 30_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
    this.inflight = new Map();
    this.hits = 0;
    this.misses = 0;
    this.coalesced = 0;
  }

  key(colId, ctx) { return `${colId}::${ctx ? JSON.stringify(ctx) : ''}`; }

  async get(colId, ctx, load) {
    const k = this.key(colId, ctx);
    const hit = this.entries.get(k);
    if (hit && this.now() - hit.at < this.ttlMs) { this.hits++; return hit.values; }

    const pending = this.inflight.get(k);
    if (pending) { this.coalesced++; return pending; }

    this.misses++;
    const p = load().then((values) => {
      this.entries.set(k, { values, at: this.now() });
      this.inflight.delete(k);
      return values;
    }).catch((e) => { this.inflight.delete(k); throw e; });
    this.inflight.set(k, p);
    return p;
  }

  /**
   * Invalidate every OTHER column when a filter changes — the cascading-values
   * behaviour CSRM has natively (parity study §1.5). Only the columns that
   * opted in pay this.
   */
  invalidateExcept(colId) {
    for (const k of [...this.entries.keys()]) {
      if (!k.startsWith(`${colId}::`)) this.entries.delete(k);
    }
  }

  clear() { this.entries.clear(); }
}

export class HubDataService {
  /**
   * @param {object} o
   * @param {object} o.control   ControlClient
   * @param {object} o.ref       subscription ref — must match the one subscribed
   * @param {object} o.artifact
   * @param {'ssrm'|'vrm'} [o.mode]
   */
  constructor({ control, ref, artifact, mode = 'ssrm', keyColumns, softDeleteColumn, searchColumns, ttlMs }) {
    this.mode = mode;
    this.control = control;
    this.ref = ref;
    this.artifact = artifact;
    this.keyColumns = keyColumns ?? artifact?.keyColumns ?? [];
    this.softDeleteColumn = softDeleteColumn;
    this.searchColumns = searchColumns
      ?? artifact?.columns?.filter((c) => c.type === 'string' && c.filter === 'set').map((c) => c.column)
      ?? [];
    this.cache = new DistinctCache(ttlMs ? { ttlMs } : {});
  }

  columnFor(colId) {
    const c = this.artifact?.columns?.find((x) => x.id === colId || x.column === colId);
    return c ?? null;
  }

  // ------------------------------------------------------------ view lifecycle
  // Used by SsrmMode; not part of the GridDataService contract.

  async openView(spec) {
    const r = await this.control.request({ type: 'openView', ref: this.ref, view: spec });
    return { viewId: r.payload.viewId };
  }

  async readWindow(handle, { startRow = 0, endRow } = {}) {
    const r = await this.control.request({ type: 'readWindow', viewId: handle.viewId, startRow, endRow });
    const { columns, rowCount } = r.payload;
    return { rows: pivot(columns), rowCount };
  }

  /**
   * Expand or collapse a tree node by ROW INDEX — the VRM mechanism.
   *
   * Returns the new row count, because expanding changes the length of the flat
   * list the viewport indexes into.
   */
  async expandRow(handle, index, collapse = false) {
    const r = await this.control.request({ type: 'expandRow', viewId: handle.viewId, index, collapse });
    return r.payload;
  }

  async disposeView(handle) {
    if (!handle?.viewId) return;
    await this.control.request({ type: 'disposeView', viewId: handle.viewId });
  }

  // ------------------------------------------------------------ set filters

  /**
   * Distinct values, with the CARDINALITY GUARD.
   *
   * Past ~10k distinct values AG-Grid ships the whole list to the browser and
   * the UX degrades regardless of virtualization (parity study §1.4). The
   * artifact already records observed cardinality, so a column that should be
   * search-select is refused here rather than quietly returning 500k values.
   */
  async getDistinctValues(colId, ctx) {
    const col = this.columnFor(colId);
    if (col?.filter === 'search-select') {
      throw Object.assign(
        new Error(`"${colId}" has ~${col.cardinality} distinct values; use searchValues, not a set filter`),
        { code: 'invalid-params' }
      );
    }
    return this.cache.get(colId, ctx, async () => {
      const r = await this.control.request({
        type: 'distinctValues', ref: this.ref, colId,
        contextFilter: ctx ? toFilterOps(ctx) : undefined, limit: 10_000,
      });
      return r.payload;
    });
  }

  async searchValues(colId, prefix, limit = 100) {
    const r = await this.control.request({ type: 'searchValues', ref: this.ref, colId, prefix, limit });
    return r.payload;
  }

  /** Called on filterChanged so cascading columns narrow the way CSRM does. */
  onFilterChanged(changedColId) { this.cache.invalidateExcept(changedColId); }

  // ------------------------------------------------------------ counts

  async getRowCount(filter) {
    const r = await this.control.request({ type: 'rowCount', ref: this.ref, view: { filter: toFilterOps(filter) } });
    return r.payload;
  }

  async getAggregates(specs, filter) {
    const r = await this.control.request({
      type: 'aggregates', ref: this.ref,
      specs: (specs ?? []).map((s) => ({ column: s.column, fn: s.fn, as: s.as })),
      view: { filter: toFilterOps(filter) },
    });
    return r.payload;
  }

  // ------------------------------------------------------------ search

  /** Same shape as CSRM: a FilterModel, not filtered rows. */
  search(text, cols) { return searchFilterModel(text, cols ?? this.searchColumns); }

  // ------------------------------------------------------------ whole dataset

  async scanAll(view, cb, { batchRows = 2000 } = {}) {
    await this.control.request(
      { type: 'scan', ref: this.ref, view: { filter: toFilterOps(view?.filter), sort: view?.sort }, batchRows },
      { timeoutMs: 300_000, onPartial: ({ block }) => cb(pivot(block)) }
    );
  }

  async exportAll(fmt, view) {
    const rows = [];
    await this.scanAll(view, (batch) => rows.push(...batch));
    const cols = view?.columns ?? this.artifact.columns.filter((c) => c.colDef?.hide !== true).map((c) => c.column);
    const cell = (v) => {
      if (v === null || v === undefined) return '';
      const s = v instanceof Date ? v.toISOString() : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const text = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
    return typeof Blob !== 'undefined' ? new Blob([text], { type: 'text/csv' }) : text;
  }

  async copyAll(view) {
    const rows = [];
    await this.scanAll(view, (batch) => rows.push(...batch));
    const cols = view?.columns ?? this.artifact.columns.filter((c) => c.colDef?.hide !== true).map((c) => c.column);
    return [cols.join('\t'), ...rows.map((r) => cols.map((c) => r[c] ?? '').join('\t'))].join('\n');
  }

  async snapshotForChart(view, limit = 10_000) {
    const rows = [];
    await this.scanAll(view, (batch) => { if (rows.length < limit) rows.push(...batch); });
    return rows.slice(0, limit);
  }

  // ------------------------------------------------------------ navigation

  /** Server-side rank; SSRM cannot answer this locally (parity study §3). */
  async rankOf(key, view) {
    const r = await this.control.request({ type: 'rank', ref: this.ref, key, view });
    return r.payload;
  }

  /**
   * Selection stays a PREDICATE plus exceptions.
   *
   * SSRM select-all spans rows that were never loaded, so an action on the
   * selection must send the predicate — resolving to a key list here would
   * silently drop everything unloaded (parity study §2.5).
   */
  async resolveSelection(state, view) {
    return {
      selectAll: !!state?.selectAll,
      toggledNodes: state?.toggledNodes ?? [],
      view,
      // Deliberately NOT a key list: the hub applies the predicate.
      resolvedServerSide: true,
    };
  }
}

/** Column-oriented block -> rows. */
function pivot(columns) {
  const names = Object.keys(columns ?? {});
  if (!names.length) return [];
  const n = columns[names[0]].length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = {};
    for (const name of names) r[name] = columns[name][i];
    out[i] = r;
  }
  return out;
}

/**
 * FilterModel -> engine ops.
 *
 * This used to be a SECOND, simpler translator living here, and it disagreed
 * with the one SsrmMode uses for `getRows`. Anything it did not understand —
 * AG-Grid's combined AND/OR form, and the quick-search pseudo-column — it
 * returned `[]` for, i.e. NO FILTER.
 *
 * The grid rows were therefore filtered correctly while the row count,
 * aggregates, export and copy-all silently reported over the whole dataset. A
 * trader exporting "my filtered view" got all 20,000 rows and nothing said so.
 *
 * There is now one translator. Where it cannot express something it THROWS, and
 * the caller surfaces the failure — being loudly unsupported is recoverable,
 * being quietly wrong about a book is not.
 */
function toFilterOps(filterModel) {
  if (!filterModel) return [];
  if (Array.isArray(filterModel)) return filterModel;   // already ops
  const out = [];
  for (const [colId, model] of Object.entries(filterModel)) {
    for (const op of filterModelToOps(colId, model)) out.push(op);
  }
  return out;
}

export { toFilterOps, pivot };
