/**
 * DSL -> Perspective expression compiler (Phase 9, architecture §9.2).
 *
 * The engine target: calculated columns and hub-side alert predicates must run
 * IN Perspective, because in SSRM the client only ever sees a window — a rule
 * evaluated client-side would fire on the visible rows only, which for an alert
 * is a silent miss (§9.1). So those rules compile to a Perspective expression
 * string; the ones that CANNOT compile are refused with a typed error and marked
 * client-only, never silently run in a place they do not belong.
 *
 * ── The capability matrix ─────────────────────────────────────────────────────
 *
 * Perspective's expression language is real but not JavaScript. It has arithmetic,
 * comparison, boolean ops, `if(){}else{}`, and a fixed function set. It does NOT
 * have arbitrary string search the way JS does, and its column refs and string
 * literals are quoted differently. Anything outside what it can express is a
 * typed `unsupported-expression` — the authoring UI turns that into "this rule
 * runs client-side only", and the LLM repair loop reads the reason.
 */

/** Column reference: "colname", embedded quotes doubled (SQL rule). */
const col = (name) => `"${String(name).replace(/"/g, '""')}"`;
/** String literal: 'text', embedded quotes doubled. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const BINARY = {
  '&&': '&&', '||': '||',
  '==': '==', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=',
  '+': '+', '-': '-', '*': '*', '/': '/',
};

/**
 * Functions Perspective can run, mapped to its spelling. A function absent here
 * is refused — it may be evaluable client-side, but it cannot go to the engine.
 */
const FUNCTIONS = {
  abs: (a) => `abs(${a})`,
  sqrt: (a) => `sqrt(${a})`,
  floor: (a) => `floor(${a})`,
  ceil: (a) => `ceil(${a})`,
  round: (a) => `round(${a})`,
  min: (...a) => a.reduce((x, y) => `min(${x}, ${y})`),
  max: (...a) => a.reduce((x, y) => `max(${x}, ${y})`),
  length: (a) => `length(${a})`,
  lower: (a) => `lower(${a})`,
  upper: (a) => `upper(${a})`,
  // Perspective has no substring predicate. `contains`/startsWith/endsWith are
  // refused for the engine and marked client-only.
};

const unsupported = (msg, node) =>
  Object.assign(new Error(msg), { code: 'unsupported-expression', pos: node?.pos });

/**
 * @returns {string} a Perspective expression
 * @throws {Error}   code 'unsupported-expression' for anything the engine cannot run
 */
export function compilePerspective(ast) {
  switch (ast.type) {
    case 'num': return String(ast.value);
    case 'bool': return ast.value ? 'true' : 'false';
    case 'str': return lit(ast.value);
    case 'null': throw unsupported('null has no Perspective expression form; use is_null()', ast);
    case 'field': return col(ast.name);

    case 'unary':
      if (ast.op === '-') return `(-${compilePerspective(ast.operand)})`;
      // Perspective has no boolean `!`; `x == false` is the idiom (findings §16).
      return `(${compilePerspective(ast.operand)} == false)`;

    case 'binary': {
      const op = BINARY[ast.op];
      if (!op) throw unsupported(`operator "${ast.op}" is not supported in the engine`, ast);
      return `(${compilePerspective(ast.left)} ${op} ${compilePerspective(ast.right)})`;
    }

    case 'call': {
      if (ast.name === 'if') {
        if (ast.args.length < 2) throw unsupported('if() needs a condition and a then-value', ast);
        const [c, t, e] = ast.args.map(compilePerspective);
        return `if (${c}) { ${t} } else { ${e ?? 'null'} }`;
      }
      if (['contains', 'startsWith', 'endsWith'].includes(ast.name)) {
        throw unsupported(`"${ast.name}" cannot run in the engine (no substring predicate); this rule is client-only`, ast);
      }
      const fn = FUNCTIONS[ast.name];
      if (!fn) throw unsupported(`function "${ast.name}" has no Perspective equivalent`, ast);
      return fn(...ast.args.map(compilePerspective));
    }

    default: throw unsupported(`cannot compile node "${ast.type}"`, ast);
  }
}

