//! The query engine — filter (this module first), then sort/group/aggregate/
//! window layered on top. This is what serves SSRM subscribers: a subscriber's
//! view is a small descriptor, evaluated against the shared cache on demand.
//!
//! Filter semantics are a FAITHFUL port of the JS parity oracle
//! (`packages/dshub-provider/src/parity.mjs` `evalOp`), which was itself
//! calibrated against the live Perspective engine. The rule that matters most:
//! AG-Grid text filters are case-INSENSITIVE, so text comparisons fold to
//! lowercase and blanks fold to "no value". Getting this wrong is exactly the
//! bug that once returned 2,502 rows in one mode and 0 in the other.

use crate::store::Value;
use serde_json::Value as Json;

/// A blank is null or the empty string — the same rule as JS `isBlank`.
fn is_blank(v: &Value) -> bool {
    matches!(v, Value::Null) || matches!(v, Value::Str(s) if s.is_empty())
}

/// Case-folded string for text comparison, or `None` for a blank.
fn fold(v: &Value) -> Option<String> {
    if is_blank(v) { return None; }
    Some(match v {
        Value::Str(s) => s.to_lowercase(),
        Value::Int(i) => i.to_string(),
        Value::Float(f) => format!("{f}"),
        Value::Bool(b) => b.to_string(),
        Value::Null => return None,
    })
}

/// JS `String(x)` for a JSON scalar (used for filter literals).
fn js_string(j: &Json) -> String {
    match j {
        Json::String(s) => s.clone(),
        Json::Number(n) => n.to_string(),
        Json::Bool(b) => b.to_string(),
        Json::Null => "null".to_string(),
        _ => String::new(),
    }
}

/// Fold a filter literal the way the row side folds: null/"" → None.
fn fold_json(j: &Json) -> Option<String> {
    match j {
        Json::Null => None,
        Json::String(s) if s.is_empty() => None,
        _ => Some(js_string(j).to_lowercase()),
    }
}

/// JS `Number(v)` for a row value — guarded by `!is_blank` at the call site.
fn to_number(v: &Value) -> f64 {
    match v {
        Value::Int(i) => *i as f64,
        Value::Float(f) => *f,
        Value::Bool(b) => if *b { 1.0 } else { 0.0 },
        Value::Str(s) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        Value::Null => 0.0,
    }
}

/// JS `Number(op.value)` for a filter literal.
fn num_json(j: &Json) -> f64 {
    match j {
        Json::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Json::String(s) => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        Json::Bool(b) => if *b { 1.0 } else { 0.0 },
        Json::Null => 0.0,
        _ => f64::NAN,
    }
}

/// One leaf condition: `{column, op, value, valueTo}`.
#[derive(Debug, Clone)]
pub struct Leaf {
    pub column: String,
    pub op: String,
    pub value: Json,
    pub value_to: Json,
}

impl Leaf {
    fn from_json(o: &serde_json::Map<String, Json>) -> Leaf {
        Leaf {
            column: o.get("column").and_then(Json::as_str).unwrap_or("").to_string(),
            op: o.get("op").and_then(Json::as_str).unwrap_or("").to_string(),
            value: o.get("value").cloned().unwrap_or(Json::Null),
            value_to: o.get("valueTo").cloned().unwrap_or(Json::Null),
        }
    }

