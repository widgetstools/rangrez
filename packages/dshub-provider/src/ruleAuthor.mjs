/**
 * LLM rule authoring with a repair loop (Phase 9, architecture §9.4).
 *
 * The chatbot configurator emits DSL, never a raw Perspective expression — the
 * DSL is the safe, validatable surface (§9). An LLM's first attempt is often
 * ALMOST right: a wrong column name, a construct the engine cannot run, a syntax
 * slip. The structured verdict from `validateRule` is exactly what a model needs
 * to fix its own output, so authoring is a LOOP: generate, validate, and on
 * failure feed the specific error back and let it try again.
 *
 * Bounded, and it never persists an invalid rule — if the model cannot produce a
 * valid rule within the attempt budget, authoring FAILS with the trail of what
 * it tried, rather than shipping the last broken guess.
 *
 * The LLM is injected (`generate`), so the loop mechanism — the part that
 * matters and can regress — is tested against a deterministic fake, not a live
 * model.
 */

import { validateRule, summarize } from '@wellsfargo-starui/dshub-spec/src/dsl/validate.mjs';

/**
 * @param {object} o
 * @param {(prompt:{request:string, columns:string[], priorError?:string, priorAttempt?:string})=>Promise<string>} o.generate
 *        The model. Returns a DSL string.
 * @param {string} o.request       the trader's natural-language ask
 * @param {string[]} o.columns     live schema columns
 * @param {'predicate'|'value'} [o.purpose]
 * @param {number} [o.maxAttempts]
 * @returns {Promise<{ok, rule?, verdict?, attempts:{rule,verdict}[]}>}
 */
export async function authorWithRepair({ generate, request, columns, purpose = 'value', maxAttempts = 3 }) {
  const attempts = [];
  let priorError, priorAttempt;

  for (let i = 0; i < maxAttempts; i++) {
    const rule = (await generate({ request, columns, priorError, priorAttempt })).trim();
    const verdict = validateRule(rule, { columns, purpose });
    attempts.push({ rule, verdict });

    if (verdict.ok) return { ok: true, rule, verdict, attempts };

    // Feed the SPECIFIC failure back. A model repairs "no column pnl_total" far
    // better than "invalid rule".
    priorError = summarize(verdict);
    priorAttempt = rule;
  }

  return { ok: false, attempts, verdict: attempts.at(-1)?.verdict };
}

/**
 * Render a repair prompt a model can act on. Exposed so a real integration can
 * use the same wording the tests exercise.
 */
export function repairPrompt({ request, columns, priorError, priorAttempt }) {
  const cols = columns.length > 40 ? `${columns.slice(0, 40).join(', ')}, … (${columns.length} total)` : columns.join(', ');
  let p = `Write a DSL rule for: ${request}\nAvailable columns: ${cols}\n`;
  if (priorAttempt) {
    p += `\nYour previous attempt was:\n  ${priorAttempt}\n`;
    p += `It was rejected: ${priorError}\nFix exactly that and return only the corrected rule.`;
  }
  return p;
}
