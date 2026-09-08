/**
 * Schema artifact -> Perspective table schema.
 *
 * A table must be created from a SCHEMA, not from empty data: Perspective
 * cannot infer column types from empty arrays and aborts with "Can't create
 * table from empty columns". Creating from the artifact is also what the
 * architecture specifies (§4) — the artifact is the single source for the
 * Perspective schema, the key columns and the colDefs.
 *
 * Creating from the first batch instead would re-introduce first-batch
 * inference, which §4.1 bans: an all-null first batch types as string forever,
 * and a float column whose first batch happens to be whole numbers becomes an
 * integer and truncates silently.
 */

/** Our artifact types are already aligned with Perspective's. */
const TYPE = {
  string: 'string',
  integer: 'integer',
  float: 'float',
  boolean: 'boolean',
  datetime: 'datetime',
  date: 'date',
};

export function perspectiveSchemaFor(artifact, { softDeleteColumn } = {}) {
  if (!artifact?.columns?.length) throw new Error('cannot build a table schema from an artifact with no columns');

  const schema = {};
  for (const c of artifact.columns) {
    const t = TYPE[c.type];
    if (!t) throw new Error(`column "${c.column}": unmapped artifact type "${c.type}"`);
    schema[c.column] = t;
    // Companions are engine-facing but must exist: they are what sorting and
    // aggregation actually run on (§4.2).
    if (c.companion) schema[c.companion.column] = TYPE[c.companion.type] ?? 'float';
  }

  // The hub's own columns. __key is the index; the soft-delete flag is how a
  // removal reaches the client at all, since on_update never surfaces one.
  schema.__key = 'string';
  if (softDeleteColumn) schema[softDeleteColumn] = 'boolean';
  return schema;
}
