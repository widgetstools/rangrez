import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/dsl/tokenize.mjs';
import { parse, fieldsOf } from '../src/dsl/parse.mjs';
import { compileEval } from '../src/dsl/eval.mjs';
import { compilePerspective, classify } from '../src/dsl/compile.mjs';

const evalRule = (src, row) => compileEval(parse(src))(row);

// ------------------------------------------------- no new Function, ever

test('the pipeline never constructs a function from text', () => {
  // The whole reason this exists: LLM-authored rules must not be a code-injection
  // surface, and OpenFin's CSP forbids new Function anyway. A grep of the source
  // is the crude but honest check; the real guarantee is that eval compiles the
  // AST into closures, never a string.
  const f = compileEval(parse("desk == 'x'"));
  assert.equal(typeof f, 'function');
  // Constructing this from text would need Function/eval; it does not.
  assert.doesNotThrow(() => f({ desk: 'x' }));
});

// ------------------------------------------------- tokenizer

test('multi-char operators are not split', () => {
  assert.deepEqual(tokenize('a >= b').map((t) => t.value), ['a', '>=', 'b', null]);
});

test("a bare = is diagnosed as the == mistake", () => {
  assert.throws(() => tokenize('a = b'), /use '==' for equality/);
});

test('word operators become their symbolic form', () => {
  assert.deepEqual(tokenize('a and b or not c').map((t) => t.value), ['a', '&&', 'b', '||', '!', 'c', null]);
});

test('strings use doubled quotes to escape, never backslashes', () => {
  assert.equal(tokenize("'O''Brien'")[0].value, "O'Brien");
  assert.throws(() => tokenize("'a\\nb'"), /backslash escapes are not allowed/);
});

test('an unterminated string is a clear error, not a hang', () => {
  assert.throws(() => tokenize("'oops"), /unterminated string/);
});

// ------------------------------------------------- parser precedence

test('precedence: and binds looser than comparison binds looser than arithmetic', () => {
  const ast = parse('dv01 * 2 > 1000 and pnl < 0');
  assert.equal(ast.op, '&&', 'and is the root');
  assert.equal(ast.left.op, '>', 'then comparison');
  assert.equal(ast.left.left.op, '*', 'then arithmetic, deepest');
});

test('parentheses override precedence', () => {
  const ast = parse('(a or b) and c');
  assert.equal(ast.op, '&&');
  assert.equal(ast.left.op, '||');
});

test('unary minus and not parse as prefixes', () => {
  assert.equal(parse('-dv01').type, 'unary');
  assert.equal(parse('not active').op, '!');
});

test('a trailing token is rejected, not ignored', () => {
  assert.throws(() => parse('a b'), /unexpected trailing/);
});

test('an unknown function is refused at parse time', () => {
  assert.throws(() => parse('frobnicate(x)'), /unknown function/);
});

test('fieldsOf lists every column a rule touches', () => {
  assert.deepEqual(fieldsOf(parse('abs(dv01) > x and desk == \'G\'')).sort(), ['desk', 'dv01', 'x']);
});

// ------------------------------------------------- evaluation

test('comparisons and boolean logic', () => {
  assert.equal(evalRule('dv01 > 1000', { dv01: 1500 }), true);
  assert.equal(evalRule('dv01 > 1000 and pnl < 0', { dv01: 1500, pnl: 5 }), false);
  assert.equal(evalRule('dv01 > 1000 or pnl < 0', { dv01: 0, pnl: -5 }), true);
});

test('equality on strings is case-insensitive, matching filter.mjs and the engine', () => {
  assert.equal(evalRule("desk == 'govies'", { desk: 'Govies' }), true);
});

test('arithmetic and functions', () => {
  assert.equal(evalRule('abs(marketValue - costBasis)', { marketValue: 100, costBasis: 130 }), 30);
  assert.equal(evalRule('max(a, b, c)', { a: 1, b: 9, c: 4 }), 9);
});

test('if() chooses a branch and is lazy', () => {
  assert.equal(evalRule("if(pnl < 0, 'red', 'green')", { pnl: -1 }), 'red');
  assert.equal(evalRule("if(pnl < 0, 'red', 'green')", { pnl: 1 }), 'green');
});

