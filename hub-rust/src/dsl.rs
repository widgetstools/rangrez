//! Expression DSL — tokenize → parse → evaluate. A faithful port of
//! `packages/dshub-spec/src/dsl/{tokenize,parse,eval}.mjs`.
//!
//! The in-browser hub compiles the DSL to EITHER a tree-walk (client styling)
//! or a Perspective expression string (engine). The Rust hub has no Perspective,
//! so it takes the tree-walk target for everything — computed columns, alert
//! predicates, expression filters — evaluated per row against the cache.
//!
//! Every semantic quirk is matched deliberately, because these feed alerts and
//! filters where a divergence is a wrong trade signal: `==` folds case for
//! strings; `+` concatenates when either side is a string; `truthy` treats NaN
//! as truthy (the JS impl checks `n !== 0`); `round` is `floor(x + 0.5)`
//! (JS `Math.round`, which differs from Rust's round-half-away-from-zero).

use crate::store::Value;

// ───────────────────────────────── tokens ──────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64), Str(String), Bool(bool), NullLit, Ident(String),
    Op(String), LParen, RParen, Comma, Eof,
}

/// Multi-char operators first, so `>=` is not read as `>` then `=`.
const OPERATORS: [&str; 13] = [">=", "<=", "==", "!=", "&&", "||", ">", "<", "+", "-", "*", "/", "!"];

fn starts_with(src: &[char], i: usize, op: &str) -> bool {
    op.chars().enumerate().all(|(k, c)| src.get(i + k) == Some(&c))
}

fn tokenize(input: &str) -> Result<Vec<Tok>, String> {
    let src: Vec<char> = input.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < src.len() {
        let c = src[i];
        if c == ' ' || c == '\t' || c == '\n' || c == '\r' { i += 1; continue; }
        match c {
            '(' => { toks.push(Tok::LParen); i += 1; continue; }
            ')' => { toks.push(Tok::RParen); i += 1; continue; }
            ',' => { toks.push(Tok::Comma); i += 1; continue; }
            _ => {}
        }
        // String literal: single quotes, '' escapes a quote, no backslashes.
        if c == '\'' {
            let start = i; i += 1;
            let mut value = String::new();
            loop {
                if i >= src.len() { return Err(format!("DSL syntax error at {start}: unterminated string")); }
                if src[i] == '\'' {
                    if src.get(i + 1) == Some(&'\'') { value.push('\''); i += 2; continue; }
                    i += 1; break;
                }
                if src[i] == '\\' { return Err("DSL syntax error: backslash escapes are not allowed in strings".into()); }
                value.push(src[i]); i += 1;
            }
            toks.push(Tok::Str(value));
            continue;
        }
        // Number: integer or decimal, no exponent.
        if c.is_ascii_digit() {
            let start = i;
            while i < src.len() && src[i].is_ascii_digit() { i += 1; }
            if src.get(i) == Some(&'.') { i += 1; while i < src.len() && src[i].is_ascii_digit() { i += 1; } }
            if matches!(src.get(i), Some(x) if x.is_ascii_alphabetic() || *x == '_') {
                return Err(format!("DSL syntax error at {start}: number runs into an identifier"));
            }
            let s: String = src[start..i].iter().collect();
            toks.push(Tok::Num(s.parse::<f64>().map_err(|_| "bad number".to_string())?));
            continue;
        }
        // Identifier / keyword.
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < src.len() && (src[i].is_ascii_alphanumeric() || src[i] == '_') { i += 1; }
            let word: String = src[start..i].iter().collect();
            match word.to_lowercase().as_str() {
                "and" => toks.push(Tok::Op("&&".into())),
                "or"  => toks.push(Tok::Op("||".into())),
                "not" => toks.push(Tok::Op("!".into())),
                "true" => toks.push(Tok::Bool(true)),
                "false" => toks.push(Tok::Bool(false)),
                "null" => toks.push(Tok::NullLit),
                _ => toks.push(Tok::Ident(word)),
            }
            continue;
        }
        // Operator.
        if let Some(op) = OPERATORS.iter().find(|o| starts_with(&src, i, o)) {
            toks.push(Tok::Op((*op).to_string())); i += op.len(); continue;
        }
        if c == '=' { return Err("DSL syntax error: use '==' for equality, not '='".into()); }
        return Err(format!("DSL syntax error at {i}: unexpected character \"{c}\""));
    }
    toks.push(Tok::Eof);
    Ok(toks)
}

// ───────────────────────────────── AST ─────────────────────────────────────

