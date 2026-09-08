/**
 * GridDataService — the parity layer.
 *
 * "The actual deliverable of the parity work. The AG-Grid datasource
 * implementation is the easy half." (parity study §6)
 *
 * Blotter code, toolbars, status bars and the config chatbot all call THIS.
 * Nothing downstream branches on mode: CSRM answers locally from row data,
 * SSRM/VRM go to the hub over control RPC, and both satisfy the same contract.
 *
 * The CSRM implementation is written first on purpose — it unblocks every piece
 * of UI work with zero hub dependency, and it defines the reference semantics
 * the SSRM implementation must reproduce.
 */

import { rowPredicate, searchPredicate, searchFilterModel, sortRows, comparator, isBlank } from './filter.mjs';
import { rowKey } from '../../dshub-spec/src/rowkey.mjs';

/**
 * @typedef {object} GridDataService
 * @property {'csrm'|'ssrm'|'vrm'} mode
 * @property {(colId: string, ctx?: object) => Promise<unknown[]>} getDistinctValues
 * @property {(colId: string, prefix: string, limit: number) => Promise<unknown[]>} searchValues
 * @property {(filter?: object) => Promise<number>} getRowCount
 * @property {(specs: object[], filter?: object) => Promise<Record<string, number>>} getAggregates
 * @property {(text: string, cols?: string[]) => object} search
 * @property {(fmt: 'csv'|'xlsx', view: object) => Promise<Blob>} exportAll
 * @property {(view: object) => Promise<string>} copyAll
 * @property {(view: object, cb: (rows: unknown[]) => void) => Promise<void>} scanAll
 * @property {(view: object, limit: number) => Promise<unknown[]>} snapshotForChart
 * @property {(key: string, view: object) => Promise<number|null>} rankOf
 * @property {(state: object, view: object) => Promise<object>} resolveSelection
 */

const AGG = {
  sum:   (vals) => vals.reduce((a, b) => a + b, 0),
  min:   (vals) => (vals.length ? Math.min(...vals) : null),
  max:   (vals) => (vals.length ? Math.max(...vals) : null),
  avg:   (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null),
  count: (vals) => vals.length,
  first: (vals) => (vals.length ? vals[0] : null),
  last:  (vals) => (vals.length ? vals.at(-1) : null),
};

