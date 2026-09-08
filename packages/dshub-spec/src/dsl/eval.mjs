/**
 * DSL evaluator (Phase 9). AST + a row -> value. Tree-walk, NO `new Function`.
 *
 * This is the client-side target: conditional styling and any rule the engine
 * cannot run get evaluated here, per row, in the cell renderer's hot path. So it
 * is written to be cheap — no allocation per node beyond what the tree forces —
 * and to fail SOFT: a rule that references a missing field yields null rather
 * than throwing mid-render and blanking the grid.
 *
 * `compile()` returns a closure over the AST so the tree is walked once at
 * authoring time into a nest of small functions; the render path calls that
 * closure, never the interpreter's dispatch.
 */

const FN = {
  abs: (a) => Math.abs(num(a)),
  min: (...a) => Math.min(...a.map(num)),
  max: (...a) => Math.max(...a.map(num)),
  sqrt: (a) => Math.sqrt(num(a)),
  floor: (a) => Math.floor(num(a)),
  ceil: (a) => Math.ceil(num(a)),
  round: (a) => Math.round(num(a)),
  length: (a) => (a == null ? 0 : String(a).length),
  lower: (a) => (a == null ? null : String(a).toLowerCase()),
  upper: (a) => (a == null ? null : String(a).toUpperCase()),
  contains: (a, b) => str(a).includes(str(b)),
  startsWith: (a, b) => str(a).startsWith(str(b)),
  endsWith: (a, b) => str(a).endsWith(str(b)),
  // if(cond, then, else) — the args are pre-evaluated by the caller for the
  // simple functions, but `if` needs lazy branches, so it is special-cased below.
};

const num = (v) => (v == null ? NaN : Number(v));
const str = (v) => (v == null ? '' : String(v));
const truthy = (v) => v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v.length > 0);

/**
 * Compile an AST to a `(row) => value` closure.
 *
 * @param {object} ast
 * @param {(row:object, name:string)=>unknown} [field]  how to read a column
 * @returns {(row:object)=>unknown}
 */
export function compileEval(ast, field = (row, name) => row?.[name]) {
  switch (ast.type) {
    case 'num': case 'str': case 'bool': { const v = ast.value; return () => v; }
    case 'null': return () => null;
    case 'field': { const name = ast.name; return (row) => field(row, name); }

    case 'unary': {
      const inner = compileEval(ast.operand, field);
      if (ast.op === '-') return (row) => -num(inner(row));
      return (row) => !truthy(inner(row));                 // '!'
    }

    case 'binary': {
      const l = compileEval(ast.left, field);
      const r = compileEval(ast.right, field);
      switch (ast.op) {
        // Short-circuit, so `desk == 'X' or slowFn()` does not touch slowFn.
        case '&&': return (row) => (truthy(l(row)) ? truthy(r(row)) : false);
        case '||': return (row) => (truthy(l(row)) ? true : truthy(r(row)));
        case '==': return (row) => eq(l(row), r(row));
        case '!=': return (row) => !eq(l(row), r(row));
        case '<':  return (row) => num(l(row)) < num(r(row));
        case '<=': return (row) => num(l(row)) <= num(r(row));
        case '>':  return (row) => num(l(row)) > num(r(row));
        case '>=': return (row) => num(l(row)) >= num(r(row));
        case '+':  return (row) => add(l(row), r(row));
        case '-':  return (row) => num(l(row)) - num(r(row));
        case '*':  return (row) => num(l(row)) * num(r(row));
        case '/':  return (row) => num(l(row)) / num(r(row));
        default: throw new Error(`eval: unknown operator ${ast.op}`);
      }
    }

    case 'call': {
      if (ast.name === 'if') {
        const [c, t, e] = ast.args.map((a) => compileEval(a, field));
        return (row) => (truthy(c(row)) ? t(row) : (e ? e(row) : null));
      }
      const fn = FN[ast.name];
      if (!fn) throw new Error(`eval: unknown function ${ast.name}`);
      const args = ast.args.map((a) => compileEval(a, field));
      return (row) => fn(...args.map((a) => a(row)));
    }

    default: throw new Error(`eval: unknown node ${ast.type}`);
  }
}

/** `==` folds case-insensitively for strings, matching filter.mjs and the engine. */
function eq(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'string' || typeof b === 'string') return String(a).toLowerCase() === String(b).toLowerCase();
  return a === b;
}

/** `+` concatenates when either side is a string, else adds. */
function add(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return str(a) + str(b);
  return num(a) + num(b);
}
