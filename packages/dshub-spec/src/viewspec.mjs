/**
 * ViewSpec -> Perspective view config.
 *
 * Lives in the SPEC package because ViewSpec is defined in
 * control-protocol.schema.json, and BOTH sides need the translation: the hub
 * when it opens views for queries, the provider when it opens views directly.
 *
 * Keeping one copy is the same discipline as the conformance corpus — two
 * translations that drift produce a filter that means one thing on one host and
 * something else on the other.
 */

/** Our filter shape -> Perspective's [[col, op, value]] triples. */
const OP = {
  equals: '==', notEqual: '!=',
  greaterThan: '>', greaterThanOrEqual: '>=',
  lessThan: '<', lessThanOrEqual: '<=',
  contains: 'contains', startsWith: 'begins with', endsWith: 'ends with',
  in: 'in', notIn: 'not in',
  blank: 'is null', notBlank: 'is not null',
};

/**
 * Perspective identifier quoting for expressions: `lower("desk")`.
 * Embedded quotes are doubled, the same rule SQL uses.
 */
const quoteCol = (c) => `"${String(c).replace(/"/g, '""')}"`;

/** Expression column name for the case-folded form of a column. */
export const ciColumn = (c) => `__ci_${c}`;

/**
 * Filter translation, plus any expression columns the filter needs.
 *
 * AG-Grid text filters are case-INSENSITIVE by default. Perspective's
 * `contains` / `begins with` / `ends with` happen to be case-insensitive too,
 * so those agree for free — but `==` and `!=` are case-SENSITIVE, and that one
 * difference meant typing "govies" instead of "Govies" returned 2,502 rows in
 * CSRM and ZERO in SSRM. Same grid, same box, opposite answers.
 *
 * The fix is a computed column holding the folded value, compared against a
 * folded literal. One expression per filtered column, named deterministically so
 * the view cache still keys on it.
 */
/**
 * Escape a user string for use inside a Perspective regex literal.
 *
 * NOT optional. Perspective's `match` takes a regex, and a trader typing "." in
 * a search box would otherwise match EVERY row — measured: an unescaped dot
 * returned all 20,000, the escaped form returned 0, which is the correct answer
 * because no value contains a literal dot. Metacharacters in a search box are
 * ordinary characters as far as the user is concerned.
 */
const escapeRegex = (v) => String(v ?? '').replace(/[\\^$.|?*+()[\]{}]/g, (c) => `\\${c}`);

/** Escape a string for a single-quoted expression literal. */
const escapeLiteral = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * One condition as a Perspective EXPRESSION rather than a filter triple.
 *
 * Needed because Perspective's `filter` array is AND-only: there is no way to
 * express "desk contains X OR trader contains X" — which is exactly what a
 * quick-filter box is — as a list of triples. The expression language does have
 * `or`, so an OR becomes a computed boolean column that the filter then tests.
 *
 * Text comparisons are case-folded here for the same reason they are in the
 * triple path: AG-Grid's text filters are case-insensitive and Perspective's
 * `==` is not.
 */
export function conditionExpression(f) {
  const col = quoteCol(f.column);
  const kind = f.op ?? f.type;
  const lit = (v) => `'${escapeLiteral(v)}'`;
  const rx = (pattern) => `match(lower(${col}), ${lit(pattern)})`;
  const needle = escapeRegex(String(f.value ?? '').toLowerCase());

  switch (kind) {
    case 'contains':        return rx(`.*${needle}.*`);
    // `not(x)` is NOT valid Perspective — it parses but fails type resolution.
    // `x == false` is, and was measured against CSRM's answer.
    case 'notContains':     return `${rx(`.*${needle}.*`)} == false`;
    case 'startsWith':      return rx(`^${needle}.*`);
    case 'endsWith':        return rx(`.*${needle}$`);
    case 'equals':
    case 'equalsIgnoreCase':    return `lower(${col}) == ${lit(String(f.value ?? '').toLowerCase())}`;
    case 'notEqual':
    case 'notEqualIgnoreCase':  return `lower(${col}) != ${lit(String(f.value ?? '').toLowerCase())}`;
    case 'greaterThan':         return `${col} > ${Number(f.value)}`;
    case 'greaterThanOrEqual':  return `${col} >= ${Number(f.value)}`;
    case 'lessThan':            return `${col} < ${Number(f.value)}`;
    case 'lessThanOrEqual':     return `${col} <= ${Number(f.value)}`;
    case 'inRange':             return `(${col} >= ${Number(f.value)}) and (${col} <= ${Number(f.valueTo)})`;
    case 'blank':               return `is_null(${col})`;
    case 'notBlank':            return `is_null(${col}) == false`;
    case 'in': {
      const vals = (f.value ?? []).map((v) => `lower(${col}) == ${lit(String(v ?? '').toLowerCase())}`);
      // An empty set matches NOTHING, the same rule the triple path applies.
      return vals.length ? `(${vals.join(' or ')})` : 'false';
    }
    default:
      throw Object.assign(
        new Error(`filter operation "${kind}" has no Perspective expression form`),
        { code: 'unsupported-expression' },
      );
  }
}

