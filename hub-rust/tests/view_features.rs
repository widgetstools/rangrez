//! Engine-side coverage for plan §12 phases T3–T7: computed columns on views,
//! the extended aggregate set, membership deltas, typed date columns, and
//! pivot completeness. These drive `View` exactly the way the wasm control
//! layer does — `ViewSpec::from_json` + window reads — so the shapes pinned
//! here are the shapes the starui plane sees.

use dshub::hub::Hub;
use dshub::registry::Registry;
use dshub::store::TableCache;
use dshub::view::{View, ViewSpec};
use serde_json::{json, Value as Json};
use std::sync::{Arc, Mutex};

fn book() -> Arc<Mutex<TableCache>> {
    let mut c = TableCache::new(["id", "desk", "ccy", "qty", "px", "traded"]);
    c.set_date_columns(["traded"]);
    c.begin_batch();
    for (id, desk, ccy, qty, px, traded) in [
        ("a", "Govies", "USD", 10, 100.0, "2026-03-05"),
        ("b", "Govies", "EUR", 20, 50.0, "2026-01-20"),
        ("c", "EM", "USD", 5, 200.0, "2026-07-01"),
        ("d", "EM", "EUR", 5, 300.0, "2025-11-30"),
    ] {
        c.upsert(id, json!({"id": id, "desk": desk, "ccy": ccy, "qty": qty, "px": px, "traded": traded}).as_object().unwrap());
    }
    c.end_batch();
    Arc::new(Mutex::new(c))
}

fn view(cache: Arc<Mutex<TableCache>>, spec: Json) -> View {
    let spec = ViewSpec::from_json(&spec);
    assert!(spec.computed_errors.is_empty(), "spec must parse: {:?}", spec.computed_errors);
    View::new(cache, spec, "s1".into())
}

/// `[qty] * [px]` as a wire AST — the shape `compileToEngineExpression` emits.
fn notional_expr() -> Json {
    json!({"k": "bin", "op": "mul", "l": {"k": "col", "name": "qty"}, "r": {"k": "col", "name": "px"}})
}

// ---------------------------------------------------------------------- T3

#[test]
fn computed_column_rides_every_leaf_row() {
    let mut v = view(book(), json!({"computed": [{"as": "notional", "expr": notional_expr()}]}));
    let (rows, total) = v.read_window(0, None);
    assert_eq!(total, 4);
    let a = rows.iter().find(|r| r["id"] == "a").unwrap();
    assert_eq!(a["notional"], json!(1000.0), "10 * 100");
}

#[test]
fn filter_sort_and_group_all_resolve_computed_columns() {
    // Filter: notional >= 1000 keeps a (1000), c (1000), d (1500); drops b (1000? 20*50=1000) — use > 1000.
    let mut v = view(book(), json!({
        "computed": [{"as": "notional", "expr": notional_expr()}],
        "filter": [{"column": "notional", "op": "greaterThan", "value": 1000}],
        "sort": [{"column": "notional", "sort": "desc"}],
    }));
    let (rows, total) = v.read_window(0, None);
    assert_eq!(total, 1, "only d has notional 1500 > 1000");
    assert_eq!(rows[0]["id"], "d");

    // Sort desc over the full set orders by the computed value.
    let mut v = view(book(), json!({
        "computed": [{"as": "notional", "expr": notional_expr()}],
        "sort": [{"column": "notional", "sort": "desc"}, {"column": "id", "sort": "asc"}],
    }));
    let (rows, _) = v.read_window(0, None);
    let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["d", "a", "b", "c"], "1500, then the three 1000s by id");

    // Group by a computed bucket, aggregate a computed column.
    let bucket = json!({"k": "cond",
        "branches": [{"when": {"k": "bin", "op": "gt", "l": {"k": "col", "name": "px"}, "r": {"k": "lit", "v": 150}},
                      "then": {"k": "lit", "v": "RICH"}}],
        "else": {"k": "lit", "v": "CHEAP"}});
    let mut v = view(book(), json!({
        "computed": [
            {"as": "bucket", "expr": bucket},
            {"as": "notional", "expr": notional_expr()},
        ],
        "groupBy": ["bucket"],
        "aggregates": [{"column": "notional", "fn": "sum", "as": "notional"}],
    }));
    let (rows, _) = v.read_window(0, None);
    let cheap = rows.iter().find(|r| r["bucket"] == "CHEAP").unwrap();
    assert_eq!(cheap["__count"], json!(2), "a and b");
    assert_eq!(cheap["notional"], json!(2000.0));
    let rich = rows.iter().find(|r| r["bucket"] == "RICH").unwrap();
    assert_eq!(rich["notional"], json!(2500.0), "c 1000 + d 1500");
}

