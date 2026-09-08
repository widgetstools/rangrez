/**
 * AG-Grid FilterModel semantics — the single definition, used by CSRM directly
 * and targeted by the SSRM translator later.
 *
 * Every rule here is a place CSRM and SSRM can silently disagree. The parity
 * study calls these out as "the accumulated small divergences" that unit tests
 * on the translator alone will not catch: blank handling, case sensitivity,
 * range inclusivity, empty-set meaning.
 *
 * Writing them ONCE and having CSRM evaluate exactly this is what makes the
 * later parity harness meaningful — otherwise it compares two guesses.
 */

/** AG-Grid text filters are case-INSENSITIVE by default. */
const norm = (v) => (v === null || v === undefined ? null : String(v).toLowerCase());

/**
 * "Blank" means null, undefined, or empty string.
 *
 * Distinguishing null from empty string matters at ingest (architecture §5.2
 * keeps absent and null distinct), but AG-Grid's blank filter treats them
 * alike, and SSRM must therefore do the same.
 */
export const isBlank = (v) => v === null || v === undefined || v === '';

const TEXT = {
  equals: (v, f) => norm(v) === norm(f),
  notEqual: (v, f) => norm(v) !== norm(f),
  contains: (v, f) => norm(v) !== null && norm(v).includes(norm(f)),
  notContains: (v, f) => norm(v) === null || !norm(v).includes(norm(f)),
  startsWith: (v, f) => norm(v) !== null && norm(v).startsWith(norm(f)),
  endsWith: (v, f) => norm(v) !== null && norm(v).endsWith(norm(f)),
  blank: (v) => isBlank(v),
  notBlank: (v) => !isBlank(v),
};

const NUMBER = {
  equals: (v, f) => Number(v) === Number(f),
  notEqual: (v, f) => Number(v) !== Number(f),
  greaterThan: (v, f) => Number(v) > Number(f),
  greaterThanOrEqual: (v, f) => Number(v) >= Number(f),
  lessThan: (v, f) => Number(v) < Number(f),
  lessThanOrEqual: (v, f) => Number(v) <= Number(f),
  // inRange is INCLUSIVE at both ends in AG-Grid. Getting this wrong drops
  // boundary rows in one mode and keeps them in the other.
  inRange: (v, f, t) => Number(v) >= Number(f) && Number(v) <= Number(t),
  blank: (v) => isBlank(v),
  notBlank: (v) => !isBlank(v),
};

const asTime = (v) => {
  if (v === null || v === undefined || v === '') return NaN;
  const d = v instanceof Date ? v : new Date(v);
  return d.getTime();
};

const DATE = {
  equals: (v, f) => asTime(v) === asTime(f),
  notEqual: (v, f) => asTime(v) !== asTime(f),
  greaterThan: (v, f) => asTime(v) > asTime(f),
  lessThan: (v, f) => asTime(v) < asTime(f),
  // The server translator accepts these, so CSRM must evaluate them too. A
  // column configured with custom filterOptions would otherwise work in one
  // mode and throw in the other.
  greaterThanOrEqual: (v, f) => asTime(v) >= asTime(f),
  lessThanOrEqual: (v, f) => asTime(v) <= asTime(f),
  inRange: (v, f, t) => asTime(v) >= asTime(f) && asTime(v) <= asTime(t),
  blank: (v) => isBlank(v),
  notBlank: (v) => !isBlank(v),
};

function conditionPredicate(cond) {
  const type = cond.filterType ?? 'text';
  const op = cond.type;

  if (type === 'set') {
    const values = cond.values ?? [];
    // An EMPTY set matches NOTHING, not everything. AG-Grid means "the user
    // deselected every value", and returning all rows would show a trader the
    // opposite of what they asked for.
    if (values.length === 0) return () => false;
    // Set values arrive as strings; blanks are represented by null in the list.
    const wanted = new Set(values.map((v) => (v === null ? null : String(v))));
    return (v) => wanted.has(isBlank(v) ? null : String(v));
  }

  const table = type === 'number' ? NUMBER : type === 'date' ? DATE : TEXT;
  const fn = table[op];
  if (!fn) throw new Error(`unsupported ${type} filter operation "${op}"`);

  return (v) => {
    // Every operation except the blank checks treats a blank value as
    // non-matching, rather than coercing it to "" or 0.
    if (op !== 'blank' && op !== 'notBlank' && isBlank(v)) return op === 'notEqual' || op === 'notContains';
    return fn(v, cond.filter, cond.filterTo);
  };
}

/** One column's filter, including AG-Grid's combined AND/OR form. */
export function columnPredicate(model) {
  if (model.operator) {
    const parts = (model.conditions ?? []).map(conditionPredicate);
    return model.operator === 'OR'
      ? (v) => parts.some((p) => p(v))
      : (v) => parts.every((p) => p(v));
  }
  return conditionPredicate(model);
}

/**
 * A whole FilterModel -> row predicate. Columns combine with AND, which is
 * AG-Grid's only behaviour across columns.
 */
export function rowPredicate(filterModel, { field = (row, col) => row[col] } = {}) {
  const entries = Object.entries(filterModel ?? {});
  if (entries.length === 0) return () => true;
  const compiled = entries.map(([col, model]) => [col, columnPredicate(model)]);
  return (row) => compiled.every(([col, p]) => p(field(row, col)));
}

/**
 * Quick-filter replacement.
 *
 * SSRM does not support quick filter at all (parity study §3), so the CSRM side
 * must produce a FilterModel rather than filtering directly — otherwise the two
 * modes cannot express the same search.
 *
 * Deliberately takes an explicit column list: searching all 372 columns is both
 * slow and useless.
 */
export function searchFilterModel(text, columns) {
  if (!text || !columns?.length) return {};
  return {
    __search__: {
      filterType: 'multi',
      operator: 'OR',
      columns,
      conditions: columns.map((c) => ({ filterType: 'text', type: 'contains', filter: text, colId: c })),
    },
  };
}

/** Evaluate the pseudo-column produced by searchFilterModel. */
export function searchPredicate(model, { field = (row, col) => row[col] } = {}) {
  const conds = model.conditions ?? [];
  const parts = conds.map((c) => [c.colId, conditionPredicate(c)]);
  return (row) => parts.some(([col, p]) => p(field(row, col)));
}

/**
 * Sort comparator matching AG-Grid's client-side ordering.
 *
 * AG-Grid's default comparator treats a missing value as SMALLER than every
 * other value, and the sort direction then inverts the whole comparison. So
 * blanks come FIRST ascending and LAST descending — they do not stay pinned to
 * one end.
 *
 * "Nulls always last" is a common convention in other grids, and implementing
 * that here would put CSRM and SSRM one row out of agreement on every column
 * that contains a blank.
 */
export function comparator(a, b) {
  const aBlank = isBlank(a);
  const bBlank = isBlank(b);
  if (aBlank && bBlank) return 0;
  if (aBlank) return -1;
  if (bBlank) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = String(a);
  const bs = String(b);
  // Locale-aware, case-insensitive, numeric-aware — matches AG-Grid's default
  // string collation. A plain `<` comparison orders "Item 10" before "Item 9".
  return as.localeCompare(bs, undefined, { sensitivity: 'base', numeric: true });
}

export function sortRows(rows, sortModel, { field = (row, col) => row[col] } = {}) {
  if (!sortModel?.length) return rows;
  const out = [...rows];
  out.sort((ra, rb) => {
    for (const { colId, sort } of sortModel) {
      const c = comparator(field(ra, colId), field(rb, colId));
      if (c !== 0) return sort === 'desc' ? -c : c;
    }
    return 0;
  });
  return out;
}
