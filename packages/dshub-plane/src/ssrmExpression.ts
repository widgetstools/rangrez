/**
 * The client expression wire contract — the serialized AST the engine reads.
 *
 * DECLARED here, not owned here. The only parser is starui's
 * `ExpressionEngine` (`@wellsfargo-starui/core`), which emits these nodes via
 * `compileToEngineExpression`; `hub-rust/src/expr.rs` consumes them, and the
 * normative statement of the semantics is the golden fixture corpus
 * (`hub-rust/tests/fixtures/ssrmExpressionContract.wire.json`) that
 * `tests/expr_contract.rs` runs.
 *
 * Re-declared rather than imported so this package has no dependencies: a
 * plane that pins engine behaviour should not also drag an app's type tree
 * behind it. `SSRM_EXPR_CONTRACT_VERSION` is what detects drift — a spec
 * arriving with a different version is a contract mismatch, not a type error.
 *
 * Kept byte-compatible with starui's `@wellsfargo-starui/types/shared/ssrmExpression`.
 */

export const SSRM_EXPR_CONTRACT_VERSION = 1 as const;

/** `+ - * / %` · comparisons · logical. String `+` concatenates, like the client. */
export type SsrmExprBinaryOp =
  | 'add' | 'sub' | 'mul' | 'div' | 'mod'
  | 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'
  | 'and' | 'or';

export type SsrmExprUnaryOp = 'neg' | 'not';

/**
 * Scalar functions in grammar v1. Names are the DSL's own (upper-case);
 * argument counts and coercions are the client `functions.ts` definitions,
 * pinned by the fixtures.
 */
export type SsrmExprScalarFn =
  | 'ABS' | 'ROUND' | 'FLOOR' | 'CEIL' | 'SQRT' | 'POW' | 'MOD' | 'LOG' | 'EXP'
  | 'MIN' | 'MAX' // scalar form (2+ args); single-column-ref form is an `agg` node
  | 'CONCAT' | 'UPPER' | 'LOWER' | 'TRIM' | 'LEN' | 'SUBSTRING' | 'REPLACE'
  | 'CONTAINS' | 'STARTS_WITH' | 'ENDS_WITH'
  | 'IF' | 'IFS' | 'SWITCH' | 'CASE'
  | 'ISNULL' | 'ISNOTNULL' | 'ISEMPTY'
  | 'YEAR' | 'MONTH' | 'DAY' | 'IS_WEEKDAY';

/** Aggregate forms — view-level scalars the engine computes (T4: full set). */
export type SsrmExprAggFn =
  | 'sum' | 'avg' | 'count' | 'min' | 'max'
  | 'median' | 'stdev' | 'variance' | 'distinct_count';

export type SsrmExprNode =
  | { k: 'lit'; v: number | string | boolean | null }
  | { k: 'col'; name: string }
  | { k: 'bin'; op: SsrmExprBinaryOp; l: SsrmExprNode; r: SsrmExprNode }
  | { k: 'un'; op: SsrmExprUnaryOp; a: SsrmExprNode }
  | { k: 'fn'; name: SsrmExprScalarFn; args: SsrmExprNode[] }
  | { k: 'in'; a: SsrmExprNode; list: SsrmExprNode[] }
  | { k: 'between'; a: SsrmExprNode; lo: SsrmExprNode; hi: SsrmExprNode }
  /** Unified conditional: ternary / IF / IFS / SWITCH / CASE all lower to this. */
  | { k: 'cond'; branches: Array<{ when: SsrmExprNode; then: SsrmExprNode }>; else?: SsrmExprNode }
  /** `SUM([col])` and friends — a view-level scalar the whole column shares. */
  | { k: 'agg'; fn: SsrmExprAggFn; col: string };

/**
 * Engine capabilities a compiled expression needs beyond plain T3 computed
 * columns. `aggregates` = phase T4; `dateFns` = phase T6.
 */
export type SsrmExprRequirement = 'aggregates' | 'dateFns';

/** One computed column of a view spec, as the engine will receive it. */
export interface SsrmComputedColumnSpec {
  /** Result column name — addressable by the same view's sort/filter/group. */
  as: string;
  version: typeof SSRM_EXPR_CONTRACT_VERSION;
  expr: SsrmExprNode;
}