#[test]
fn computed_values_patch_with_the_feed_and_agg_scalars_track_the_filtered_set() {
    let cache = book();
    // share = notional / SUM(notional over the view) … but agg cols are cache
    // columns in v1 usage; use share of qty: [qty] / SUM([qty]).
    let mut v = view(cache.clone(), json!({
        "computed": [{"as": "share", "expr": {"k": "bin", "op": "div",
            "l": {"k": "col", "name": "qty"},
            "r": {"k": "agg", "fn": "sum", "col": "qty"}}}],
    }));
    let (rows, _) = v.read_window(0, None);
    let a = rows.iter().find(|r| r["id"] == "a").unwrap();
    assert_eq!(a["share"], json!(0.25), "10 / 40");

    // A feed tick moves qty; the memo patches and the scalar re-derives.
    cache.lock().unwrap().upsert("a", json!({"qty": 30}).as_object().unwrap());
    let (rows, _) = v.read_window(0, None);
    let a = rows.iter().find(|r| r["id"] == "a").unwrap();
    assert_eq!(a["share"], json!(0.5), "30 / 60 after the tick");
}

#[test]
fn half_parsed_computed_columns_reject_the_view() {
    let mut hub = Hub::from_registry(Registry::empty(), 1, "t");
    hub.register_datasource(dshub::registry::Datasource {
        id: "positions".into(), columns: vec!["id".into(), "qty".into()],
        key_columns: vec!["id".into()], ..Default::default()
    });
    hub.subscribe("positions", &json!({}), "s1").unwrap();
    let err = hub.open_view("positions", &json!({}), &json!({
        "computed": [{"as": "bad", "expr": {"k": "fn", "name": "REGEX_MATCH", "args": []}}]
    })).unwrap_err();
    assert!(err.contains("REGEX_MATCH"), "error names the offender: {err}");
}

// ---------------------------------------------------------------------- T4

#[test]
fn extended_aggregates_compute_per_group() {
    let mut v = view(book(), json!({
        "groupBy": ["desk"],
        "aggregates": [
            {"column": "px", "fn": "median", "as": "medPx"},
            {"column": "px", "fn": "stdev", "as": "sdPx"},
            {"column": "px", "fn": "variance", "as": "varPx"},
            {"column": "ccy", "fn": "distinct_count", "as": "ccys"},
        ],
    }));
    let (rows, _) = v.read_window(0, None);
    let em = rows.iter().find(|r| r["desk"] == "EM").unwrap();
    assert_eq!(em["medPx"], json!(250.0), "median of 200, 300");
    assert_eq!(em["varPx"], json!(5000.0), "sample variance of 200, 300");
    assert!((em["sdPx"].as_f64().unwrap() - 5000f64.sqrt()).abs() < 1e-9);
    assert_eq!(em["ccys"], json!(2), "USD and EUR");
}

// ---------------------------------------------------------------------- T5

