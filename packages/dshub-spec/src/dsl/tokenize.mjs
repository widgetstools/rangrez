/**
 * DSL tokenizer (Phase 9, architecture §9).
 *
 * The DSL is the one place LLM-generated text becomes executable, so the whole
 * pipeline is built to make `new Function` unnecessary: text -> tokens -> AST ->
 * either a tree-walk (client styling) or a Perspective expression string (engine
 * calc columns / alerts). Nothing is ever eval'd. This is step one.
 *
 * The grammar is deliberately small — comparisons, boolean logic, arithmetic, a
 * fixed function set, field references, literals — because every construct has to
 * be reproducible in BOTH targets or explicitly refused. A grammar that can say
 * things Perspective cannot is a grammar that silently diverges between modes.
 */

export const TOKEN = {
  NUMBER: 'number', STRING: 'string', IDENT: 'ident',
  OP: 'op', LPAREN: '(', RPAREN: ')', COMMA: ',', EOF: 'eof',
};

/** Multi-char operators first, so `>=` is not read as `>` then `=`. */
const OPERATORS = ['>=', '<=', '==', '!=', '&&', '||', '>', '<', '+', '-', '*', '/', '!'];

/** Word operators and constants — matched as idents, then reclassified. */
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null']);

export function tokenize(input) {
  const src = String(input ?? '');
  const tokens = [];
  let i = 0;

  const err = (msg, at = i) => {
    throw Object.assign(new Error(`DSL syntax error at ${at}: ${msg}`), { code: 'dsl-syntax', pos: at });
  };

  while (i < src.length) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if (c === '(') { tokens.push({ type: TOKEN.LPAREN, value: c, pos: i }); i++; continue; }
    if (c === ')') { tokens.push({ type: TOKEN.RPAREN, value: c, pos: i }); i++; continue; }
    if (c === ',') { tokens.push({ type: TOKEN.COMMA, value: c, pos: i }); i++; continue; }

    // String literal — single quotes, with '' as an escaped quote (SQL style, no
    // backslash escapes: backslashes are a favourite injection vector and the
    // DSL never needs them).
    if (c === "'") {
      const start = i; i++;
      let value = '';
      for (;;) {
        if (i >= src.length) err('unterminated string', start);
        if (src[i] === "'") {
          if (src[i + 1] === "'") { value += "'"; i += 2; continue; }
          i++; break;
        }
        if (src[i] === '\\') err('backslash escapes are not allowed in strings');
        value += src[i]; i++;
      }
      tokens.push({ type: TOKEN.STRING, value, pos: start });
      continue;
    }

    // Number — integer or decimal, no exponent (not needed, and `e` collides
    // with idents).
    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < src.length && src[i] >= '0' && src[i] <= '9') i++;
      if (src[i] === '.') { i++; while (i < src.length && src[i] >= '0' && src[i] <= '9') i++; }
      if (/[a-zA-Z_]/.test(src[i] ?? '')) err('number runs into an identifier', start);
      tokens.push({ type: TOKEN.NUMBER, value: Number(src.slice(start, i)), pos: start });
      continue;
    }

    // Identifier / keyword — columns are flattened with underscores, so `_` and
    // digits are valid after the first char.
    if (/[a-zA-Z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) i++;
      const word = src.slice(start, i);
      const lower = word.toLowerCase();
      if (KEYWORDS.has(lower)) {
        if (lower === 'and') tokens.push({ type: TOKEN.OP, value: '&&', pos: start });
        else if (lower === 'or') tokens.push({ type: TOKEN.OP, value: '||', pos: start });
        else if (lower === 'not') tokens.push({ type: TOKEN.OP, value: '!', pos: start });
        else if (lower === 'true') tokens.push({ type: TOKEN.NUMBER, value: true, pos: start, bool: true });
        else if (lower === 'false') tokens.push({ type: TOKEN.NUMBER, value: false, pos: start, bool: true });
        else tokens.push({ type: TOKEN.IDENT, value: null, pos: start, nul: true });   // null literal
        continue;
      }
      tokens.push({ type: TOKEN.IDENT, value: word, pos: start });
      continue;
    }

    // Operator.
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) { tokens.push({ type: TOKEN.OP, value: op, pos: i }); i += op.length; continue; }

    // A bare `=` is the classic mistake for `==`; name it rather than "unexpected".
    if (c === '=') err("use '==' for equality, not '='");
    err(`unexpected character "${c}"`);
  }

  tokens.push({ type: TOKEN.EOF, value: null, pos: i });
  return tokens;
}
