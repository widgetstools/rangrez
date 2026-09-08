/**
 * Flatten preview (architecture §10, Phase 7).
 *
 * Paste a raw upstream message, see the columns it becomes. The value is
 * entirely in the ARRAY STRATEGIES: `index-pin`, `aggregate`, `json-string` and
 * `explode` produce wildly different schemas from the same payload, and the
 * difference is invisible until a table has been built and a grid wired to it.
 *
 * Getting it wrong is not a crash. `index-pin` without an explicit `arity`
 * takes its width from whatever message you happened to look at — a 3-element
 * leg array pins 3 columns today and silently drops the 4th leg tomorrow.
 * `explode` on the wrong field multiplies the row count. Both look fine in a
 * JSON payload and only announce themselves as a wrong number on a blotter.
 *
 * So this runs the REAL normalizer — the same one the worker uses — rather than
 * a preview approximation. A preview that agrees with itself and disagrees with
 * production is worse than none.
 */

import { createNormalizer } from '../../dshub-worker/src/normalize.mjs';

/**
 * @param {object} raw        one upstream message
 * @param {object} datasource the config being edited
 * @param {object} [artifact]
 * @returns {{columns: {column: string, value: unknown, type: string}[],
 *            childTables: object[], key: string|null, op: string, error: string|null,
 *            warnings: string[]}}
 */
export function flattenPreview(raw, datasource, artifact = null) {
  const empty = { columns: [], childTables: [], key: null, op: null, error: null, warnings: [] };
  if (raw === null || typeof raw !== 'object') {
    return { ...empty, error: 'a message must be a JSON object' };
  }

  /**
   * Warnings are computed BEFORE normalizing, and survive its failure.
   *
   * The most useful warnings are about the cases that make the normalizer
   * throw — a key column this message does not carry raises "missing key
   * column(s)", which names the symptom rather than the cause. Computing them
   * only on success meant exactly the diagnosis the user needed was the one
   * they could never see.
   */
  const warnings = warningsFor(raw, datasource, []);

  let normalizer;
  try { normalizer = createNormalizer(datasource, artifact); }
  catch (e) { return { ...empty, warnings, error: `config: ${e.message}` }; }

  let result;
  try { result = normalizer.normalize(raw); }
  catch (e) { return { ...empty, warnings, error: e.message }; }

  const row = result.rows?.[0] ?? {};
  const columns = Object.entries(row)
    .filter(([k]) => k !== '__key' && k !== '__op')
    .map(([column, value]) => ({ column, value, type: typeOf(value) }))
    .sort((a, b) => a.column.localeCompare(b.column));

  return {
    columns,
    childTables: result.children ?? [],
    key: row.__key ?? null,
    op: row.__op ?? null,
    error: null,
    // Recomputed with the real columns, which sharpens the key-column check.
    warnings: warningsFor(raw, datasource, columns),
  };
}

const typeOf = (v) => {
  if (v === null) return 'null';
  if (v instanceof Date) return 'date';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

/**
 * The mistakes worth catching before a table exists.
 *
 * Warnings rather than errors: every one of these is a legitimate choice for
 * some feed, and a preview that refuses to render is less useful than one that
 * renders and explains the risk.
 */
export function warningsFor(raw, datasource, columns) {
  const out = [];
  const arrays = datasource?.flatten?.arrays ?? {};

  for (const [field, spec] of Object.entries(arrays)) {
    const value = findArray(raw, field);
    if (!Array.isArray(value)) continue;

    if (spec.strategy === 'index-pin') {
      if (spec.arity === undefined) {
        out.push(`"${field}" pins columns by index but declares no arity, so the width comes from whatever message you sampled — ${value.length} here. A longer message tomorrow loses its extra elements silently.`);
      } else if (value.length > spec.arity) {
        out.push(`"${field}" is pinned at arity ${spec.arity} and this message has ${value.length} elements — ${value.length - spec.arity} would be DROPPED.`);
      }
      if (value.length === 0) {
        out.push(`"${field}" is empty in this message, so no columns are produced — an artifact inferred from this sample would miss them entirely.`);
      }
      if ((spec.arity ?? value.length) > 8) {
        out.push(`"${field}" produces ${spec.arity ?? value.length} columns, one per position.`);
      }
    }
    if (spec.strategy === 'explode' && value.length > 1) {
      out.push(`"${field}" explodes into a child table: this one message becomes ${value.length} child rows.`);
    }
    if (spec.strategy === 'json-string') {
      out.push(`"${field}" is stored as a JSON string — readable, but not sortable or filterable as data.`);
    }
  }

  if (!datasource?.keyColumns?.length) {
    out.push('No key columns: rows cannot be addressed, and updates will append rather than update.');
  } else {
    /**
     * Checked against the RAW payload when no columns are available, because
     * this runs before normalization — which is the whole point, since a
     * missing key is what makes normalization fail.
     */
    const has = columns.length
      ? (c) => columns.some((x) => x.column === c)
      : (c) => findArray.hasField(raw, c);
    const missing = datasource.keyColumns.filter((c) => !has(c));
    if (missing.length) out.push(`Key column(s) not produced by this message: ${missing.join(', ')}.`);
  }

  const wide = columns.length;
  if (wide > 300) out.push(`${wide} columns from one message — check the array strategies before building a table this wide.`);
  return out;
}

/** Is a field present anywhere in the payload, at any depth? */
findArray.hasField = function hasField(obj, field) {
  if (obj == null || typeof obj !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(obj, field)) return true;
  return Object.values(obj).some((v) => v && typeof v === 'object' && !Array.isArray(v) && hasField(v, field));
};

/** Locate an array by dotted path or by bare field name anywhere in the payload. */
function findArray(obj, field) {
  if (field.includes('.')) return field.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  if (Array.isArray(obj?.[field])) return obj[field];
  for (const v of Object.values(obj ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = findArray(v, field);
      if (Array.isArray(found)) return found;
    }
  }
  return undefined;
}

/**
 * Compare two strategies on the same message.
 *
 * The point of the preview is the comparison, not either output on its own —
 * seeing `index` produce 40 columns beside `join` producing 1 is what makes the
 * choice obvious.
 */
export function compareStrategies(raw, datasource, field, strategies = ['index-pin', 'aggregate', 'json-string', 'explode']) {
  return strategies.map((strategy) => {
    const ds = structuredClone(datasource);
    ds.flatten ??= {};
    ds.flatten.arrays ??= {};
    ds.flatten.arrays[field] = { ...(ds.flatten.arrays[field] ?? {}), strategy };
    if (strategy === 'explode') ds.flatten.arrays[field].childTable ??= `${ds.id ?? 'ds'}-${field}`;
    const p = flattenPreview(raw, ds);
    return {
      strategy,
      columns: p.columns.length,
      childRows: (p.childTables ?? []).reduce((n, c) => n + (c.rows?.length ?? 0), 0),
      error: p.error,
      sample: p.columns.slice(0, 3).map((c) => c.column),
    };
  });
}
