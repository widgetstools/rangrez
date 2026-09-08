/**
 * Hot reload dispatch (architecture §3.8).
 *
 * A config edit is not one thing. Changing a conflation interval should take
 * effect on the next tick; changing key columns invalidates every row identity
 * in the table and needs the table rebuilt and clients re-initialised. Treating
 * them alike means either re-snapshotting a 500k-row book because someone
 * nudged a timer, or silently applying a key change that leaves the grid
 * addressing rows that no longer exist under those ids.
 *
 * So every field in the schema carries `x-reloadClass`, and this computes the
 * strongest class implied by an actual diff. The schema is the source of truth:
 * a new field gets its reload behaviour by being annotated, not by being added
 * to a list here.
 */

/** Weakest to strongest. The strongest class in a diff wins. */
export const RELOAD_ORDER = ['none', 'live', 'resubscribe', 'rebuild', 'restart'];

export const strongest = (a, b) =>
  (RELOAD_ORDER.indexOf(a) >= RELOAD_ORDER.indexOf(b) ? a : b);

/**
 * Resolve a `$ref` one hop. Deliberately not recursive-with-cycle-detection:
 * this schema's refs are one level into `$defs`, and a general resolver would
 * be more machinery than the shape warrants.
 */
function deref(node, root) {
  if (!node?.$ref) return node;
  const path = node.$ref.replace(/^#\//, '').split('/');
  return path.reduce((o, k) => o?.[k], root) ?? node;
}

/**
 * The reload class declared for a path, walking down the schema alongside it.
 *
 * Falls back to the NEAREST ANNOTATED ANCESTOR: `snapshot` is annotated
 * `resubscribe` as a whole, so a change to any field inside it is a
 * resubscribe even though the leaf carries no annotation of its own. Defaulting
 * an unannotated field to `live` instead would apply a structural change
 * without the restart it needs.
 */
export function reloadClassAt(path, schema, root = schema) {
  let node = deref(schema, root);
  let found = node?.['x-reloadClass'] ?? 'none';

  for (const key of path) {
    let next = node?.properties?.[key];
    if (!next && node?.items) next = deref(node.items, root)?.properties?.[key];
    if (!next && node?.additionalProperties && typeof node.additionalProperties === 'object') {
      next = node.additionalProperties;
    }
    if (!next && Array.isArray(node?.oneOf)) {
      // A discriminated union: the field may live in any branch, and the
      // strongest class among the branches that declare it is the safe reading.
      let best = null;
      for (const branch of node.oneOf) {
        const cand = deref(branch, root)?.properties?.[key];
        if (!cand) continue;
        if (!best) { best = cand; continue; }
        // Merge only when a branch actually declares a class. Synthesising
        // `'none'` here would OVERWRITE the inherited ancestor class — `snapshot`
        // is annotated `resubscribe` as a whole, and a leaf inside it that
        // declares nothing must keep that, not fall back to a live reload.
        const declared = [best['x-reloadClass'], cand['x-reloadClass']].filter(Boolean);
        best = declared.length
          ? { ...cand, 'x-reloadClass': declared.reduce(strongest) }
          : cand;
      }
      next = best;
    }
    if (!next) return found;                 // unknown leaf: inherit the ancestor
    /**
     * The annotation may sit BESIDE the `$ref`, not inside the target:
     * `{"$ref": "#/$defs/id", "x-reloadClass": "restart"}`. Dereferencing first
     * and reading the annotation off the target drops it — `connection.id`
     * reported `none` and would have been applied as a live edit, when changing
     * a connection's id invalidates every datasource pointing at it.
     *
     * The local annotation wins: it is the more specific of the two.
     */
    const local = next['x-reloadClass'];
    node = deref(next, root);
    found = local ?? node?.['x-reloadClass'] ?? found;
  }
  return found;
}

/** Every path whose value differs, as arrays of keys. */
export function changedPaths(before, after, prefix = []) {
  const out = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    const a = before?.[k], b = after?.[k];
    if (a === b) continue;
    const bothObjects = a && b && typeof a === 'object' && typeof b === 'object'
      && !Array.isArray(a) && !Array.isArray(b);
    if (bothObjects) { out.push(...changedPaths(a, b, [...prefix, k])); continue; }
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    out.push([...prefix, k]);
  }
  return out;
}

/**
 * What must happen for this edit to take effect.
 *
 * @returns {{reload: string, changes: {path: string, reload: string}[]}}
 */
export function reloadPlan(before, after, itemSchema, root) {
  const changes = changedPaths(before, after).map((path) => ({
    path: path.join('.'),
    reload: reloadClassAt(path, itemSchema, root ?? itemSchema),
  }));
  const reload = changes.reduce((acc, c) => strongest(acc, c.reload), 'none');
  return { reload, changes };
}

/** Convenience for a whole bundle: the plan per changed item. */
export function reloadPlanForBundle(before, after, schema) {
  const defs = { connections: 'connection', datasources: 'datasource' };
  const plans = [];
  for (const [collection, defName] of Object.entries(defs)) {
    const itemSchema = { $defs: schema.$defs, $ref: `#/$defs/${defName}` };
    const byId = (rows) => new Map((rows ?? []).map((r) => [r.id, r]));
    const a = byId(before?.[collection]);
    const b = byId(after?.[collection]);

    for (const [id, next] of b) {
      const prev = a.get(id);
      if (!prev) { plans.push({ collection, id, reload: 'restart', changes: [{ path: '(added)', reload: 'restart' }] }); continue; }
      const plan = reloadPlan(prev, next, itemSchema, schema);
      if (plan.reload !== 'none') plans.push({ collection, id, ...plan });
    }
    // A removed datasource cannot be reconfigured, only torn down.
    for (const id of a.keys()) {
      if (!b.has(id)) plans.push({ collection, id, reload: 'restart', changes: [{ path: '(removed)', reload: 'restart' }] });
    }
  }
  return { reload: plans.reduce((acc, p) => strongest(acc, p.reload), 'none'), plans };
}
