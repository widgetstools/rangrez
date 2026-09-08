/**
 * Composite row-key encoding — the single definition.
 *
 * Lives in the SPEC package for the same reason viewspec.mjs does: the hub mints
 * `__key` and the provider recomputes it for AG-Grid row identity, and the two
 * must agree BYTE FOR BYTE or transactions do not route (parity study §2.3).
 *
 * ── Why this is a module and not two lines inlined ────────────────────────────
 *
 * The separator is U+0001. It is invisible in source, so every tool that touches
 * a file containing it as a literal — an editor, a formatter, a regex rewrite —
 * can silently drop it, leaving `join('')`. That is not hypothetical: it had
 * happened in FOUR separate copies of this encoder, including the hub's own
 * normalize.mjs, which meant the hub and the provider disagreed about row
 * identity for every composite key.
 *
 * Joining with nothing is not a cosmetic fault. It makes distinct rows collide:
 *
 *     {book: 'CMBS',  id: 'P-1'}  -> "CMBSP-1"
 *     {book: 'CMBSP', id: '-1'}   -> "CMBSP-1"
 *
 * On a blotter that is two positions sharing one row id — updates land on the
 * wrong row and a selection acts on something the trader did not pick.
 *
 * So: declared once, via fromCharCode so no literal control character ever
 * appears in source, and guarded by a test that asserts the separator is really
 * there.
 */

/** U+0001. Never write this as a literal — see above. */
export const KEY_SEPARATOR = String.fromCharCode(1);

/**
 * Strict encoding — what the hub stores as `__key`.
 *
 * Returns null when any key part is absent, because a row without a complete
 * key cannot be addressed and silently keying it on "undefined" would merge
 * every such row into one.
 *
 * @param {object} row
 * @param {string[]} keyColumns
 * @returns {string|null}
 */
export function encodeKey(row, keyColumns = []) {
  if (keyColumns.length === 0) return null;
  if (keyColumns.length === 1) {
    const v = row?.[keyColumns[0]];
    return v === undefined || v === null ? null : String(v);
  }
  const parts = keyColumns.map((c) => row?.[c]);
  if (parts.some((p) => p === undefined || p === null)) return null;
  return parts.map(String).join(KEY_SEPARATOR);
}

/**
 * Grid row identity — always a string.
 *
 * Prefers the `__key` the hub already computed, so the provider agrees with the
 * hub by construction rather than by reimplementing the same rule. Coerced to a
 * string because AG-Grid compares ids by value and a numeric key from the engine
 * would otherwise not match a string key computed locally.
 *
 * @returns {string}
 */
export function rowKey(row, keyColumns = []) {
  if (row?.__key !== undefined && row.__key !== null) return String(row.__key);
  return encodeKey(row, keyColumns) ?? '';
}
