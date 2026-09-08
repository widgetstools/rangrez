//! Group-aggregate deltas (SSRM "8e").
//!
//! A grouped blotter shows one row per group; every leaf tick moves the
//! aggregate of the group it belongs to. Re-reading the whole grouped view on
//! each change is wasteful, and pushing every leaf delta to a client that only
//! shows groups is pointless. So a `GroupWatch` recomputes the group tree's
//! aggregates over the full cache each tick, diffs them against the last, and
//! pushes ONLY the group paths whose aggregate actually changed (plus any that
//! vanished). The client refreshes exactly those group rows.

use crate::query::{aggregate_over, filtered_slots, group_key_string, group_slots, AggSpec, Filter};
use crate::store::{TableCache, Value};
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
    last: HashMap<Vec<String>, (Aggs, usize, Vec<Json>)>,
    /// Delivery conflation (config: conflation.defaultIntervalMs). Aggregates are
    /// flushed to the subscriber at most this often, coalescing bursts.
    #[allow(dead_code)] conflate_ms: u64,
    #[allow(dead_code)] last_flush: Option<Instant>,
}

impl GroupWatch {
    pub fn new(datasource_id: String, cache: Arc<Mutex<TableCache>>, filter: Filter, group_cols: Vec<String>, aggs: Vec<AggSpec>, conflate_ms: u64) -> GroupWatch {
        GroupWatch { datasource_id, cache, filter, group_cols, aggs, last: HashMap::new(), conflate_ms, last_flush: None }
    }

    /// Aggregates for every group node at every level, keyed by group path.
    fn snapshot(&self) -> HashMap<Vec<String>, (Aggs, usize, Vec<Json>)> {
        let cache = self.cache.lock().unwrap();
        let slots = filtered_slots(&cache, &self.filter);
        let mut out = HashMap::new();
        self.collect(&cache, &slots, &[], &[], 0, &mut out);
        out
    }

    fn collect(&self, cache: &TableCache, slots: &[usize], path: &[String], values: &[Json], level: usize, out: &mut HashMap<Vec<String>, (Aggs, usize, Vec<Json>)>) {
        if level >= self.group_cols.len() { return; }
        for (value, members) in group_slots(cache, slots, &self.group_cols[level]) {
            let mut p = path.to_vec();
            p.push(group_key_string(&value));
            let mut v = values.to_vec();
            v.push(value.to_json());
            out.insert(p.clone(), (aggregate_over(cache, &members, &self.aggs), members.len(), v.clone()));
            self.collect(cache, &members, &p, &v, level + 1, out);
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