#[test]
fn watch_view_reports_entered_and_left_rows() {
    let cache = book();
    let mut v = view(cache.clone(), json!({
        "watch": true,
        "filter": [{"column": "px", "op": "greaterThan", "value": 150}],
    }));
    // First call primes silently: c and d are already in the set.
    assert!(v.membership_delta(10).is_none(), "priming call is silent");
    // Quiet revision → no delta.
    assert!(v.membership_delta(10).is_none());

    // b rallies through the threshold; c drops out.
    {
        let mut c = cache.lock().unwrap();
        c.begin_batch();
        c.upsert("b", json!({"px": 260.0}).as_object().unwrap());
        c.upsert("c", json!({"px": 90.0}).as_object().unwrap());
        c.end_batch();
    }
    let (entered, left, rows) = v.membership_delta(10).expect("transitions must report");
    assert_eq!(entered, ["b"]);
    assert_eq!(left, ["c"]);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["px"], json!(260.0), "entered row is materialized at current values");

    // Watch off → never a delta.
    let mut plain = view(cache, json!({"filter": [{"column": "px", "op": "greaterThan", "value": 150}]}));
    assert!(plain.membership_delta(10).is_none());
}

// ---------------------------------------------------------------------- T6

#[test]
fn date_columns_sort_and_range_filter_as_instants_but_display_as_strings() {
    // "2025-11-30" < "2026-01-20" < "2026-03-05" < "2026-07-01" — chronological
    // sort. (Lexicographic ISO agrees; the epoch path is what makes NUMERIC
    // range filters from the client's day-window model work.)
    let mut v = view(book(), json!({"sort": [{"column": "traded", "sort": "asc"}]}));
    let (rows, _) = v.read_window(0, None);
    let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["d", "b", "a", "c"]);
    assert_eq!(rows[0]["traded"], json!("2025-11-30"), "display keeps the feed's string");

    // The client's date filter sends NUMERIC epoch bounds against the column.
    let jan1_2026 = 1_767_225_600_000i64; // 2026-01-01T00:00:00Z
    let jun1_2026 = 1_780_272_000_000i64; // 2026-06-01T00:00:00Z
    let mut v = view(book(), json!({
        "filter": [{"column": "traded", "op": "inRange", "value": jan1_2026, "valueTo": jun1_2026}],
    }));
    let (rows, total) = v.read_window(0, None);
    assert_eq!(total, 2, "b and a fall in H1 2026");
    let mut ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    ids.sort();
    assert_eq!(ids, ["a", "b"]);
}

#[test]
fn date_functions_read_the_stored_string() {
    let mut v = view(book(), json!({
        "computed": [{"as": "y", "expr": {"k": "fn", "name": "YEAR", "args": [{"k": "col", "name": "traded"}]}}],
        "filter": [{"column": "y", "op": "equals", "value": 2025}],
    }));
    let (rows, total) = v.read_window(0, None);
    assert_eq!(total, 1);
    assert_eq!(rows[0]["id"], "d");
    assert_eq!(rows[0]["y"], json!(2025.0));
}

// ---------------------------------------------------------------------- T7

#[test]
fn groupless_pivot_yields_one_grand_total_row() {
    let mut v = view(book(), json!({
        "splitBy": ["ccy"],
        "aggregates": [{"column": "qty", "fn": "sum", "as": "qty"}],
    }));
    assert_eq!(v.num_rows(), 1);
    let (rows, total) = v.read_window(0, None);
    assert_eq!(total, 1);
    assert_eq!(rows[0]["__pivotTotal"], json!(true));
    assert_eq!(rows[0]["__count"], json!(4));
    assert_eq!(rows[0]["USD|qty"], json!(15.0), "a 10 + c 5");
    assert_eq!(rows[0]["EUR|qty"], json!(25.0), "b 20 + d 5");
}

#[test]
fn pivot_keys_fold_the_separator_out_of_split_values() {
    let cache = book();
    cache.lock().unwrap().upsert("e", json!({"id": "e", "desk": "Govies", "ccy": "X|Y", "qty": 7, "px": 1.0, "traded": "2026-02-02"}).as_object().unwrap());
    let mut v = view(cache, json!({
        "groupBy": ["desk"],
        "splitBy": ["ccy"],
        "aggregates": [{"column": "qty", "fn": "sum", "as": "qty"}],
    }));
    let (rows, _) = v.read_window(0, None);
    let gov = rows.iter().find(|r| r["desk"] == "Govies").unwrap();
    assert_eq!(gov["X¦Y|qty"], json!(7.0), "the value's own pipe is folded to ¦");
    assert!(gov.get("X|Y|qty").is_none(), "raw separator must not leak into a field name");
}
