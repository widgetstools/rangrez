/**
 * AG Grid SSRM request → the engine's view spec.
 *
 * This translation is where a server-side grid goes silently wrong: every
 * mistake here still renders rows, just not the right ones. So it lives in one
 * pure function with a test per filter shape, and every condition it cannot
 * translate is reported through {@link ToViewSpecResult.unsupported} instead of
 * being dropped — a filter the engine never sees shows MORE rows than the user
 * asked for.
 *
 * The four filter-model grammars AG Grid can send:
 *   - simple      `{ filterType: 'text'|'number'|'date', type, filter|dateFrom }`
 *   - combined    `{ operator: 'AND'|'OR', conditions: [...] }`
 *   - set         `{ filterType: 'set', values: [...] }`
 *   - multi       `{ filterType: 'multi', filterModels: [...] }` (ANDed slots)
 *
 * Two engine facts, both verified against the vendored WASM rather than read
 * off its typings, shape this file:
 *   - the sort direction key is `sort`, not `dir`;
 *   - a column the boot schema types as `date` is parsed to an epoch at WRITE
 *     time inside the engine (plan §12 T6), so date sorts order instants and
 *     date range filters send NUMERIC epoch bounds against the REAL column —
 *     the client-side `__epoch` shadow stamping this file used to target is
 *     retired.
 */
import {
  type SsrmFilterCondition,
  type SsrmFilterNode,
  type SsrmFilterOp,
  type SsrmGetRowsRequest,
  type SsrmViewSpec,
} from './ssrmTypes.js';

/**
 * AG Grid's text menu → engine operators.
 *
 * Text equality is case-INSENSITIVE in AG Grid and case-sensitive in the
 * engine, so it maps to the folded comparison; contains / startsWith /
 * endsWith are already folded engine-side.
 */
const TEXT_OPS: Record<string, SsrmFilterOp> = {
  contains: 'contains',
  notContains: 'notContains',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  equals: 'equalsIgnoreCase',
  notEqual: 'notEqualIgnoreCase',
  blank: 'blank',
  notBlank: 'notBlank',
};

/** Number / date menu → engine operators (no case folding). */
const SCALAR_OPS: Record<string, SsrmFilterOp> = {
  equals: 'equals',
  notEqual: 'notEqual',
  greaterThan: 'greaterThan',
  greaterThanOrEqual: 'greaterThanOrEqual',
  lessThan: 'lessThan',
  lessThanOrEqual: 'lessThanOrEqual',
  blank: 'blank',
  notBlank: 'notBlank',
};

const VALUELESS_OPS = new Set<SsrmFilterOp>(['blank', 'notBlank']);

const DAY_MS = 86_400_000;

interface FilterModelEntry {
  filterType?: string;
  type?: string;
  operator?: 'AND' | 'OR';
  conditions?: FilterModelEntry[];
  /** `agMultiColumnFilter` — one slot per configured sub-filter, null when unset. */
  filterModels?: (FilterModelEntry | null)[];
  filter?: unknown;
  filterTo?: unknown;
  values?: unknown[];
  dateFrom?: string | null;
  dateTo?: string | null;
}

export interface ToViewSpecOptions {
  /**
   * Columns the quick filter searches. AG Grid never sends a quick filter for
   * SSRM (it has no rows to scan), so the surface forwards the text and it
   * becomes an OR of `contains` across these columns.
   */
  searchColumns?: readonly string[];
  /**
   * Columns the boot schema types as dates. Their filter models use AG Grid's
   * calendar-day grammar, so they translate to numeric epoch DAY ranges — the
   * engine compares them against the epoch it parsed at write time.
   */
  dateColumns?: readonly string[];
}

export interface ToViewSpecResult {
  spec: SsrmViewSpec;
  /** Human-readable descriptions of conditions with no engine translation. */
  unsupported: string[];
}

/**
 * The UTC day AG Grid's `YYYY-MM-DD HH:mm:ss` bound names, as an epoch range.
 * Date-only strings parse as UTC midnight, so UTC day bounds line up with
 * them exactly; the time part of the bound is ignored because AG Grid's date
 * menu is a calendar-day comparison.
 */
