//! DSL parity: the Rust expression evaluator must produce exactly what the JS
//! evaluator (`eval.mjs`) produces, over the SAME corpus — both as predicates
//! (truthy-row counts, the alert/filter use) and as computed values (per row,
//! the calc-column use). A divergence here is a wrong alert or a wrong cell.

use dshub::dsl::{eval, is_truthy, parse, DslValue};
use dshub::store::{TableCache, Value};
use serde_json::{json, Value as Json};

const DESKS: [&str; 5] = ["Govies", "EM Debt", "HY Credit", "IG Credit", "Inflation"];
const TRADERS: [&str; 5] = ["Jane Doe", "John Smith", "Sarah Williams", "Mike Johnson", "Tom Brown"];
const CCY: [&str; 5] = ["USD", "EUR", "GBP", "JPY", "AUD"];

fn make_corpus(n: usize) -> Vec<Json> {
    (0..n).map(|i| {
        let book = if i % 17 == 0 { json!("") } else if i % 29 == 0 { json!(null) } else { json!(format!("BOOK{:03}", i % 40)) };
        json!({
            "positionId": format!("POS-{:05}", i), "desk": DESKS[i % 5], "trader": TRADERS[(i * 7) % 5],
            "currency": CCY[(i * 3) % 5], "book": book, "dv01": (i % 100) as f64 * 12.5,
            "marketValue": 1_000_000i64 + (i % 500) as i64 * 1000 - (i % 7) as i64 * 137,
            "quantity": if i % 13 == 0 { 0i64 } else { ((i % 250) + 1) as i64 },
        })
    }).collect()
}

fn loaded_cache(corpus: &[Json]) -> TableCache {
    let mut t = TableCache::new(["positionId", "desk", "trader", "currency", "book", "dv01", "marketValue", "quantity"]);
    for row in corpus {
        let obj = row.as_object().unwrap();
        t.upsert(obj["positionId"].as_str().unwrap(), obj);
    }
    t
}

/// A field getter over the cache for a given slot.
fn getter(cache: &TableCache, slot: usize) -> impl Fn(&str) -> DslValue + '_ {
    move |name: &str| cache.col_index(name).map(|ci| DslValue::from_cell(cache.cell(slot, ci))).unwrap_or(DslValue::Null)
}

fn matches_value(got: &DslValue, want: &Json) -> bool {
    match got {
        DslValue::Null => want.is_null(),
        DslValue::Num(n) => {
            if n.is_nan() || n.is_infinite() { want.is_null() } // JS JSON.stringify folds these to null
            else { want.as_f64().map_or(false, |w| (n - w).abs() < 1e-9) }
        }
        DslValue::Str(s) => want.as_str() == Some(s.as_str()),
        DslValue::Bool(b) => want.as_bool() == Some(*b),
    }
}

#[test]
fn rust_dsl_matches_the_js_evaluator() {
    let fixture: Json = serde_json::from_str(include_str!("fixtures/dsl_parity.json")).unwrap();
    let corpus = make_corpus(fixture["corpusN"].as_u64().unwrap() as usize);
    let cache = loaded_cache(&corpus);

    // Predicates: truthy-row counts must match.
    let mut checked = 0;
    for (expr, want) in fixture["predicates"].as_object().unwrap() {
        let ast = parse(expr).unwrap_or_else(|e| panic!("parse '{expr}': {e}"));
        let count = cache.live_slots().filter(|&slot| is_truthy(&eval(&ast, &getter(&cache, slot)))).count();
        assert_eq!(count as u64, want.as_u64().unwrap(), "predicate '{expr}': rust {count} vs js {want}");
        checked += 1;
    }

    // Values: the computed value for the first 8 rows must match.
    for (expr, wants) in fixture["values"].as_object().unwrap() {
        let ast = parse(expr).unwrap();
        for (i, want) in wants.as_array().unwrap().iter().enumerate() {
            let got = eval(&ast, &getter(&cache, i)); // slot i == corpus row i (no deletes)
            assert!(matches_value(&got, want), "value '{expr}' row {i}: rust {got:?} vs js {want}");
        }
        checked += 1;
    }
    eprintln!("DSL parity: {checked} expressions — Rust == JS evaluator");
}

/// Sanity: a store cell round-trips into a DSL value the way JS reads a row field.
#[test]
fn cell_to_dslvalue_bridges_the_types() {
    assert_eq!(DslValue::from_cell(&Value::Int(5)), DslValue::Num(5.0));
    assert_eq!(DslValue::from_cell(&Value::Null), DslValue::Null);
    assert_eq!(DslValue::from_cell(&Value::Str("x".into())), DslValue::Str("x".into()));
}

use dshub::query::{filtered_slots, Filter};

#[test]
fn expression_filters_route_through_the_query_engine() {
    // An expression predicate used as a FILTER must give the same count as
    // evaluating it directly — i.e. the query engine and the DSL agree.
    let fixture: Json = serde_json::from_str(include_str!("fixtures/dsl_parity.json")).unwrap();
    let corpus = make_corpus(fixture["corpusN"].as_u64().unwrap() as usize);
    let cache = loaded_cache(&corpus);

    for expr in ["dv01 > 1000", "desk == 'Govies' and currency == 'USD'", "not (desk == 'Govies')"] {
        let want = fixture["predicates"][expr].as_u64().unwrap();
        let filter = Filter::from_json(&json!([{ "expr": expr }]));
        let got = filtered_slots(&cache, &filter).len() as u64;
        assert_eq!(got, want, "expr filter '{expr}': {got} vs js {want}");
    }

    // Expression AND structured conditions compose (AND across nodes).
    let combined = Filter::from_json(&json!([
        { "column": "currency", "op": "equals", "value": "USD" },
        { "expr": "dv01 > 1000" }
    ]));
    let got = filtered_slots(&cache, &combined).len();
    let direct = cache.live_slots().filter(|&s| {
        let ccy = cache.col_index("currency").map(|c| cache.cell(s, c).clone());
        let dv01 = cache.col_index("dv01").map(|c| cache.cell(s, c).clone());
        matches!(ccy, Some(Value::Str(ref x)) if x.as_ref() == "USD")
            && matches!(dv01, Some(Value::Float(v)) if v > 1000.0)
    }).count();
    assert_eq!(got, direct, "expr composes with structured filter via AND");

    // A malformed expression matches NOTHING (never widens the filter).
    let bad = Filter::from_json(&json!([{ "expr": "desk = 'x'" }]));
    assert_eq!(filtered_slots(&cache, &bad).len(), 0, "a bad expression matches nothing");
}