export function toPerspectiveFilterWithExpressions(filter = []) {
  const expressions = {};
  const out = [];
  let orIndex = 0;
  for (const f of filter) {
    const kind = f?.op ?? f?.type;

    /**
     * An OR becomes a computed boolean column.
     *
     * Perspective's `filter` array combines with AND and has no OR, so this is
     * the only way to express a quick-filter box — "any of these columns
     * contains this text" — or AG-Grid's combined OR condition. Previously both
     * threw, which meant quick search simply did not work in SSRM.
     */
    if (kind === 'or' || kind === 'anyOf') {
      const name = `__or_${orIndex++}`;
      const parts = (f.conditions ?? []).map(conditionExpression);
      expressions[name] = parts.length ? parts.map((p) => `(${p})`).join(' or ') : 'false';
      out.push([name, '==', true]);
      continue;
    }

    // Ops with no Perspective operator but a valid expression form.
    if (kind === 'notContains') {
      const name = `__nc_${f.column}`;
      expressions[name] = conditionExpression(f);
      out.push([name, '==', true]);
      continue;
    }

    if (kind === 'equalsIgnoreCase' || kind === 'notEqualIgnoreCase') {
      const name = ciColumn(f.column);
      expressions[name] = `lower(${quoteCol(f.column)})`;
      out.push([name, kind === 'equalsIgnoreCase' ? '==' : '!=', String(f.value ?? '').toLowerCase()]);
      continue;
    }
    out.push(...toPerspectiveFilter([f]));
  }
  return { filter: out, expressions };
}

export function toPerspectiveFilter(filter = []) {
  const out = [];
  for (const f of filter) {
    // Already a triple.
    if (Array.isArray(f)) { out.push(f); continue; }
    const kind = f.op ?? f.type;

    // inRange has no single Perspective operator, so it decomposes into two
    // inclusive bounds. This must be checked BEFORE the operator lookup, which
    // would otherwise reject it as untranslatable.
    if (kind === 'inRange') {
      out.push([f.column, '>=', f.value], [f.column, '<=', f.valueTo]);
      continue;
    }

    const op = OP[kind];
    if (!op) throw new Error(`filter operation "${kind}" has no Perspective equivalent`);
    if (op === 'is null' || op === 'is not null') { out.push([f.column, op]); continue; }
    out.push([f.column, op, f.value]);
  }
  return out;
}

export function toPerspectiveViewConfig(spec = {}) {
  const cfg = {};
  if (spec.columns?.length) cfg.columns = spec.columns;
  if (spec.groupBy?.length) cfg.group_by = spec.groupBy;
  if (spec.splitBy?.length) cfg.split_by = spec.splitBy;
  if (spec.aggregates) cfg.aggregates = spec.aggregates;

  // Expressions come from two places: the caller's own, and any the filter
  // needs for case-folded comparison. Both must reach the engine, or the
  // filter references a column that is not in the schema.
  const expressions = { ...(spec.expressions ?? {}) };
  if (spec.filter?.length) {
    const t = toPerspectiveFilterWithExpressions(spec.filter);
    cfg.filter = t.filter;
    Object.assign(expressions, t.expressions);
  }
  if (Object.keys(expressions).length) cfg.expressions = expressions;
  if (spec.sort?.length) {
    cfg.sort = spec.sort.map((s) => [s.column ?? s.colId, s.dir ?? s.sort ?? 'asc']);
  }
  // `depth` is deliberately NOT copied: Perspective exposes it as the
  // set_depth() method on the view, not as a config field. Passing it through
  // fails with "unknown field". The caller applies it after creation.
  return cfg;
}

