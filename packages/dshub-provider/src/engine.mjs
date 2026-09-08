/**
 * THE SEAM (architecture §8.1).
 *
 * One module with concrete signatures — not an interface hierarchy, not a
 * plugin registry. Swapping Perspective for another engine later touches this
 * file and nothing else.
 *
 * `ViewSpec` is OUR shape (filters, groupBy, sort, aggregates, expressions).
 * The adapter translates. AG-Grid mode adapters never see Perspective types,
 * and the hub never sees AG-Grid types.
 *
 * This is the one interface in the codebase with a single implementation, and
 * the plan's leanness checkpoint calls that out as deliberate.
 */

/**
 * @typedef {object} EngineAdapter
 * @property {(name: string) => Promise<object>} openTable
 * @property {(t: object, spec: object) => Promise<object>} createView
 * @property {(v: object, range: object) => Promise<object>} readWindow
 * @property {(v: object, cb: Function) => Function} onUpdate
 * @property {(v: object) => Promise<object>} schema
 * @property {(v: object) => Promise<void>} dispose
 */

// The translation lives in the spec package: the hub needs it too, and two
// copies would drift. Re-exported so existing imports keep working.
export { toPerspectiveFilter, toPerspectiveViewConfig } from '../../dshub-spec/src/viewspec.mjs';
import { toPerspectiveViewConfig } from '../../dshub-spec/src/viewspec.mjs';

/** @returns {EngineAdapter} */
export function createPerspectiveAdapter(client) {
  return {
    async openTable(name) {
      return client.open_table(name);
    },

    async createView(table, spec) {
      return table.view(toPerspectiveViewConfig(spec));
    },

    /**
     * Window read. `to_columns` returns column-oriented data; the caller pivots
     * only if it needs rows, because at 372 columns the pivot is the expensive
     * part and most callers do not need it.
     */
    async readWindow(view, { startRow = 0, endRow } = {}) {
      return view.to_columns(endRow === undefined ? {} : { start_row: startRow, end_row: endRow });
    },

    /**
     * Deltas.
     *
     * REMOVALS DO NOT ARRIVE HERE. A row deleted upstream, or one that filters
     * out of this view, simply stops being present — there is no delta to map
     * to an AG-Grid `remove` (architecture §8.4). The soft-delete flag is what
     * makes a removal observable, because the flag flip IS an update.
     */
    onUpdate(view, cb) {
      const handle = view.on_update(cb, { mode: 'row' });
      return () => { try { view.remove_update?.(handle); } catch { /* already gone */ } };
    },

    async schema(view) { return view.schema(); },

    /** Views before tables — Perspective throws otherwise. */
    async dispose(view) { await view.delete(); },
  };
}

/** Column-oriented block -> row objects. Only when rows are actually needed. */
export function pivotToRows(columns) {
  const names = Object.keys(columns);
  if (names.length === 0) return [];
  const n = columns[names[0]].length;
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = {};
    for (const name of names) r[name] = columns[name][i];
    rows[i] = r;
  }
  return rows;
}
