/**
 * Normalizer — raw upstream payload -> flat rows ready for Perspective.
 *
 * THIS IS THE CONFORMANCE REFERENCE. From Phase 10 the Rust twin must produce
 * byte-identical Arrow for every message in the corpus (architecture §2.2), so
 * every behaviour here is a contract, not an implementation detail. Anything
 * ambiguous gets a corpus case rather than a comment.
 *
 * Driven entirely by the flatten spec and schema artifact — no per-datasource
 * code (architecture §5.2).
 */

import { encodeKey as sharedEncodeKey } from '../../dshub-spec/src/rowkey.mjs';

/** Ops after mapping. Delete becomes a soft-delete flag flip downstream. */
export const OP = { INSERT: 'insert', UPDATE: 'update', DELETE: 'delete' };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read a dotted path out of the RAW payload (raw paths may legally contain dots). */
function readPath(obj, path) {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// ---------------------------------------------------------------- coercions

/**
 * "99-16+" -> 99.515625
 *
 * 32nds with an optional half-tick. Stays a string in its own column; this
 * produces the numeric companion that sorting and aggregation actually use
 * (architecture §4.2). Without the companion, "99-16" sorts after "100-01".
 */
export function ticksToDecimal(value) {
  if (typeof value !== 'string') return null;
  const m = /^(-?\d+)-(\d{1,2})([+¼½¾148])?$/.exec(value.trim());
  if (!m) return null;
  const [, whole, ticks, frac] = m;
  const sign = whole.startsWith('-') ? -1 : 1;
  let thirty2nds = Number(ticks);
  if (frac === '+' || frac === '½' || frac === '4') thirty2nds += 0.5;
  else if (frac === '¼' || frac === '2') thirty2nds += 0.25;
  else if (frac === '¾' || frac === '6') thirty2nds += 0.75;
  else if (frac === '1') thirty2nds += 0.125;
  else if (frac === '8') thirty2nds += 0.875;
  return Number(whole) + sign * (thirty2nds / 32);
}

const COERCIONS = {
  'ticks-to-decimal': ticksToDecimal,
  'string-to-number': (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  },
  'epoch-to-datetime': (v) => {
    if (typeof v !== 'number') return null;
    // Heuristic on magnitude: seconds vs milliseconds.
    return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  },
  'scaled-integer': (v, scale) => (typeof v === 'number' ? v / (scale ?? 1) : null),
};

// ---------------------------------------------------------------- normalizer

export function createNormalizer(datasource, artifact) {
  const sep = datasource.flatten?.separator ?? '_';
  if (sep === '.') {
    // AG-Grid resolves a dotted ColDef field as a deep property path and fails
    // silently. The schema forbids this too; belt and braces.
    throw new Error('flatten separator "." is not permitted (architecture §5.2)');
  }
  const maxDepth = datasource.flatten?.maxDepth ?? 8;
  const arrays = datasource.flatten?.arrays ?? {};
  const coercions = datasource.coercions ?? [];
  const keyColumns = datasource.keyColumns ?? artifact?.keyColumns ?? [];
  const softDeleteColumn = datasource.softDelete?.column;
  const opField = datasource.opField;

  /**
   * Flatten by walking the INCOMING PAYLOAD, never the schema.
   *
   * This is the single most important line in the file. A partial patch
   * `{tradeId, risk:{dv01:1234}}` must emit ONLY `risk_dv01`. Walking the
   * schema instead would emit every column with null for the absent ones, and
   * Perspective's merge semantics would then wipe every untouched field on the
   * row. Absent and null are different things and stay different (§5.2).
   */
  function flatten(node, prefix, out, depth, rawPath) {
    if (depth > maxDepth) return;

    for (const [key, value] of Object.entries(node)) {
      const column = prefix ? `${prefix}${sep}${key}` : key;
      const path = rawPath ? `${rawPath}.${key}` : key;

      if (Array.isArray(value)) {
        applyArrayStrategy(path, column, value, out);
        continue;
      }
      if (isPlainObject(value)) {
        flatten(value, column, out, depth + 1, path);
        continue;
      }
      // Scalars, including explicit null — which is meaningful and preserved.
      out[column] = value;
    }
  }

  function applyArrayStrategy(path, column, value, out) {
    const spec = arrays[path] ?? arrays[column];
    if (!spec) {
      // Unconfigured array: JSON-string it so it is visible rather than lost.
      // Not sortable, and that is the point — a silent drop is worse.
      out[column] = JSON.stringify(value);
      return;
    }

    switch (spec.strategy) {
      case 'index-pin': {
        const arity = spec.arity ?? value.length;
        for (let i = 0; i < arity; i++) {
          const item = value[i];
          if (item === undefined) continue;
          if (isPlainObject(item)) flatten(item, `${column}${sep}${i}`, out, 1, `${path}.${i}`);
          else out[`${column}${sep}${i}`] = item;
        }
        return;
      }
      case 'aggregate': {
        const fn = spec.aggregate ?? 'count';
        if (fn === 'count') { out[`${column}${sep}count`] = value.length; return; }
        const nums = value
          .map((v) => (spec.aggregatePath ? readPath(v, spec.aggregatePath) : v))
          .filter((v) => typeof v === 'number');
        if (nums.length === 0) { out[`${column}${sep}${fn}`] = null; return; }
        out[`${column}${sep}${fn}`] =
          fn === 'sum' ? nums.reduce((a, b) => a + b, 0)
          : fn === 'min' ? Math.min(...nums)
          : fn === 'max' ? Math.max(...nums)
          : null;
        return;
      }
      case 'json-string':
        out[column] = JSON.stringify(value);
        return;
      case 'explode':
        // Handled by the caller, which needs to emit sibling-table rows.
        return;
      default:
        throw new Error(`unknown array strategy "${spec.strategy}" for ${path}`);
    }
  }

  /**
   * Composite key encoding — delegated to the spec package.
   *
   * This was inlined here and the U+0001 separator had been stripped to
   * `join('')`, so the hub minted keys the provider could not reproduce and
   * distinct rows collided. One definition now, shared with the provider.
   */
  const encodeKey = (row) => sharedEncodeKey(row, keyColumns);

  function mapOp(raw) {
    if (!opField) return OP.UPDATE;
    const token = readPath(raw, opField.path);
    if (token === undefined) return OP.UPDATE;
    const mapped = opField.map[String(token)];
    if (!mapped) throw new Error(`unmapped op token "${token}" at ${opField.path}`);
    return mapped;
  }

  function applyCoercions(row) {
    for (const c of coercions) {
      // Coercion paths are raw paths; the flattened column is the same path
      // with the separator substituted.
      const column = c.path.split('.').join(sep);
      if (!(column in row)) continue; // absent in a partial patch — nothing to coerce
      const fn = COERCIONS[c.kind];
      if (!fn) throw new Error(`unknown coercion "${c.kind}"`);
      const computed = fn(row[column], c.scale);
      if (c.companion) row[c.companion] = computed;
      else row[column] = computed;
    }
  }

  /** Rows for an `explode` array become sibling-table rows keyed parentKey|index. */
  function explodeChildren(raw, parentKey, children) {
    for (const [path, spec] of Object.entries(arrays)) {
      if (spec.strategy !== 'explode') continue;
      const value = readPath(raw, path);
      if (!Array.isArray(value)) continue;
      const rows = value.map((item, i) => {
        const child = {};
        if (isPlainObject(item)) flatten(item, '', child, 1, path);
        else child.value = item;
        child.__parentKey = parentKey;
        child.__index = i;
        child.__key = `${parentKey}${i}`;
        return child;
      });
      children.push({ table: spec.childTable, rows });
    }
  }

  /**
   * One raw message -> { rows, children }.
   *
   * `rows` carry only the fields the message actually contained, plus __key and
   * __op. A delete is emitted as the soft-delete flag flip, because Perspective's
   * on_update does not surface removals at all (architecture §8.4).
   */
  function normalize(raw) {
    const op = mapOp(raw);
    const row = {};
    flatten(raw, '', row, 1, '');

    // The op field is control metadata, not data. Left in, it becomes a real
    // column in the Perspective table — and one whose value is meaningless to a
    // trader. It has already been consumed into __op above.
    if (opField) delete row[opField.path.split('.').join(sep)];

    applyCoercions(row);

    const key = encodeKey(row);
    if (key === null) {
      throw new Error(`message is missing key column(s): ${keyColumns.join(', ')}`);
    }
    row.__key = key;
    row.__op = op;

    if (op === OP.DELETE && softDeleteColumn) {
      // The flag flip IS the delta the provider maps back to a grid removal.
      row[softDeleteColumn] = true;
    } else if (softDeleteColumn && op === OP.INSERT) {
      row[softDeleteColumn] = false;
    }

    const children = [];
    explodeChildren(raw, key, children);
    return { rows: [row], children };
  }

  return { normalize, encodeKey, flatten: (raw) => { const o = {}; flatten(raw, '', o, 1, ''); return o; } };
}
