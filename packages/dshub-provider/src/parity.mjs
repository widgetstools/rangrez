/**
 * CSRM ⇄ SSRM parity harness (Phase 8 exit criterion).
 *
 * The parity study's whole premise is that the two modes are interchangeable:
 * a trader must not be able to tell which one a blotter is running. That is only
 * true if, for the SAME dataset and the SAME grid state, they return identical
 * row keys and identical aggregates. This proves it deterministically.
 *
 * ── The oracle problem, stated honestly ──────────────────────────────────────
 *
 * CSRM resolves locally through `filter.mjs`; SSRM translates a FilterModel into
 * engine ops (`filterModelToOps`) which Perspective then executes. A Node test
 * has no Perspective. So this compares:
 *
 *     CSRM   : corpus filtered by rowPredicate(FilterModel)   — the real CSRM path
 *     SSRM   : corpus filtered by evalOps(toFilterOps(FM))    — the real translation,
 *                                                               then a REFERENCE evaluator
 *
 * `evalOps` is that reference: it models Perspective's semantics for our op IR,
 * calibrated against the LIVE engine (findings §12, §16 — the case-insensitive
 * equals and regex-substring behaviours were measured, not assumed). The
 * automated test therefore catches TRANSLATION drift — which is what actually
 * broke, repeatedly — while the live parity page keeps the oracle itself honest.
 *
 * If evalOps and rowPredicate disagree on a case, one of two things is wrong:
 * the translation, or the two engines' agreement on that operator. Both are
 * bugs worth failing on.
 */

import { isBlank } from './filter.mjs';

/** Composite-key separator — U+0001, via fromCharCode so no literal control char is in source. */
const SEP = String.fromCharCode(1);

/** Case-folded string, or null for a blank — Perspective folds too (§16). */
const fold = (v) => (isBlank(v) ? null : String(v).toLowerCase());

/**
 * Evaluate ONE op against a row value. Text comparisons are case-insensitive,
 * matching both filter.mjs and the live engine.
 */
function evalOp(op, v) {
  switch (op.op) {
    case 'equals': case 'equalsIgnoreCase':
      return fold(v) !== null && fold(v) === fold(op.value);
    case 'notEqual': case 'notEqualIgnoreCase':
      // AG-Grid notEqual keeps blanks (they are "not equal" to any value).
      return fold(v) !== fold(op.value);
    case 'contains':
      return fold(v) !== null && fold(v).includes(fold(op.value) ?? '');
    case 'notContains':
      return fold(v) === null || !fold(v).includes(fold(op.value) ?? '');
    case 'startsWith':
      return fold(v) !== null && fold(v).startsWith(fold(op.value) ?? '');
    case 'endsWith':
      return fold(v) !== null && fold(v).endsWith(fold(op.value) ?? '');
    case 'greaterThan':        return !isBlank(v) && Number(v) > Number(op.value);
    case 'greaterThanOrEqual': return !isBlank(v) && Number(v) >= Number(op.value);
    case 'lessThan':           return !isBlank(v) && Number(v) < Number(op.value);
    case 'lessThanOrEqual':    return !isBlank(v) && Number(v) <= Number(op.value);
    case 'inRange':            return !isBlank(v) && Number(v) >= Number(op.value) && Number(v) <= Number(op.valueTo);
    case 'blank':              return isBlank(v);
    case 'notBlank':           return !isBlank(v);
    case 'in': {
      // Empty set matches NOTHING (§16). Blanks in the list are null.
      const wanted = new Set((op.value ?? []).map((x) => (x === null ? null : String(x).toLowerCase())));
      return wanted.has(fold(v));
    }
    default:
      throw new Error(`parity oracle has no rule for op "${op.op}"`);
  }
}

/** A whole op list (AND across ops, `or` nodes handled) -> row predicate. */
export function evalOps(ops, { field = (row, col) => row[col] } = {}) {
  return (row) => (ops ?? []).every((op) => {
    if (op.op === 'or') return (op.conditions ?? []).some((c) => evalOp(c, field(row, c.column)));
    return evalOp(op, field(row, op.column));
  });
}

// ------------------------------------------------- deterministic corpus

const DESKS = ['Govies', 'EM Debt', 'HY Credit', 'IG Credit', 'Inflation'];
const TRADERS = ['Jane Doe', 'John Smith', 'Sarah Williams', 'Mike Johnson', 'Tom Brown'];
const CCY = ['USD', 'EUR', 'GBP', 'JPY', 'AUD'];

/**
 * A reproducible corpus with the shapes that break parity: blanks, a null,
 * mixed case, numbers spanning a filter boundary. No RNG — `Math.random` is
 * banned in this environment and irreproducible anyway.
 */
export function makeCorpus(n = 2000) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      positionId: `POS-${String(i).padStart(5, '0')}`,
      desk: DESKS[i % DESKS.length],
      trader: TRADERS[(i * 7) % TRADERS.length],
      currency: CCY[(i * 3) % CCY.length],
      // Deliberate blanks and one null, on a real column, so blank-handling is exercised.
      book: i % 17 === 0 ? '' : i % 29 === 0 ? null : `BOOK${String(i % 40).padStart(3, '0')}`,
      dv01: (i % 100) * 12.5,                       // spans 0..1237.5, boundary at 1000
      marketValue: 1_000_000 + (i % 500) * 1000 - (i % 7) * 137,
      quantity: (i % 13) === 0 ? 0 : (i % 250) + 1,
    });
  }
  return rows;
}

/** Row keys of a set, sorted — the comparison unit for filter/group parity. */
export const keysOf = (rows, keyCols = ['positionId']) =>
  rows.map((r) => keyCols.map((c) => r[c]).join(SEP)).sort();