/** CSV escaping: quote when the value contains a delimiter, quote or newline. */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class CsrmDataService {
  /**
   * @param {object} o
   * @param {() => object[]} o.getRows        current client-side row data
   * @param {object} o.artifact               schema artifact
   * @param {string[]} o.keyColumns
   * @param {string} [o.softDeleteColumn]
   * @param {string[]} [o.searchColumns]      quick-filter subset; never all 372
   */
  constructor({ getRows, artifact, keyColumns, softDeleteColumn, searchColumns }) {
    this.mode = 'csrm';
    this._getRows = getRows;
    this.artifact = artifact;
    this.keyColumns = keyColumns ?? artifact?.keyColumns ?? [];
    this.softDeleteColumn = softDeleteColumn;
    this.searchColumns = searchColumns
      ?? artifact?.columns?.filter((c) => c.type === 'string' && c.filter === 'set').map((c) => c.column)
      ?? [];
  }

  /** Soft-deleted rows are still in the table; they are not part of the data. */
  rows() {
    const all = this._getRows() ?? [];
    if (!this.softDeleteColumn) return all;
    return all.filter((r) => r[this.softDeleteColumn] !== true);
  }

  /** Apply a FilterModel, including the search pseudo-column. */
  applyFilter(rows, filterModel) {
    if (!filterModel || Object.keys(filterModel).length === 0) return rows;
    const { __search__, ...rest } = filterModel;
    let out = rows;
    if (Object.keys(rest).length) out = out.filter(rowPredicate(rest));
    if (__search__) out = out.filter(searchPredicate(__search__));
    return out;
  }

  /** Resolve a ViewSpec (filter + sort) the same way both modes must. */
  resolve(view = {}) {
    let rows = this.applyFilter(this.rows(), view.filter ?? view.filterModel);
    if (view.sort ?? view.sortModel) rows = sortRows(rows, view.sort ?? view.sortModel);
    return rows;
  }

  columnFor(colId) {
    const c = this.artifact?.columns?.find((x) => x.id === colId || x.column === colId);
    return c?.column ?? colId;
  }

  // ------------------------------------------------------------ set filters

  /**
   * Distinct values for a set filter.
   *
   * `ctx` is the cascading-values case: the filter model MINUS this column's own
   * filter, so the list narrows with other filters the way CSRM does natively
   * (parity study §1.5).
   */
  async getDistinctValues(colId, ctx) {
    const col = this.columnFor(colId);
    const scope = ctx ? this.applyFilter(this.rows(), ctx) : this.rows();
    const seen = new Set();
    for (const r of scope) seen.add(isBlank(r[col]) ? null : r[col]);
    return [...seen].sort(comparator);
  }

  async searchValues(colId, prefix, limit = 100) {
    const col = this.columnFor(colId);
    const p = String(prefix ?? '').toLowerCase();
    const seen = new Set();
    for (const r of this.rows()) {
      const v = r[col];
      if (isBlank(v)) continue;
      if (String(v).toLowerCase().startsWith(p)) seen.add(v);
      if (seen.size >= limit) break;
    }
    return [...seen].sort(comparator);
  }

  // ------------------------------------------------------------ counts

  async getRowCount(filter) {
    return this.applyFilter(this.rows(), filter).length;
  }

  /**
   * Status-bar and footer aggregates.
   *
   * Weighted aggregations are expressed as `{ fn: 'weightedAvg', column, weight }`
   * because Perspective has no native weighted mean (phase-0-findings §4) and the
   * hub-side answer is the sum decomposition. Doing the same here keeps CSRM and
   * SSRM numerically identical rather than merely close.
   */
  async getAggregates(specs, filter) {
    const rows = this.applyFilter(this.rows(), filter);
    const out = {};
    for (const spec of specs ?? []) {
      const col = this.columnFor(spec.column);
      const name = spec.as ?? `${spec.fn}(${spec.column})`;

      if (spec.fn === 'weightedAvg') {
        const w = this.columnFor(spec.weight);
        let num = 0, den = 0;
        for (const r of rows) {
          const x = Number(r[col]); const wt = Number(r[w]);
          if (Number.isFinite(x) && Number.isFinite(wt)) { num += x * wt; den += wt; }
        }
        out[name] = den === 0 ? null : num / den;
        continue;
      }

      const fn = AGG[spec.fn];
      if (!fn) throw new Error(`unsupported aggregate "${spec.fn}"`);
      const vals = spec.fn === 'count'
        ? rows
        : rows.map((r) => Number(r[col])).filter(Number.isFinite);
      out[name] = fn(vals);
    }
    return out;
  }

  // ------------------------------------------------------------ search

  /**
   * Quick-filter replacement. Returns a FilterModel rather than filtering, so
   * the identical call works in SSRM where quick filter does not exist at all.
   */
  search(text, cols) {
    return searchFilterModel(text, cols ?? this.searchColumns);
  }

  // ------------------------------------------------------------ whole dataset

  async exportAll(fmt, view) {
    const rows = this.resolve(view);
    const cols = view?.columns ?? this.artifact.columns.filter((c) => c.colDef?.hide !== true).map((c) => c.column);
    if (fmt === 'csv') {
      const head = cols.join(',');
      const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n');
      const text = `${head}\n${body}\n`;
      return typeof Blob !== 'undefined' ? new Blob([text], { type: 'text/csv' }) : text;
    }
    throw new Error(`export format "${fmt}" is not supported client-side; route to the hub`);
  }

  async copyAll(view) {
    const rows = this.resolve(view);
    const cols = view?.columns ?? this.artifact.columns.filter((c) => c.colDef?.hide !== true).map((c) => c.column);
    // Tab-separated: what spreadsheets expect from the clipboard.
    return [cols.join('\t'), ...rows.map((r) => cols.map((c) => (r[c] ?? '')).join('\t'))].join('\n');
  }

  /**
   * The SSRM replacement for `forEachNode`, which only ever sees loaded rows.
   * Batched so the CSRM and hub implementations present the same callback shape.
   */
  async scanAll(view, cb, { batchRows = 1000 } = {}) {
    const rows = this.resolve(view);
    for (let i = 0; i < rows.length; i += batchRows) cb(rows.slice(i, i + batchRows));
  }

  async snapshotForChart(view, limit = 10_000) {
    return this.resolve(view).slice(0, limit);
  }

  // ------------------------------------------------------------ navigation

  /**
   * Index of a row under the current sort and filter — what
   * `ensureIndexVisible` needs, and which SSRM cannot answer locally.
   */
  async rankOf(key, view) {
    const rows = this.resolve(view);
    const i = rows.findIndex((r) => this.keyOf(r) === key);
    return i < 0 ? null : i;
  }

  keyOf(row) {
    if (row.__key !== undefined) return row.__key;
    //  cannot occur in data; '-' collides with hyphenated ids.
    return this.keyColumns.map((c) => row[c]).join('');
  }

  /**
   * Selection as a PREDICATE plus exceptions, not a row list.
   *
   * SSRM's select-all spans unloaded rows, so any action on a selection has to
   * send the predicate rather than ids (parity study §2.5). CSRM resolves it
   * eagerly, but returns the same shape so callers never branch.
   */
  async resolveSelection(state, view) {
    const rows = this.resolve(view);
    const toggled = new Set(state?.toggledNodes ?? []);
    const selected = state?.selectAll
      ? rows.filter((r) => !toggled.has(this.keyOf(r)))
      : rows.filter((r) => toggled.has(this.keyOf(r)));
    return {
      selectAll: !!state?.selectAll,
      toggledNodes: [...toggled],
      count: selected.length,
      keys: selected.map((r) => this.keyOf(r)),
      view,
    };
  }
}