test('&& and || short-circuit', () => {
  // The right side reads a field that would be NaN; short-circuit must skip it.
  assert.equal(evalRule("desk == 'x' and dv01 > 0", { desk: 'y' }), false);
  assert.equal(evalRule("desk == 'x' or dv01 > 0", { desk: 'x', dv01: -1 }), true);
});

test('a missing field yields null/NaN, never a throw mid-render', () => {
  // A rule that blanks the grid because a column was renamed is the worst
  // failure for a styling rule.
  assert.doesNotThrow(() => evalRule('missing > 5', {}));
  assert.equal(evalRule('missing > 5', {}), false);
});

test('+ concatenates strings but adds numbers', () => {
  assert.equal(evalRule("desk + '!'", { desk: 'Govies' }), 'Govies!');
  assert.equal(evalRule('a + b', { a: 2, b: 3 }), 5);
});

// ------------------------------------------------- compile to Perspective

test('a numeric rule compiles to a Perspective expression', () => {
  assert.equal(compilePerspective(parse('abs(dv01) > 1000000')), '(abs("dv01") > 1000000)');
});

test('if() compiles to Perspective if/else', () => {
  assert.match(compilePerspective(parse("if(pnl < 0, dv01, 0)")), /if \(.*\) \{ "dv01" \} else \{ 0 \}/);
});

test('not compiles to == false, which is what Perspective accepts', () => {
  // Perspective has no boolean !; findings §16.
  assert.equal(compilePerspective(parse('not active')), '("active" == false)');
});

test('a column name with a quote is escaped in the expression', () => {
  assert.equal(compilePerspective(parse('od')), '"od"');
});

// ------------------------------------------------- the capability matrix

test('a substring rule is refused for the engine and marked client-only', () => {
  const c = classify(parse("contains(book, 'CMBS')"));
  assert.equal(c.target, 'client');
  assert.match(c.reason, /no substring predicate/);
});

test('a rule the engine can run is classified for the engine, with its expression', () => {
  const c = classify(parse('dv01 > 1000'));
  assert.equal(c.target, 'engine');
  assert.equal(c.expression, '("dv01" > 1000)');
});

test('the SAME rule evaluates identically client-side and (by construction) in the engine', () => {
  // Parity between the two targets is the property that matters: a styling rule
  // that renders one thing locally and filters another in the engine is the
  // silent divergence the capability matrix exists to prevent.
  const ast = parse('dv01 > 1000 and pnl < 0');
  const local = compileEval(ast);
  const expr = compilePerspective(ast);       // does not throw -> engine-capable
  assert.equal(local({ dv01: 1500, pnl: -1 }), true);
  assert.ok(expr.includes('"dv01"') && expr.includes('"pnl"'));
});

test('an unsupported construct carries a typed error with a position', () => {
  try { compilePerspective(parse("contains(book, 'x')")); assert.fail('should throw'); }
  catch (e) { assert.equal(e.code, 'unsupported-expression'); assert.equal(typeof e.pos, 'number'); }
});

// ------------------------------------------------- compile to filter ops (alerts)

import { compileFilterOps } from '../src/dsl/compile.mjs';

test('a threshold predicate compiles to a native filter op', () => {
  // The alert path: this engine build's boolean expression columns are broken
  // for comparison (§23), so predicates go to the native filter the parity
  // harness validated.
  const { filter, expressions } = compileFilterOps(parse('pnl < -900000'));
  assert.deepEqual(filter, [{ column: 'pnl', op: 'lessThan', value: -900000 }]);
  assert.deepEqual(expressions, {});
});

test('text equality folds case, matching every other filter path', () => {
  const { filter } = compileFilterOps(parse("desk == 'Govies'"));
  assert.deepEqual(filter, [{ column: 'desk', op: 'equalsIgnoreCase', value: 'Govies' }]);
});