#[derive(Debug, Clone)]
pub enum Ast {
    Num(f64), Str(String), Bool(bool), Null,
    Field(String),
    Unary { op: char, operand: Box<Ast> },
    Binary { op: String, left: Box<Ast>, right: Box<Ast> },
    Call { name: String, args: Vec<Ast> },
}

const FUNCTIONS: [&str; 14] = [
    "abs", "min", "max", "sqrt", "floor", "ceil", "round",
    "contains", "startsWith", "endsWith", "lower", "upper", "length", "if",
];

fn precedence(op: &str) -> Option<u8> {
    Some(match op {
        "||" => 1, "&&" => 2,
        "==" | "!=" => 3, "<" | "<=" | ">" | ">=" => 4,
        "+" | "-" => 5, "*" | "/" => 6,
        _ => return None,
    })
}

struct Parser { toks: Vec<Tok>, pos: usize }

impl Parser {
    fn peek(&self) -> &Tok { &self.toks[self.pos] }
    fn next(&mut self) -> Tok { let t = self.toks[self.pos].clone(); self.pos += 1; t }

    fn parse_primary(&mut self) -> Result<Ast, String> {
        match self.peek().clone() {
            Tok::Op(o) if o == "!" || o == "-" => {
                self.next();
                Ok(Ast::Unary { op: o.chars().next().unwrap(), operand: Box::new(self.parse_primary()?) })
            }
            Tok::Num(n) => { self.next(); Ok(Ast::Num(n)) }
            Tok::Bool(b) => { self.next(); Ok(Ast::Bool(b)) }
            Tok::Str(s) => { self.next(); Ok(Ast::Str(s)) }
            Tok::NullLit => { self.next(); Ok(Ast::Null) }
            Tok::Ident(name) => {
                self.next();
                if *self.peek() == Tok::LParen {
                    if !FUNCTIONS.contains(&name.as_str()) { return Err(format!("unknown function \"{name}\"")); }
                    self.next(); // (
                    let mut args = Vec::new();
                    if *self.peek() != Tok::RParen {
                        args.push(self.parse_expression(0)?);
                        while *self.peek() == Tok::Comma { self.next(); args.push(self.parse_expression(0)?); }
                    }
                    if *self.peek() != Tok::RParen { return Err("expected \")\"".into()); }
                    self.next();
                    Ok(Ast::Call { name, args })
                } else {
                    Ok(Ast::Field(name))
                }
            }
            Tok::LParen => {
                self.next();
                let inner = self.parse_expression(0)?;
                if *self.peek() != Tok::RParen { return Err("expected \")\"".into()); }
                self.next();
                Ok(inner)
            }
            other => Err(format!("unexpected {other:?}")),
        }
    }

    fn parse_expression(&mut self, min_prec: u8) -> Result<Ast, String> {
        let mut left = self.parse_primary()?;
        loop {
            let op = match self.peek() { Tok::Op(o) => o.clone(), _ => break };
            let Some(prec) = precedence(&op) else { break };
            if prec < min_prec { break; }
            self.next();
            let right = self.parse_expression(prec + 1)?; // left-associative
            left = Ast::Binary { op, left: Box::new(left), right: Box::new(right) };
        }
        Ok(left)
    }
}

/// Parse an expression into an AST.
pub fn parse(input: &str) -> Result<Ast, String> {
    let toks = tokenize(input)?;
    let mut p = Parser { toks, pos: 0 };
    let ast = p.parse_expression(0)?;
    if *p.peek() != Tok::Eof { return Err(format!("unexpected trailing {:?}", p.peek())); }
    Ok(ast)
}

/// Every field a rule references — for validating against the schema.
pub fn fields(ast: &Ast) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(n: &Ast, out: &mut Vec<String>) {
        match n {
            Ast::Field(name) => if !out.contains(name) { out.push(name.clone()); },
            Ast::Unary { operand, .. } => walk(operand, out),
            Ast::Binary { left, right, .. } => { walk(left, out); walk(right, out); }
            Ast::Call { args, .. } => for a in args { walk(a, out); },
            _ => {}
        }
    }
    walk(ast, &mut out);
    out
}

// ─────────────────────────────── evaluation ────────────────────────────────

/// A DSL runtime value — mirrors JS values (number, string, boolean, null).
#[derive(Debug, Clone, PartialEq)]
pub enum DslValue { Num(f64), Str(String), Bool(bool), Null }