    /// Evaluate this condition against a row cell. Mirrors `evalOp` exactly.
    pub fn eval(&self, v: &Value) -> bool {
        let needle = || fold_json(&self.value).unwrap_or_default();
        match self.op.as_str() {
            "equals" | "equalsIgnoreCase" => { let f = fold(v); f.is_some() && f == fold_json(&self.value) }
            "notEqual" | "notEqualIgnoreCase" => fold(v) != fold_json(&self.value),
            "contains"    => fold(v).map_or(false, |s| s.contains(&needle())),
            "notContains" => fold(v).map_or(true, |s| !s.contains(&needle())),
            "startsWith"  => fold(v).map_or(false, |s| s.starts_with(&needle())),
            "endsWith"    => fold(v).map_or(false, |s| s.ends_with(&needle())),
            "greaterThan"        => !is_blank(v) && to_number(v) >  num_json(&self.value),
            "greaterThanOrEqual" => !is_blank(v) && to_number(v) >= num_json(&self.value),
            "lessThan"           => !is_blank(v) && to_number(v) <  num_json(&self.value),
            "lessThanOrEqual"    => !is_blank(v) && to_number(v) <= num_json(&self.value),
            "inRange" => !is_blank(v) && to_number(v) >= num_json(&self.value) && to_number(v) <= num_json(&self.value_to),
            "blank"    => is_blank(v),
            "notBlank" => !is_blank(v),
            "in" => {
                // Empty set matches NOTHING; elements folded, null preserved as None.
                let row = fold(v);
                match &self.value {
                    Json::Array(items) => items.iter().any(|x| {
                        let want = if x.is_null() { None } else { Some(js_string(x).to_lowercase()) };
                        want == row
                    }),
                    _ => false,
                }
            }
            other => {
                debug_assert!(false, "unknown filter op {other:?}");
                false
            }
        }
    }
}

/// A condition node: a leaf, an OR of leaves (the quick-filter shape), or a DSL
/// expression predicate (`{"expr": "dv01 > 1000 and desk == 'Govies'"}`).
#[derive(Debug, Clone)]
pub enum Cond {
    Leaf(Leaf),
    Or(Vec<Leaf>),
    Expr(crate::dsl::Ast),
    /// An expression that failed to parse — matches nothing rather than silently
    /// passing every row (a bad predicate must not widen a filter).
    BadExpr,
}

/// A whole filter: AND across nodes, `or` nodes are any-of.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub nodes: Vec<Cond>,
}

impl Filter {
    /// Parse the control-protocol `view.filter` array.
    pub fn from_json(filter: &Json) -> Filter {
        let mut nodes = Vec::new();
        if let Some(arr) = filter.as_array() {
            for item in arr {
                let Some(o) = item.as_object() else { continue; };
                // A DSL expression predicate.
                if let Some(expr) = o.get("expr").and_then(Json::as_str) {
                    nodes.push(match crate::dsl::parse(expr) {
                        Ok(ast) => Cond::Expr(ast),
                        Err(_) => Cond::BadExpr,
                    });
                    continue;
                }
                let is_or = o.get("op").and_then(Json::as_str) == Some("or");
                if is_or {
                    let leaves = o.get("conditions").and_then(Json::as_array).map(|cs| {
                        cs.iter().filter_map(|c| c.as_object().map(Leaf::from_json)).collect()
                    }).unwrap_or_default();
                    nodes.push(Cond::Or(leaves));
                } else {
                    nodes.push(Cond::Leaf(Leaf::from_json(o)));
                }
            }
        }
        Filter { nodes }
    }

    pub fn is_empty(&self) -> bool { self.nodes.is_empty() }