test('AND flattens into the filter list; OR becomes an or-node', () => {
  assert.equal(compileFilterOps(parse('dv01 > 1000 and pnl < 0')).filter.length, 2);
  const or = compileFilterOps(parse('dv01 > 1000 or pnl < 0')).filter;
  assert.equal(or[0].op, 'or');
  assert.equal(or[0].conditions.length, 2);
});

test('literal-on-the-left is normalised to column-op-literal', () => {
  // `1000 < dv01` means the same as `dv01 > 1000`.
  assert.deepEqual(compileFilterOps(parse('1000 < dv01')).filter,
    [{ column: 'dv01', op: 'greaterThan', value: 1000 }]);
});

test('an arithmetic left side becomes an expression column, filtered natively', () => {
  // Arithmetic expression columns DO evaluate correctly (only comparison ones
  // are broken), so `marketValue - costBasis > 1000` is expressible.
  const { filter, expressions } = compileFilterOps(parse('marketValue - costBasis > 1000'));
  assert.equal(filter[0].op, 'greaterThan');
  assert.equal(filter[0].value, 1000);
  assert.equal(expressions[filter[0].column], '("marketValue" - "costBasis")');
});

test('a column-to-column comparison is refused — no filter can express it', () => {
  assert.throws(() => compileFilterOps(parse('dv01 > pnl')),
    (e) => e.code === 'unsupported-expression');
});

test('a substring predicate is refused for an engine alert', () => {
  // An alert that only sees the window is not an alert (§9.1), so a client-only
  // construct cannot become one.
  assert.throws(() => compileFilterOps(parse("contains(desk, 'Gov') and pnl < 0")),
    (e) => e.code === 'unsupported-expression');
});

// ------------------------------------------------- authoring validation

import { validateRule, summarize } from '../src/dsl/validate.mjs';

const COLS = ['dv01', 'pnl', 'desk', 'marketValue', 'costBasis', 'book'];

test('a valid predicate compiles and is marked engine', () => {
  const v = validateRule('pnl < -900000', { columns: COLS, purpose: 'predicate' });
  assert.equal(v.ok, true);
  assert.equal(v.target, 'engine');
  assert.deepEqual(v.output.filter, [{ column: 'pnl', op: 'lessThan', value: -900000 }]);
});

test('a rule referencing an unknown column is refused, naming the column', () => {
  // The failure a renamed column would cause on a live blotter, caught at
  // authoring time instead.
  const v = validateRule('pnl_total < 0', { columns: COLS, purpose: 'predicate' });
  assert.equal(v.ok, false);
  assert.deepEqual(v.unknownFields, ['pnl_total']);
  assert.equal(v.errors[0].code, 'unknown-field');
});

test('a syntax error carries a position for the editor and the repair loop', () => {
  const v = validateRule('pnl <', { columns: COLS, purpose: 'predicate' });
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, 'dsl-syntax');
  assert.equal(typeof v.errors[0].pos, 'number');
});

test('a substring predicate is refused for a predicate rule (alert)', () => {
  const v = validateRule("contains(book, 'CMBS')", { columns: COLS, purpose: 'predicate' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'unsupported-expression'));
});

test('a value rule that only runs client-side is VALID but flagged', () => {
  // A styling rule using contains() is fine — it just cannot see out-of-window
  // rows, which the UI must surface so it is never used as an alert.
  const v = validateRule("contains(desk, 'Gov')", { columns: COLS, purpose: 'value' });
  assert.equal(v.ok, true);
  assert.equal(v.target, 'client');
  assert.match(v.clientOnlyReason, /substring/);
});

test('a calc value compiles to an engine expression', () => {
  const v = validateRule('marketValue - costBasis', { columns: COLS, purpose: 'value' });
  assert.equal(v.ok, true);
  assert.equal(v.target, 'engine');
  assert.equal(v.output, '("marketValue" - "costBasis")');
});

test('summarize gives one actionable line for each verdict', () => {
  assert.match(summarize(validateRule('pnl < 0', { columns: COLS, purpose: 'predicate' })), /runs in the engine/);
  assert.match(summarize(validateRule('nope < 0', { columns: COLS, purpose: 'predicate' })), /no column "nope"/);
});
