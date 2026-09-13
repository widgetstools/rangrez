//! Group-aggregate deltas (SSRM "8e").
//!
//! A grouped blotter shows one row per group; every leaf tick moves the
//! aggregate of the group it belongs to. Re-reading the whole grouped view on
//! each change is wasteful, and pushing every leaf delta to a client that only
//! shows groups is pointless. So a `GroupWatch` recomputes the group tree's
//! aggregates over the full cache each tick, diffs them against the last, and
//! pushes ONLY the group paths whose aggregate actually changed (plus any that
//! vanished). The client refreshes exactly those group rows.
//!
//! COST, measured in a browser on a 50k-row book grouped desk -> region, nine
//! samples, median, with four plain aggregates:
//!
//! | levels | plain  | + 2 computed columns |
//! |--------|--------|----------------------|
//! | 1      | 15.4ms | 26.4ms               |
//! | 2      | 30.7ms | 45.9ms               |
//! | 3      | 46.2ms | 66.2ms               |
//!
//! `poll()` rebuilds the whole snapshot every tick, so that is the STANDING
//! per-tick cost of a live grouped blotter, not a one-off on regrouping — at a
//! 100ms tick, two levels with computed columns is ~46% of a core. The
//! computed overhead is a fixed ~11ms (the row-scoped pass over every filtered
//! row) plus ~4.5ms per extra level for the per-node folds; evaluating
//! row-scoped columns per node instead of once would have made it ~15ms per
//! level, which is why `snapshot` hoists them.
//!
//! The obvious next move is incremental: `View` already patches its computed
//! memo per revision off the cache's touch log, and this path could diff the
//! touched slots instead of rescanning. Nothing here depends on the full scan
//! except the diff in `poll`, which is already keyed by group path.