impl DslValue {
    pub fn from_cell(v: &Value) -> DslValue {
        match v {
            Value::Null => DslValue::Null,
            Value::Bool(b) => DslValue::Bool(*b),
            Value::Int(i) => DslValue::Num(*i as f64),
            Value::Float(f) => DslValue::Num(*f),
            Value::Str(s) => DslValue::Str(s.to_string()),
        }
    }
}

fn num(v: &DslValue) -> f64 {
    match v {
        DslValue::Null => f64::NAN,
        DslValue::Num(n) => *n,
        DslValue::Bool(b) => if *b { 1.0 } else { 0.0 },
        DslValue::Str(s) => { let t = s.trim(); if t.is_empty() { 0.0 } else { t.parse::<f64>().unwrap_or(f64::NAN) } }
    }
}

fn js_str(v: &DslValue) -> String {
    match v {
        DslValue::Null => String::new(),
        DslValue::Num(n) => num_to_string(*n),
        DslValue::Bool(b) => b.to_string(),
        DslValue::Str(s) => s.clone(),
    }
}

fn num_to_string(n: f64) -> String {
    if n.is_nan() { "NaN".into() }
    else if n.is_infinite() { if n > 0.0 { "Infinity".into() } else { "-Infinity".into() } }
    else { format!("{n}") }
}

/// Public truthiness (alerts/filters test the predicate result this way).
pub fn is_truthy(v: &DslValue) -> bool { truthy(v) }

/// JS truthiness AS IMPLEMENTED in eval.mjs: NaN is truthy (`n !== 0`).
fn truthy(v: &DslValue) -> bool {
    match v {
        DslValue::Bool(b) => *b,
        DslValue::Num(n) => *n != 0.0,
        DslValue::Str(s) => !s.is_empty(),
        DslValue::Null => false,
    }
}

fn eq(a: &DslValue, b: &DslValue) -> bool {
    let (an, bn) = (matches!(a, DslValue::Null), matches!(b, DslValue::Null));
    if an || bn { return an && bn; }
    if matches!(a, DslValue::Str(_)) || matches!(b, DslValue::Str(_)) {
        return js_str(a).to_lowercase() == js_str(b).to_lowercase();
    }
    match (a, b) {
        (DslValue::Num(x), DslValue::Num(y)) => x == y,
        (DslValue::Bool(x), DslValue::Bool(y)) => x == y,
        _ => false, // Num vs Bool: JS `1 === true` is false
    }
}

fn add(a: &DslValue, b: &DslValue) -> DslValue {
    if matches!(a, DslValue::Str(_)) || matches!(b, DslValue::Str(_)) {
        DslValue::Str(format!("{}{}", js_str(a), js_str(b)))
    } else {
        DslValue::Num(num(a) + num(b))
    }
}

/// Evaluate an AST against a row, reading columns through `field`. Fails soft:
/// a missing field is Null, never a panic.
pub fn eval(ast: &Ast, field: &impl Fn(&str) -> DslValue) -> DslValue {
    match ast {
        Ast::Num(n) => DslValue::Num(*n),
        Ast::Str(s) => DslValue::Str(s.clone()),
        Ast::Bool(b) => DslValue::Bool(*b),
        Ast::Null => DslValue::Null,
        Ast::Field(name) => field(name),
        Ast::Unary { op, operand } => {
            let v = eval(operand, field);
            match op { '-' => DslValue::Num(-num(&v)), _ => DslValue::Bool(!truthy(&v)) }
        }
        Ast::Binary { op, left, right } => match op.as_str() {
            "&&" => { if !truthy(&eval(left, field)) { DslValue::Bool(false) } else { DslValue::Bool(truthy(&eval(right, field))) } }
            "||" => { if truthy(&eval(left, field)) { DslValue::Bool(true) } else { DslValue::Bool(truthy(&eval(right, field))) } }
            "==" => DslValue::Bool(eq(&eval(left, field), &eval(right, field))),
            "!=" => DslValue::Bool(!eq(&eval(left, field), &eval(right, field))),
            "<"  => DslValue::Bool(num(&eval(left, field)) <  num(&eval(right, field))),
            "<=" => DslValue::Bool(num(&eval(left, field)) <= num(&eval(right, field))),
            ">"  => DslValue::Bool(num(&eval(left, field)) >  num(&eval(right, field))),
            ">=" => DslValue::Bool(num(&eval(left, field)) >= num(&eval(right, field))),
            "+"  => add(&eval(left, field), &eval(right, field)),
            "-"  => DslValue::Num(num(&eval(left, field)) - num(&eval(right, field))),
            "*"  => DslValue::Num(num(&eval(left, field)) * num(&eval(right, field))),
            "/"  => DslValue::Num(num(&eval(left, field)) / num(&eval(right, field))),
            _ => DslValue::Null,
        },
        Ast::Call { name, args } => eval_call(name, args, field),
    }
}

