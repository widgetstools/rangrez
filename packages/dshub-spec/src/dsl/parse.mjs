/**
 * DSL parser (Phase 9). Tokens -> AST, via Pratt precedence climbing.
 *
 * The AST is the single source both targets consume — the tree-walk evaluator
 * and the Perspective compiler. It carries source positions so a bad rule points
 * at the offending token, which the LLM repair loop needs to fix its own output.
 *
 * Node shapes:
 *   { type:'num',   value }
 *   { type:'str',   value }
 *   { type:'bool',  value }
 *   { type:'null' }
 *   { type:'field', name, pos }
 *   { type:'unary', op, operand }
 *   { type:'binary', op, left, right }
 *   { type:'call',  name, args, pos }
 */

import { tokenize, TOKEN } from './tokenize.mjs';

/** Binary precedence — higher binds tighter. Mirrors the two targets exactly. */
const PRECEDENCE = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5, '*': 6, '/': 6,
};

/** Functions the DSL exposes. Kept in ONE place so eval and compile agree. */
export const FUNCTIONS = new Set([
  'abs', 'min', 'max', 'sqrt', 'floor', 'ceil', 'round',
  'contains', 'startsWith', 'endsWith', 'lower', 'upper', 'length',
  'if',
]);

export function parse(input) {
  const tokens = tokenize(input);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const err = (msg, tok = peek()) =>
    Object.assign(new Error(`DSL parse error at ${tok.pos}: ${msg}`), { code: 'dsl-syntax', pos: tok.pos });

  function expect(type) {
    const t = peek();
    if (t.type !== type) throw err(`expected "${type}", got "${t.value ?? t.type}"`);
    return next();
  }

  /** A primary: literal, field, call, parenthesised, or a unary prefix. */
  function parsePrimary() {
    const t = peek();

    if (t.type === TOKEN.OP && (t.value === '!' || t.value === '-')) {
      next();
      return { type: 'unary', op: t.value, operand: parsePrimary(), pos: t.pos };
    }
    if (t.type === TOKEN.NUMBER) {
      next();
      if (t.bool) return { type: 'bool', value: t.value, pos: t.pos };
      return { type: 'num', value: t.value, pos: t.pos };
    }
    if (t.type === TOKEN.STRING) { next(); return { type: 'str', value: t.value, pos: t.pos }; }
    if (t.type === TOKEN.IDENT && t.nul) { next(); return { type: 'null', pos: t.pos }; }

    if (t.type === TOKEN.IDENT) {
      next();
      // A call if followed by '(' — otherwise a field reference.
      if (peek().type === TOKEN.LPAREN) {
        if (!FUNCTIONS.has(t.value)) throw err(`unknown function "${t.value}"`, t);
        next();                                   // (
        const args = [];
        if (peek().type !== TOKEN.RPAREN) {
          args.push(parseExpression(0));
          while (peek().type === TOKEN.COMMA) { next(); args.push(parseExpression(0)); }
        }
        expect(TOKEN.RPAREN);
        return { type: 'call', name: t.value, args, pos: t.pos };
      }
      return { type: 'field', name: t.value, pos: t.pos };
    }

    if (t.type === TOKEN.LPAREN) {
      next();
      const inner = parseExpression(0);
      expect(TOKEN.RPAREN);
      return inner;
    }

    throw err(`unexpected "${t.value ?? t.type}"`);
  }

  /** Precedence climbing over binary operators. */
  function parseExpression(minPrec) {
    let left = parsePrimary();
    for (;;) {
      const t = peek();
      if (t.type !== TOKEN.OP || PRECEDENCE[t.value] === undefined) break;
      const prec = PRECEDENCE[t.value];
      if (prec < minPrec) break;
      next();
      // All our operators are left-associative, so the right side binds tighter.
      const right = parseExpression(prec + 1);
      left = { type: 'binary', op: t.value, left, right, pos: t.pos };
    }
    return left;
  }

  const ast = parseExpression(0);
  if (peek().type !== TOKEN.EOF) throw err(`unexpected trailing "${peek().value}"`);
  return ast;
}

/** Every field a rule references — for validating against the live schema. */
export function fieldsOf(ast) {
  const out = new Set();
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'field') out.add(n.name);
    if (n.left) walk(n.left);
    if (n.right) walk(n.right);
    if (n.operand) walk(n.operand);
    if (n.args) n.args.forEach(walk);
  })(ast);
  return [...out];
}