use crate::expr::client_aggregate;
use crate::query::{filtered_slots, group_key_string, AggSpec, Filter, MultiAcc};
use crate::store::{TableCache, Value};
use crate::view::{ComputedCol, Scope};
use indexmap::IndexMap;
use serde_json::{json, Value as Json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

type Aggs = IndexMap<String, Value>;

pub struct GroupWatch {
    pub datasource_id: String,
    pub cache: Arc<Mutex<TableCache>>,
    pub filter: Filter,
    pub group_cols: Vec<String>,
    pub aggs: Vec<AggSpec>,
    /// Engine-computed columns, evaluated per node — see `Scope`.
    pub computed: Vec<ComputedCol>,
    scopes: Vec<Scope>,
    /// Every `agg` node across the computed expressions, deduplicated. Folded
    /// once per node, not once per view.
    agg_refs: Vec<(String, String)>,
    last: HashMap<Vec<String>, (Aggs, usize, Vec<Json>)>,
    /// Delivery conflation (config: conflation.defaultIntervalMs). Aggregates are
    /// flushed to the subscriber at most this often, coalescing bursts.
    #[allow(dead_code)] conflate_ms: u64,
    #[allow(dead_code)] last_flush: Option<Instant>,
}

impl GroupWatch {
    pub fn new(datasource_id: String, cache: Arc<Mutex<TableCache>>, filter: Filter, group_cols: Vec<String>, aggs: Vec<AggSpec>, computed: Vec<ComputedCol>, conflate_ms: u64) -> GroupWatch {
        let mut agg_refs: Vec<(String, String)> = Vec::new();
        let mut scopes = Vec::with_capacity(computed.len());
        for cc in &computed {
            scopes.push(cc.scope());
            let mut refs = Vec::new();
            cc.expr.agg_refs(&mut refs);
            for r in refs { if !agg_refs.contains(&r) { agg_refs.push(r); } }
        }
        GroupWatch { datasource_id, cache, filter, group_cols, aggs, computed, scopes, agg_refs,
                     last: HashMap::new(), conflate_ms, last_flush: None }
    }

    fn computed_idx(&self, name: &str) -> Option<usize> {
        self.computed.iter().position(|c| c.name == name)
    }

    /// Aggregates for every group node at every level, keyed by group path.
    fn snapshot(&self) -> HashMap<Vec<String>, (Aggs, usize, Vec<Json>)> {
        let cache = self.cache.lock().unwrap();
        let slots = filtered_slots(&cache, &self.filter);
        // Row-scoped columns are node-independent, so they are evaluated ONCE
        // over the filtered set rather than per node per level. That is what
        // keeps this affordable: a two-level grouping visits every row twice,
        // and re-deriving `spread * dv01` on each visit would double the scan
        // this path is fast because of.
        let row_vals = self.eval_row_scoped(&cache, &slots);
        let mut out = HashMap::new();
        self.collect(&cache, &slots, &[], &[], 0, &row_vals, &mut out);
        out
    }

    /// Evaluate every `Scope::Row` computed column across the filtered set.
    /// Returns `[computed idx][slot]`, empty for columns of other scopes.
    fn eval_row_scoped(&self, cache: &TableCache, slots: &[usize]) -> Vec<Vec<Value>> {
        let n = self.computed.len();
        let mut vals: Vec<Vec<Value>> = vec![Vec::new(); n];
        if n == 0 { return vals; }
        let nslots = cache.slot_count();
        let mut any = false;
        for (k, sc) in self.scopes.iter().enumerate() {
            if *sc == Scope::Row { vals[k] = vec![Value::Null; nslots]; any = true; }
        }
        if !any { return vals; }
        let no_agg = |_: &str, _: &str| Value::Null; // Scope::Row has no agg nodes
        for &slot in slots {
            if !cache.is_live(slot) { continue; }
            let mut rowvals: Vec<Value> = Vec::with_capacity(n);
            for (k, cc) in self.computed.iter().enumerate() {
                if self.scopes[k] != Scope::Row { rowvals.push(Value::Null); continue; }
                let get = |name: &str| -> Value {
                    // An earlier computed column of this same pass, else the
                    // cache. A forward reference reads Null rather than
                    // recursing — declaration order is the contract.
                    if let Some(j) = self.computed_idx(name) {
                        return rowvals.get(j).cloned().unwrap_or(Value::Null);
                    }
                    cache.col_index(name).map(|ci| cache.cell(slot, ci).clone()).unwrap_or(Value::Null)
                };
                rowvals.push(cc.expr.eval(&get, &no_agg));
            }
            for (k, v) in rowvals.into_iter().enumerate() {
                if !vals[k].is_empty() { vals[k][slot] = v; }
            }
        }
        vals
    }

    /// One cell as the group watch sees it: a row-scoped computed column from
    /// the precomputed table, otherwise the raw cache cell.
    fn value_of(&self, cache: &TableCache, slot: usize, name: &str, row_vals: &[Vec<Value>]) -> Value {
        if let Some(k) = self.computed_idx(name) {
            return row_vals[k].get(slot).cloned().unwrap_or(Value::Null);
        }
        cache.col_index(name).map(|ci| cache.cell(slot, ci).clone()).unwrap_or(Value::Null)
    }

    /// Group by one column's value, resolving row-scoped computed columns, so
    /// a grouping level can be an expression the cache never stored.
    fn group_slots_scoped(&self, cache: &TableCache, slots: &[usize], col: &str, row_vals: &[Vec<Value>]) -> Vec<(Value, Vec<usize>)> {
        let mut map: IndexMap<String, (Value, Vec<usize>)> = IndexMap::new();
        for &slot in slots {
            let gv = self.value_of(cache, slot, col, row_vals);
            map.entry(group_key_string(&gv)).or_insert_with(|| (gv, Vec::new())).1.push(slot);
        }
        map.into_iter().map(|(_, v)| v).collect()
    }

    /// Every aggregate this node reports: the requested `AggSpec`s, plus the
    /// caption value of each node-scoped computed column.
    fn node_aggs(&self, cache: &TableCache, members: &[usize], row_vals: &[Vec<Value>]) -> Aggs {
        // 1. Fold each `agg` node over THIS node's members. One scalar set per
        //    node is the difference between a desk's weighted spread and the
        //    whole book's.
        let scalars: Vec<Value> = self.agg_refs.iter().map(|(f, c)| {
            let mut it = members.iter().map(|&slot| self.value_of(cache, slot, c, row_vals));
            client_aggregate(f, &mut it)
        }).collect();
        let agg = |f: &str, c: &str| -> Value {
            self.agg_refs.iter().position(|(af, ac)| af == f && ac == c)
                .and_then(|i| scalars.get(i).cloned()).unwrap_or(Value::Null)
        };

        // 2. Node-scoped computed columns — evaluated once, in declaration
        //    order so a later one can read an earlier one.
        let mut node_vals: Vec<Value> = vec![Value::Null; self.computed.len()];
        for (k, cc) in self.computed.iter().enumerate() {
            if self.scopes[k] != Scope::Node { continue; }
            let v = {
                let get = |name: &str| -> Value {
                    self.computed_idx(name).map(|j| node_vals[j].clone()).unwrap_or(Value::Null)
                };
                cc.expr.eval(&get, &agg)
            };
            node_vals[k] = v;
        }

        // 3. The requested aggregates, over the same members.
        let mut acc = MultiAcc::new(&self.aggs);
        for &slot in members {
            acc.add_row();
            for (si, spec) in self.aggs.iter().enumerate() {
                let cell = match self.computed_idx(&spec.column) {
                    Some(k) => match self.scopes[k] {
                        Scope::Row => row_vals[k].get(slot).cloned().unwrap_or(Value::Null),
                        // Constant across the node; aggregating it is legal
                        // (and `avg` of a constant is that constant).
                        Scope::Node => node_vals[k].clone(),
                        Scope::NodeRow => self.eval_node_row(cache, slot, k, row_vals, &node_vals, &agg),
                    },
                    None => cache.col_index(&spec.column)
                        .map(|ci| cache.query_value(slot, ci)).unwrap_or(Value::Null),
                };
                acc.add(si, spec, &cell);
            }
        }
        let mut out = acc.finish(&self.aggs);

        // 4. Caption values. Only node-scoped columns have one; a row-scoped or
        //    mixed column has no single value here and is reported through
        //    `aggregates` instead, where the client says how to fold it.
        for (k, cc) in self.computed.iter().enumerate() {
            if self.scopes[k] == Scope::Node { out.insert(cc.name.clone(), node_vals[k].clone()); }
        }
        out
    }

    /// A mixed-scope computed column at one row inside one node.
    fn eval_node_row(&self, cache: &TableCache, slot: usize, k: usize, row_vals: &[Vec<Value>], node_vals: &[Value], agg: &dyn Fn(&str, &str) -> Value) -> Value {
        let get = |name: &str| -> Value {
            match self.computed_idx(name) {
                Some(j) => match self.scopes[j] {
                    Scope::Row => row_vals[j].get(slot).cloned().unwrap_or(Value::Null),
                    Scope::Node => node_vals[j].clone(),
                    // A mixed column reading another mixed column would need a
                    // second evaluation order; declaration order does not give
                    // one, so this reads Null rather than recursing.
                    Scope::NodeRow => Value::Null,
                },
                None => cache.col_index(name).map(|ci| cache.cell(slot, ci).clone()).unwrap_or(Value::Null),
            }
        };
        self.computed[k].expr.eval(&get, agg)
    }

    fn collect(&self, cache: &TableCache, slots: &[usize], path: &[String], values: &[Json], level: usize, row_vals: &[Vec<Value>], out: &mut HashMap<Vec<String>, (Aggs, usize, Vec<Json>)>) {
        if level >= self.group_cols.len() { return; }
        for (value, members) in self.group_slots_scoped(cache, slots, &self.group_cols[level], row_vals) {
            let mut p = path.to_vec();
            p.push(group_key_string(&value));
            let mut v = values.to_vec();
            v.push(value.to_json());
            out.insert(p.clone(), (self.node_aggs(cache, &members, row_vals), members.len(), v.clone()));
            self.collect(cache, &members, &p, &v, level + 1, row_vals, out);
        }
    }

    pub fn group_count(&mut self) -> usize {
        if self.last.is_empty() { self.last = self.snapshot(); }
        self.last.len()
    }

    /// Diff the current group aggregates against the last; push the changed and
    /// removed group paths. Returns `None` when nothing moved.
    pub fn poll(&mut self) -> Option<Json> {
        // Native: conflate to at most one flush per `conflate_ms`. On wasm there is
        // no `Instant`; the JS tick interval IS the conflation window.
        #[cfg(not(target_arch = "wasm32"))]
        {
            if let Some(last) = self.last_flush {
                if self.conflate_ms > 0 && (last.elapsed().as_millis() as u64) < self.conflate_ms { return None; }
            }
            self.last_flush = Some(Instant::now());
        }
        let now = self.snapshot();
        let mut changed = Vec::new();
        for (path, (aggs, count, values)) in &now {
            match self.last.get(path) {
                Some((prev_aggs, prev_count, _)) if prev_aggs == aggs && prev_count == count => {}
                _ => changed.push(group_json(path, aggs, *count, values)),
            }
        }
        let removed: Vec<Json> = self.last.keys().filter(|p| !now.contains_key(*p)).map(|p| json!(p)).collect();
        self.last = now;
        if changed.is_empty() && removed.is_empty() { return None; }
        Some(json!({
            "id": format!("g-{}", self.datasource_id),
            "type": "groupDelta",
            "datasourceId": self.datasource_id,
            "groups": changed,
            "removed": removed,
        }))
    }
}

fn group_json(path: &[String], aggs: &Aggs, count: usize, values: &[Json]) -> Json {
    let mut o = serde_json::Map::new();
    o.insert("path".into(), json!(path));
    o.insert("values".into(), json!(values)); // raw group values per level (display + route)
    o.insert("count".into(), json!(count));
    let mut a = serde_json::Map::new();
    for (k, v) in aggs { a.insert(k.clone(), v.to_json()); }
    o.insert("aggregates".into(), Json::Object(a));
    Json::Object(o)
}

/// Parse `aggregates` (`{col: "sum"}` or `[{column, fn, as}]`) into specs.
pub fn parse_aggs(spec: &Json) -> Vec<AggSpec> {
    let mut aggs = Vec::new();
    match spec {
        Json::Object(m) => for (col, f) in m {
            if let Some(agg) = f.as_str().and_then(crate::query::Agg::parse) {
                aggs.push(AggSpec { column: col.clone(), agg, out: col.clone() });
            }
        },
        Json::Array(a) => for s in a {
            if let (Some(col), Some(f)) = (s.get("column").and_then(Json::as_str), s.get("fn").and_then(Json::as_str)) {
                if let Some(agg) = crate::query::Agg::parse(f) {
                    let out = s.get("as").and_then(Json::as_str).unwrap_or(col).to_string();
                    aggs.push(AggSpec { column: col.to_string(), agg, out });
                }
            }
        },
        _ => {}
    }
    aggs
}