    /// Does a row match? `get(column)` returns the row's cell for that column.
    pub fn matches(&self, get: &impl Fn(&str) -> Value) -> bool {
        self.nodes.iter().all(|node| match node {
            Cond::Leaf(l) => l.eval(&get(&l.column)),
            Cond::Or(leaves) => leaves.iter().any(|l| l.eval(&get(&l.column))),
            Cond::Expr(ast) => {
                let dget = |name: &str| crate::dsl::DslValue::from_cell(&get(name));
                crate::dsl::is_truthy(&crate::dsl::eval(ast, &dget))
            }
            Cond::BadExpr => false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn get(map: &serde_json::Map<String, Json>) -> impl Fn(&str) -> Value + '_ {
        move |c: &str| map.get(c).map(Value::from_json).unwrap_or(Value::Null)
    }

    #[test]
    fn case_insensitive_equals_and_blank_handling() {
        let row = json!({"desk":"Govies","book":""}).as_object().unwrap().clone();
        let f = Filter::from_json(&json!([{"column":"desk","op":"equals","value":"govies"}]));
        assert!(f.matches(&get(&row)), "lowercase literal matches Govies");
        let b = Filter::from_json(&json!([{"column":"book","op":"blank"}]));
        assert!(b.matches(&get(&row)), "empty string is blank");
    }

    #[test]
    fn empty_in_matches_nothing() {
        let row = json!({"desk":"Govies"}).as_object().unwrap().clone();
        let f = Filter::from_json(&json!([{"column":"desk","op":"in","value":[]}]));
        assert!(!f.matches(&get(&row)));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sort, group + aggregate, window — the rest of the SSRM path.
// ─────────────────────────────────────────────────────────────────────────────

use crate::store::TableCache;
use indexmap::IndexMap;
use std::cmp::Ordering;

/// One sort directive.
#[derive(Debug, Clone)]
pub struct SortKey { pub column: String, pub desc: bool }

impl SortKey {
    /// Parse an AG-Grid sortModel entry `{colId, sort}`.
    pub fn list_from_json(sort: &Json) -> Vec<SortKey> {
        sort.as_array().map(|a| a.iter().filter_map(|s| {
            let o = s.as_object()?;
            let column = o.get("colId").or_else(|| o.get("column")).and_then(Json::as_str)?.to_string();
            let desc = o.get("sort").and_then(Json::as_str) == Some("desc");
            Some(SortKey { column, desc })
        }).collect()).unwrap_or_default()
    }
}

/// Total order over cells: nulls last, numbers numeric, strings lexicographic,
/// with a stable type rank so mixed columns never panic. Ascending; the caller
/// flips for descending.
pub fn compare_values(a: &Value, b: &Value) -> Ordering {
    fn rank(v: &Value) -> u8 { match v { Value::Null => 3, Value::Bool(_) => 2, Value::Str(_) => 1, _ => 0 } }
    let (na, nb) = (matches!(a, Value::Int(_) | Value::Float(_)), matches!(b, Value::Int(_) | Value::Float(_)));
    if na && nb {
        return num(a).partial_cmp(&num(b)).unwrap_or(Ordering::Equal);
    }
    match (a, b) {
        (Value::Str(x), Value::Str(y)) => x.cmp(y),
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        _ => rank(a).cmp(&rank(b)),
    }
}

fn num(v: &Value) -> f64 { match v { Value::Int(i) => *i as f64, Value::Float(f) => *f, _ => f64::NAN } }

/// Does one slot pass the filter?
///
/// Extracted so the full scan below and the incremental view patch evaluate the
/// predicate through the SAME code. Two implementations of "is this row in the
/// view" that disagree on one operator produce a view that is right after a
/// rebuild and wrong after a patch — an inconsistency that would surface as rows
/// appearing and disappearing as the feed ticks, with nothing to point at.
pub fn row_matches(cache: &TableCache, filter: &Filter, slot: usize) -> bool {
    if filter.is_empty() { return true; }
    let get = |col: &str| cache.col_index(col).map(|ci| cache.query_value(slot, ci)).unwrap_or(Value::Null);
    filter.matches(&get)
}

/// The filtered set of live slots, in slot order.
pub fn filtered_slots(cache: &TableCache, filter: &Filter) -> Vec<usize> {
    cache.live_slots().filter(|&slot| row_matches(cache, filter, slot)).collect()
}

/// Sort slots by a multi-column key. Stable, so equal keys keep slot order.
pub fn sort_slots(cache: &TableCache, slots: &mut [usize], keys: &[SortKey]) {
    if keys.is_empty() { return; }
    let idx: Vec<(usize, bool)> = keys.iter()
        .filter_map(|k| cache.col_index(&k.column).map(|ci| (ci, k.desc))).collect();
    slots.sort_by(|&x, &y| {
        for &(ci, desc) in &idx {
            let ord = compare_values(&cache.query_value(x, ci), &cache.query_value(y, ci));
            let ord = if desc { ord.reverse() } else { ord };
            if ord != Ordering::Equal { return ord; }
        }
        Ordering::Equal
    });
}

/// A group-level aggregate function.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Agg { Sum, Avg, Min, Max, Count, Median, Stdev, Variance, DistinctCount }

impl Agg {
    pub fn parse(s: &str) -> Option<Agg> {
        Some(match s {
            "sum" => Agg::Sum,
            "avg" | "mean" => Agg::Avg,
            "min" => Agg::Min,
            "max" => Agg::Max,
            "count" => Agg::Count,
            "median" => Agg::Median,
            "stdev" | "stddev" => Agg::Stdev,
            "variance" => Agg::Variance,
            "distinct_count" | "distinctCount" => Agg::DistinctCount,
            _ => return None,
        })
    }

    /// Whether this aggregate needs every member value retained (not just the
    /// running sum/min/max) — the accumulator collects a list only when a spec
    /// actually asks for one of these.
    fn needs_values(self) -> bool {
        matches!(self, Agg::Median | Agg::Stdev | Agg::Variance)
    }
}

/// One aggregate to compute: `fn(column)`, output-named.
#[derive(Debug, Clone)]
pub struct AggSpec { pub column: String, pub agg: Agg, pub out: String }

/// A group row: the group's value, its leaf count, and its aggregates.
#[derive(Debug, Clone)]
pub struct GroupRow {
    pub value: Value,
    pub count: usize,
    pub aggregates: IndexMap<String, Value>,
}

/// Per-spec accumulation shared by grouped and flat aggregation — and by the
/// view layer, which feeds it COMPUTED column values the cache cannot resolve.
/// Blank and non-numeric cells are skipped (AG-Grid group-aggregate semantics;
/// the expression language's own aggregate scalars use `expr::client_aggregate`
/// instead, which follows the client's `toNum` folds).
pub struct MultiAcc {
    count: usize,
    sum: Vec<f64>,
    n: Vec<usize>,
    min: Vec<f64>,
    max: Vec<f64>,
    /// Collected member values, only for specs whose agg `needs_values`.
    vals: Vec<Vec<f64>>,
    /// Distinct non-blank values (type-tagged), only for DistinctCount specs.
    distinct: Vec<std::collections::HashSet<String>>,
}

impl MultiAcc {
    pub fn new(specs: &[AggSpec]) -> MultiAcc {
        MultiAcc {
            count: 0,
            sum: vec![0.0; specs.len()],
            n: vec![0; specs.len()],
            min: vec![f64::INFINITY; specs.len()],
            max: vec![f64::NEG_INFINITY; specs.len()],
            vals: specs.iter().map(|_| Vec::new()).collect(),
            distinct: specs.iter().map(|_| std::collections::HashSet::new()).collect(),
        }
    }

    /// Count one member row (independent of per-spec cells, for Count).
    pub fn add_row(&mut self) { self.count += 1; }

    /// Member rows folded so far.
    pub fn count(&self) -> usize { self.count }

    /// Fold one spec's cell for one member row.
    pub fn add(&mut self, si: usize, spec: &AggSpec, cell: &Value) {
        if spec.agg == Agg::DistinctCount {
            if !is_blank(cell) { self.distinct[si].insert(group_key(cell)); }
            return;
        }
        if is_blank(cell) { return; }
        let x = to_number(cell);
        if x.is_nan() { return; }
        self.sum[si] += x;
        self.n[si] += 1;
        if x < self.min[si] { self.min[si] = x; }
        if x > self.max[si] { self.max[si] = x; }
        if spec.agg.needs_values() { self.vals[si].push(x); }
    }

    pub fn finish(mut self, specs: &[AggSpec]) -> IndexMap<String, Value> {
        let mut out = IndexMap::new();
        for (si, spec) in specs.iter().enumerate() {
            let v = match spec.agg {
                Agg::Sum => Value::Float(self.sum[si]),
                Agg::Avg => if self.n[si] > 0 { Value::Float(self.sum[si] / self.n[si] as f64) } else { Value::Null },
                Agg::Min => if self.n[si] > 0 { Value::Float(self.min[si]) } else { Value::Null },
                Agg::Max => if self.n[si] > 0 { Value::Float(self.max[si]) } else { Value::Null },
                Agg::Count => Value::Int(self.count as i64),
                Agg::DistinctCount => Value::Int(self.distinct[si].len() as i64),
                Agg::Median => {
                    let vals = &mut self.vals[si];
                    if vals.is_empty() { Value::Null } else {
                        vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
                        let mid = vals.len() / 2;
                        Value::Float(if vals.len() % 2 == 0 { (vals[mid - 1] + vals[mid]) / 2.0 } else { vals[mid] })
                    }
                }
                Agg::Stdev | Agg::Variance => {
                    let vals = &self.vals[si];
                    if vals.len() <= 1 { Value::Null } else {
                        let mean = self.sum[si] / vals.len() as f64;
                        let var = vals.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / (vals.len() - 1) as f64;
                        Value::Float(if spec.agg == Agg::Stdev { var.sqrt() } else { var })
                    }
                }
            };
            out.insert(spec.out.clone(), v);
        }
        out
    }
}

/// Group filtered slots by one column and compute aggregates per group.
/// Group order is first-seen (insertion); the caller sorts if needed.
pub fn aggregate_groups(cache: &TableCache, slots: &[usize], group_col: &str, specs: &[AggSpec]) -> Vec<GroupRow> {
    let Some(gci) = cache.col_index(group_col) else { return Vec::new(); };
    let spec_idx: Vec<Option<usize>> = specs.iter().map(|s| cache.col_index(&s.column)).collect();
    let mut groups: IndexMap<String, (Value, MultiAcc)> = IndexMap::new();

    for &slot in slots {
        let gv = cache.cell(slot, gci).clone();
        let gkey = group_key(&gv);
        let (_, acc) = groups.entry(gkey).or_insert_with(|| (gv, MultiAcc::new(specs)));
        acc.add_row();
        for (si, ci) in spec_idx.iter().enumerate() {
            let Some(ci) = ci else { continue; };
            acc.add(si, &specs[si], &cache.query_value(slot, *ci));
        }
    }

    groups.into_iter().map(|(_, (value, acc))| {
        let count = acc.count();
        GroupRow { value, count, aggregates: acc.finish(specs) }
    }).collect()
}

/// Group slots by a column, preserving first-seen order, returning each group's
/// value and its member slots — the tree-building primitive for SSRM views.
pub fn group_slots(cache: &TableCache, slots: &[usize], group_col: &str) -> Vec<(Value, Vec<usize>)> {
    let Some(gci) = cache.col_index(group_col) else { return Vec::new(); };
    let mut order: Vec<String> = Vec::new();
    let mut map: IndexMap<String, (Value, Vec<usize>)> = IndexMap::new();
    for &slot in slots {
        let gv = cache.cell(slot, gci).clone();
        let key = group_key(&gv);
        map.entry(key.clone()).or_insert_with(|| { order.push(key); (gv, Vec::new()) }).1.push(slot);
    }
    map.into_iter().map(|(_, v)| v).collect()
}

/// Public group-key string (stable, case-sensitive) for view paths.
pub fn group_key_string(v: &Value) -> String { group_key(v) }

/// Canonical, case-sensitive group key (Perspective groups distinct values).
fn group_key(v: &Value) -> String {
    match v {
        Value::Null => "\u{0}\u{0}null".to_string(),
        Value::Str(s) => format!("s{s}"),
        Value::Int(i) => format!("i{i}"),
        Value::Float(f) => format!("f{f}"),
        Value::Bool(b) => format!("b{b}"),
    }
}

/// Slice `[start, end)` of any row list, clamped — the block window SSRM asks for.
pub fn window<T: Clone>(rows: &[T], start: usize, end: usize) -> Vec<T> {
    let s = start.min(rows.len());
    let e = end.min(rows.len());
    if s >= e { Vec::new() } else { rows[s..e].to_vec() }
}

#[cfg(test)]
mod engine_tests {
    use super::*;
    use crate::store::TableCache;
    use serde_json::json;

    fn cache() -> TableCache {
        let mut t = TableCache::new(["k", "desk", "qty", "px"]);
        for (k, d, q, p) in [
            ("a", "Govies", 10, 100.0), ("b", "Govies", 20, 50.0),
            ("c", "EM", 5, 200.0), ("d", "EM", 5, 300.0),
        ] {
            t.upsert(k, json!({"k":k,"desk":d,"qty":q,"px":p}).as_object().unwrap());
        }
        t
    }

    #[test]
    fn sort_multi_column_asc_desc_nulls_last() {
        let t = cache();
        let mut slots = filtered_slots(&t, &Filter::default());
        sort_slots(&t, &mut slots, &[SortKey { column: "desk".into(), desc: false }, SortKey { column: "px".into(), desc: true }]);
        let keys: Vec<_> = slots.iter().map(|&s| t.key_at(s).unwrap().to_string()).collect();
        assert_eq!(keys, ["d", "c", "a", "b"], "EM before Govies; within, px desc");
    }

    #[test]
    fn group_by_desk_with_sum_avg_min_max_count() {
        let t = cache();
        let slots = filtered_slots(&t, &Filter::default());
        let specs = vec![
            AggSpec { column: "qty".into(), agg: Agg::Sum, out: "qty".into() },
            AggSpec { column: "px".into(),  agg: Agg::Avg, out: "px".into() },
            AggSpec { column: "qty".into(), agg: Agg::Min, out: "minq".into() },
        ];
        let mut groups = aggregate_groups(&t, &slots, "desk", &specs);
        groups.sort_by(|a, b| compare_values(&a.value, &b.value));
        assert_eq!(groups.len(), 2);
        let em = &groups[0];
        assert_eq!(em.value, Value::Str("EM".into()));
        assert_eq!(em.count, 2);
        assert_eq!(em.aggregates["qty"], Value::Float(10.0));   // 5+5
        assert_eq!(em.aggregates["px"], Value::Float(250.0));   // (200+300)/2
        let gov = &groups[1];
        assert_eq!(gov.aggregates["qty"], Value::Float(30.0));  // 10+20
        assert_eq!(gov.aggregates["minq"], Value::Float(10.0));
    }

    #[test]
    fn window_clamps() {
        let v = vec![1, 2, 3, 4, 5];
        assert_eq!(window(&v, 1, 3), vec![2, 3]);
        assert_eq!(window(&v, 3, 100), vec![4, 5]);
        assert_eq!(window(&v, 10, 20), Vec::<i32>::new());
    }
}

/// Aggregate over a flat slot set (no grouping) — status-bar / footer totals.
/// The same accumulation as `aggregate_groups`, collapsed to one group.
pub fn aggregate_over(cache: &TableCache, slots: &[usize], specs: &[AggSpec]) -> IndexMap<String, Value> {
    let spec_idx: Vec<Option<usize>> = specs.iter().map(|s| cache.col_index(&s.column)).collect();
    let mut acc = MultiAcc::new(specs);
    for &slot in slots {
        acc.add_row();
        for (si, ci) in spec_idx.iter().enumerate() {
            let Some(ci) = ci else { continue; };
            acc.add(si, &specs[si], &cache.query_value(slot, *ci));
        }
    }
    acc.finish(specs)
}