/**
 * Classify a rule: can it run in the engine, or is it client-only?
 *
 * The authoring UI shows this so a rule is never SILENTLY divergent — a styling
 * rule that must run client-side is fine, but the user (and the alert path) must
 * know it will not see rows outside the window.
 *
 * @returns {{target:'engine'|'client', expression?:string, reason?:string}}
 */
export function classify(ast) {
  try {
    return { target: 'engine', expression: compilePerspective(ast) };
  } catch (e) {
    if (e.code === 'unsupported-expression') return { target: 'client', reason: e.message };
    throw e;
  }
}

/**
 * DSL -> native FILTER ops (Phase 9, alert/predicate target).
 *
 * ── Why not the boolean expression column ─────────────────────────────────────
 *
 * The obvious path — compile the predicate to a Perspective boolean expression
 * and filter on `expr == true` — does not work: this engine build's expression
 * comparisons (`<`, `>`, `==`) do not produce correct per-row booleans
 * (measured: `"pnl" < 0` returned true for every row). Arithmetic expressions
 * DO work. So a predicate compiles to the NATIVE filter the parity harness
 * validated, with any arithmetic sub-expression lifted into an expression column
 * the filter then compares — the two engine features that actually work,
 * combined.
 *
 * @returns {{filter: object[], expressions: object}}
 * @throws  code 'unsupported-expression' for a predicate no filter can express
 */
export function compileFilterOps(ast) {
  const expressions = {};
  let exprSeq = 0;

  /** A comparison side: a bare column, or an arithmetic expression column. */
  const operand = (node) => {
    if (node.type === 'field') return { column: node.name };
    // A literal on the LEFT is unusual but legal (`1000 < dv01`); the caller
    // flips it. Anything else — arithmetic, a function — becomes an expression
    // column, since those compile and evaluate correctly.
    if (node.type === 'num' || node.type === 'str' || node.type === 'bool') return { literal: node.value };
    if (node.type === 'unary' && node.op === '-' && node.operand.type === 'num') return { literal: -node.operand.value };
    const name = `__expr_${exprSeq++}`;
    expressions[name] = compilePerspective(node);      // arithmetic/functions DO work
    return { column: name };
  };

  const CMP = { '<': 'lessThan', '<=': 'lessThanOrEqual', '>': 'greaterThan', '>=': 'greaterThanOrEqual', '==': 'equals', '!=': 'notEqual' };
  const FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };

  const comparison = (node) => {
    let { op, left, right } = node;
    let l = operand(left), r = operand(right);
    // Normalise to column-op-literal. `1000 < dv01` -> `dv01 > 1000`.
    if (l.literal !== undefined && r.column !== undefined) { [l, r] = [r, l]; op = FLIP[op]; }
    if (l.column === undefined) {
      throw unsupported('a comparison needs a column (or an expression) on one side', node);
    }
    if (r.literal === undefined) {
      throw unsupported('a comparison needs a literal on the other side; column-to-column is not filterable', node);
    }
    // Text equality folds case, matching every other filter path (findings §16).
    const isText = typeof r.literal === 'string';
    const cmpOp = (op === '==' && isText) ? 'equalsIgnoreCase' : (op === '!=' && isText) ? 'notEqualIgnoreCase' : CMP[op];
    return [{ column: l.column, op: cmpOp, value: r.literal }];
  };

  const build = (node) => {
    if (node.type === 'binary') {
      if (node.op === '&&') return [...build(node.left), ...build(node.right)];   // AND flattens
      if (node.op === '||') return [{ op: 'or', conditions: [...build(node.left), ...build(node.right)] }];
      if (CMP[node.op]) return comparison(node);
      throw unsupported(`operator "${node.op}" is not a filter predicate`, node);
    }
    if (node.type === 'unary' && node.op === '!') {
      // not(field) only makes sense for a boolean column: field == false.
      if (node.operand.type === 'field') return [{ column: node.operand.name, op: 'equals', value: false }];
      throw unsupported('not(...) is only a predicate on a boolean column', node);
    }
    if (node.type === 'field') return [{ column: node.name, op: 'equals', value: true }];   // bare boolean column
    throw unsupported('a predicate must be a comparison or boolean combination', node);
  };

  const filter = build(ast);
  return { filter, expressions };
}