function dayRange(raw: string): { start: number; end: number } | null {
  const start = Date.parse(`${raw.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(start)) return null;
  return { start, end: start + DAY_MS - 1 };
}

/** One column's filter model → engine nodes (ANDed unless an `or` node). */
export function filterModelToNodes(
  colId: string,
  model: FilterModelEntry | null | undefined,
  unsupported: string[],
  isDateColumn = false,
): SsrmFilterNode[] {
  if (!model || typeof model !== 'object') return [];

  // Multi filter: independent slots that AG Grid ANDs. Absent slots are null.
  // Our stream-safe floating filters emit exactly this envelope for
  // `agMultiColumnFilter` columns (see buildMultiEnvelope).
  if (Array.isArray(model.filterModels)) {
    return model.filterModels.flatMap((slot) => filterModelToNodes(colId, slot, unsupported, isDateColumn));
  }

  if (model.operator || Array.isArray(model.conditions)) {
    const parts = (model.conditions ?? []).flatMap(
      (c) => filterModelToNodes(colId, c, unsupported, isDateColumn),
    );
    // AND flattens into the top-level list, which is ANDed anyway. OR cannot.
    if (model.operator !== 'OR') return parts;
    return parts.length > 0 ? [{ op: 'or', conditions: parts }] : [];
  }

  const kind = model.filterType ?? 'text';

  if (kind === 'set') {
    const values = model.values ?? [];
    // An empty selection means NOTHING, not everything — the difference
    // between an empty grid and an unfiltered one.
    if (values.length === 0) return [{ column: colId, op: 'in', value: [] }];
    // A grouped view in the engine applies `in` to the group rows (which
    // don't carry the filtered column), so the root request comes back
    // empty. `equals` is evaluated on the leaves before grouping.
    const eq = (value: unknown): SsrmFilterCondition => ({
      column: colId,
      op: typeof value === 'string' ? 'equalsIgnoreCase' : 'equals',
      value,
    });
    if (values.length === 1) return [eq(values[0])];
    return [{ op: 'or', conditions: values.map(eq) }];
  }

  if (kind === 'date' && isDateColumn) return dateNodes(colId, model, unsupported);

  if (model.type === 'inRange') {
    const isDate = kind === 'date';
    return [{
      column: colId,
      op: 'inRange',
      value: isDate ? model.dateFrom : model.filter,
      valueTo: isDate ? model.dateTo : model.filterTo,
    }];
  }

  const op = model.type ? (kind === 'text' ? TEXT_OPS : SCALAR_OPS)[model.type] : undefined;
  if (!op) {
    unsupported.push(`${colId}: ${String(model.type)} (${kind})`);
    return [];
  }
  if (VALUELESS_OPS.has(op)) return [{ column: colId, op }];

  return [{
    column: colId,
    op,
    value: kind === 'date' ? model.dateFrom : model.filter,
  }];
}

/**
 * AG Grid's date menu is a DAY comparison: `equals` means the same calendar
 * day, `greaterThan` means after that day. Each day becomes a numeric epoch
 * range against the REAL column — the engine's typed date columns compare
 * numeric bounds against the epoch parsed at write time (plan §12 T6).
 */
function dateNodes(
  colId: string,
  model: FilterModelEntry,
  unsupported: string[],
): SsrmFilterNode[] {
  const type = model.type;
  if (type === 'blank' || type === 'notBlank') return [{ column: colId, op: type }];
  const epoch = colId;
  const from = typeof model.dateFrom === 'string' ? dayRange(model.dateFrom) : null;
  if (!from) {
    unsupported.push(`${colId}: ${String(type)} (date without a bound)`);
    return [];
  }
  const cond = (op: SsrmFilterOp, value: number, valueTo?: number): SsrmFilterCondition =>
    (valueTo === undefined ? { column: epoch, op, value } : { column: epoch, op, value, valueTo });
  switch (type) {
    case 'equals': return [cond('inRange', from.start, from.end)];
    case 'notEqual':
      return [{ op: 'or', conditions: [cond('lessThan', from.start), cond('greaterThan', from.end)] }];
    case 'lessThan': return [cond('lessThan', from.start)];
    case 'lessThanOrEqual': return [cond('lessThanOrEqual', from.end)];
    case 'greaterThan': return [cond('greaterThan', from.end)];
    case 'greaterThanOrEqual': return [cond('greaterThanOrEqual', from.start)];
    case 'inRange': {
      const to = (typeof model.dateTo === 'string' ? dayRange(model.dateTo) : null) ?? from;
      return [cond('inRange', from.start, to.end)];
    }
    default:
      unsupported.push(`${colId}: ${String(type)} (date)`);
      return [];
  }
}

/**
 * Build the view spec for one `getRows` request.
 *
 * Grouping is the subtle rule: AG Grid asks for ONE level at a time.
 * `groupKeys` is the path already expanded, so its length is the depth and the
 * next level is the row-group column at that index.
 */
export function toViewSpecResult(
  req: SsrmGetRowsRequest,
  opts: ToViewSpecOptions = {},
): ToViewSpecResult {
  const unsupported: string[] = [];
  const filter: SsrmFilterNode[] = [];
  const groupKeys = req.groupKeys ?? [];
  const rowGroupCols = req.rowGroupCols ?? [];
  const dateColumns = new Set(opts.dateColumns ?? []);

  // The expanded path becomes one equality filter per level.
  groupKeys.forEach((value, i) => {
    const col = rowGroupCols[i];
    if (col) filter.push({ column: col.id, op: 'equals', value });
  });

  for (const [colId, model] of Object.entries(req.filterModel ?? {})) {
    filter.push(...filterModelToNodes(colId, model as FilterModelEntry, unsupported, dateColumns.has(colId)));
  }

  // AG Grid's quick filter splits on whitespace and requires EVERY word to
  // match SOME column, so "gov apac" finds a Govies desk in APAC even though
  // no single cell holds both words. One OR node per word; the list is ANDed.
  const text = req.quickFilterText?.trim();
  if (text) {
    const cols = opts.searchColumns ?? [];
    if (cols.length === 0) {
      unsupported.push(`quick filter "${text}" (no searchColumns configured)`);
    } else {
      for (const word of text.split(/\s+/).filter(Boolean)) {
        filter.push({
          op: 'or',
          conditions: cols.map((column) => ({ column, op: 'contains' as const, value: word })),
        });
      }
    }
  }

  const spec: SsrmViewSpec = {
    filter,
    // Date columns sort by the epoch the engine parsed at write time — the
    // sort names the real column, the engine substitutes the instant.
    sort: (req.sortModel ?? []).map((s) => ({ column: s.colId, sort: s.sort })),
  };
  if (req.computedColumns?.length) {
    spec.computed = req.computedColumns.map((c) => ({ as: c.as, expr: c.expr }));
  }

  const next = rowGroupCols[groupKeys.length];
  if (next) {
    spec.groupBy = [next.id];
    spec.aggregates = {};
    for (const v of req.valueCols ?? []) spec.aggregates[v.id] = v.aggFunc ?? 'sum';
    spec.depth = 1;
  }

  if (req.pivotMode && (req.pivotCols ?? []).length > 0) {
    // A pivot with no row groups is the grand-total pivot: the engine
    // serves it as one row splitting every aggregate (plan §12 T7). The
    // grouping branch above only runs when there IS a next group level, so
    // the value columns must become aggregates here too — a split with no
    // aggregates yields a row of nothing but `__count`.
    spec.splitBy = req.pivotCols!.map((c) => c.id);
    spec.columns = (req.valueCols ?? []).map((c) => c.id);
    if (!spec.aggregates) {
      spec.aggregates = {};
      for (const v of req.valueCols ?? []) spec.aggregates[v.id] = v.aggFunc ?? 'sum';
    }
  }

  return { spec, unsupported };
}

/** Spec only — callers that don't report unsupported conditions. */
export function toViewSpec(
  req: SsrmGetRowsRequest,
  opts: ToViewSpecOptions = {},
): SsrmViewSpec {
  return toViewSpecResult(req, opts).spec;
}
