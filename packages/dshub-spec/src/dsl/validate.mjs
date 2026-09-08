/**
 * Rule authoring validation (Phase 9, architecture §9.3).
 *
 * A rule is compiled and dry-run against the LIVE schema before it is ever
 * persisted, so a broken rule is caught at authoring time — in the editor, or in
 * the LLM repair loop — not at render time on a trader's blotter, where a
 * reference to a renamed column would blank a cell or a bad predicate would
 * silently watch nothing.
 *
 * The verdict is STRUCTURED, not a thrown string, because two consumers read it:
 * the admin UI (to show the error next to the field, and to label a rule
 * client-only) and the chatbot repair loop (which feeds the error back to the
 * model). Both need the code, the position, and the specific message — a bare
 * "invalid" is useless to either.
 */

import { parse, fieldsOf } from './parse.mjs';
import { classify, compileFilterOps } from './compile.mjs';

/**
 * @param {string} source
 * @param {object} o
 * @param {string[]} o.columns   the live schema's column names
 * @param {'predicate'|'value'} [o.purpose]
 *   'predicate' — an alert or filter rule: must reduce to a filter (compileFilterOps)
 *   'value'     — a styling or calc rule: a value/condition (classify -> engine|client)
 * @returns {{ok, target?, output?, fields, unknownFields, errors}}
 */
export function validateRule(source, { columns = [], purpose = 'value' } = {}) {
  const errors = [];

  // 1. Syntax.
  let ast;
  try { ast = parse(source); }
  catch (e) {
    return { ok: false, fields: [], unknownFields: [], errors: [{ code: e.code ?? 'dsl-syntax', message: e.message, pos: e.pos }] };
  }

  // 2. Every referenced field must exist in the live schema. A rule that
  //    references a column the datasource does not have will never fire on the
  //    engine and yields null on the client — both silent failures.
  const known = new Set(columns);
  const fields = fieldsOf(ast);
  const unknownFields = fields.filter((f) => !known.has(f));
  for (const f of unknownFields) {
    errors.push({ code: 'unknown-field', message: `no column "${f}" in this datasource`, field: f });
  }

  // 3. Compile for the intended purpose.
  if (purpose === 'predicate') {
    try {
      const { filter, expressions } = compileFilterOps(ast);
      if (!unknownFields.length) {
        return { ok: true, target: 'engine', output: { filter, expressions }, fields, unknownFields: [], errors };
      }
    } catch (e) {
      errors.push({ code: e.code ?? 'unsupported-expression', message: e.message, pos: e.pos });
    }
    return { ok: false, fields, unknownFields, errors };
  }

  // purpose === 'value': classify engine vs client-only.
  let target, output, reason;
  try {
    const c = classify(ast);
    target = c.target; output = c.expression; reason = c.reason;
  } catch (e) {
    errors.push({ code: e.code ?? 'internal', message: e.message, pos: e.pos });
    return { ok: false, fields, unknownFields, errors };
  }
  if (unknownFields.length) return { ok: false, target, fields, unknownFields, errors };

  return {
    ok: true, target, output, fields, unknownFields: [],
    // A client-only rule is VALID — it just cannot see out-of-window rows, which
    // the UI must surface so an alert is never authored on it by mistake.
    ...(target === 'client' ? { clientOnlyReason: reason } : {}),
    errors,
  };
}

/**
 * A one-line, human summary of a verdict — for the editor's status line and the
 * LLM repair prompt.
 */
export function summarize(verdict) {
  if (verdict.ok) {
    return verdict.target === 'client'
      ? `valid, client-only (${verdict.clientOnlyReason})`
      : `valid, runs in the engine`;
  }
  return verdict.errors.map((e) =>
    `${e.code}${e.pos !== undefined ? ` at ${e.pos}` : ''}: ${e.message}`).join('; ');
}