fn eval_call(name: &str, args: &[Ast], field: &impl Fn(&str) -> DslValue) -> DslValue {
    if name == "if" {
        let c = eval(&args[0], field);
        return if truthy(&c) { eval(&args[1], field) }
            else if args.len() > 2 { eval(&args[2], field) }
            else { DslValue::Null };
    }
    let v: Vec<DslValue> = args.iter().map(|a| eval(a, field)).collect();
    let n0 = || num(&v[0]);
    match name {
        "abs"   => DslValue::Num(n0().abs()),
        "sqrt"  => DslValue::Num(n0().sqrt()),
        "floor" => DslValue::Num(n0().floor()),
        "ceil"  => DslValue::Num(n0().ceil()),
        "round" => DslValue::Num((n0() + 0.5).floor()), // JS Math.round
        "min"   => DslValue::Num(fold_minmax(&v, true)),
        "max"   => DslValue::Num(fold_minmax(&v, false)),
        "length" => DslValue::Num(match &v[0] { DslValue::Null => 0.0, x => js_str(x).chars().count() as f64 }),
        "lower" => match &v[0] { DslValue::Null => DslValue::Null, x => DslValue::Str(js_str(x).to_lowercase()) },
        "upper" => match &v[0] { DslValue::Null => DslValue::Null, x => DslValue::Str(js_str(x).to_uppercase()) },
        "contains"   => DslValue::Bool(js_str(&v[0]).contains(&js_str(&v[1]))),
        "startsWith" => DslValue::Bool(js_str(&v[0]).starts_with(&js_str(&v[1]))),
        "endsWith"   => DslValue::Bool(js_str(&v[0]).ends_with(&js_str(&v[1]))),
        _ => DslValue::Null,
    }
}

fn fold_minmax(v: &[DslValue], is_min: bool) -> f64 {
    let mut acc = if is_min { f64::INFINITY } else { f64::NEG_INFINITY };
    for x in v {
        let n = num(x);
        if n.is_nan() { return f64::NAN; } // JS Math.min/max with a NaN arg is NaN
        if (is_min && n < acc) || (!is_min && n > acc) { acc = n; }
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(expr: &str, get: impl Fn(&str) -> DslValue) -> DslValue {
        eval(&parse(expr).unwrap(), &get)
    }
    fn none(_: &str) -> DslValue { DslValue::Null }

    #[test]
    fn arithmetic_precedence() {
        assert_eq!(ev("2 + 3 * 4", none), DslValue::Num(14.0));
        assert_eq!(ev("(2 + 3) * 4", none), DslValue::Num(20.0));
    }

    #[test]
    fn equality_folds_case_for_strings() {
        let g = |c: &str| if c == "desk" { DslValue::Str("Govies".into()) } else { DslValue::Null };
        assert_eq!(ev("desk == 'govies'", g), DslValue::Bool(true));
        assert_eq!(ev("desk != 'em'", g), DslValue::Bool(true));
    }

    #[test]
    fn plus_concatenates_with_a_string() {
        let g = |c: &str| if c == "d" { DslValue::Str("Go".into()) } else { DslValue::Null };
        assert_eq!(ev("d + '/' + 'US'", g), DslValue::Str("Go/US".into()));
        assert_eq!(ev("1 + 2", none), DslValue::Num(3.0));
    }

    #[test]
    fn round_matches_js_math_round() {
        assert_eq!(ev("round(2.5)", none), DslValue::Num(3.0));
        assert_eq!(ev("round(-2.5)", none), DslValue::Num(-2.0)); // JS: -2, not -3
    }

    #[test]
    fn if_and_functions() {
        let g = |c: &str| if c == "x" { DslValue::Num(1500.0) } else { DslValue::Null };
        assert_eq!(ev("if(x > 1000, 'HIGH', 'low')", g), DslValue::Str("HIGH".into()));
        assert_eq!(ev("length(null)", none), DslValue::Num(0.0));
        assert_eq!(ev("upper('go')", none), DslValue::Str("GO".into()));
    }

    #[test]
    fn bad_syntax_is_named() {
        assert!(parse("desk = 'x'").unwrap_err().contains("'=='"));
        assert!(parse("foo(1)").unwrap_err().contains("unknown function"));
    }
}
