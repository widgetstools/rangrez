/** Match rangrez ingest: flatten nested objects with `_`, max depth 6. */
export const FLATTEN_SEPARATOR = '_';
export const FLATTEN_MAX_DEPTH = 6;

export function flattenRow(
  row: unknown,
  prefix = '',
  out: Record<string, unknown> = {},
  depth = 1,
): Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    if (prefix) out[prefix] = row;
    return out;
  }
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    const path = prefix ? `${prefix}${FLATTEN_SEPARATOR}${key}` : key;
    if (Array.isArray(value)) continue;
    if (value && typeof value === 'object' && depth < FLATTEN_MAX_DEPTH) {
      flattenRow(value, path, out, depth + 1);
    } else {
      out[path] = value;
    }
  }
  return out;
}

export function flattenRows(rows: readonly unknown[]): Record<string, unknown>[] {
  return rows.map((row) => flattenRow(row));
}
