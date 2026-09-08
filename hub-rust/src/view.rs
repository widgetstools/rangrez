//! Server-side views — the SSRM/VRM model.
//!
//! The in-browser hub opens a Perspective view per handle and reads windows /
//! expands nodes on it. The Rust hub has no engine view, so a `View` is a stored
//! spec (filter, sort, group-by, aggregates) plus expansion state, materialized
//! against the shared cache on demand. Expand/collapse is BY ROW INDEX into the
//! flattened tree — "one view for the entire tree, mutated in place" — which is
//! exactly what AG-Grid's VRM expects and what `expandRow` drives.

use crate::query::{
    aggregate_over, filtered_slots, group_key_string, group_slots, sort_slots, AggSpec, Agg, Filter, SortKey,
};
use crate::store::{TableCache, Value};
use serde_json::{json, Value as Json};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

/// A parsed view spec.
pub struct ViewSpec {
    pub filter: Filter,
    pub sort: Vec<SortKey>,
    pub group_cols: Vec<String>,
    pub aggs: Vec<AggSpec>,
}

impl ViewSpec {
    pub fn from_json(spec: &Json) -> ViewSpec {
        let filter = Filter::from_json(spec.get("filter").unwrap_or(&Json::Null));
        let sort = SortKey::list_from_json(spec.get("sort").unwrap_or(&Json::Null));
        let group_cols = spec.get("groupBy").and_then(Json::as_array)
            .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        // aggregates as {col: "sum"} or [{column, fn, as}]
        let mut aggs = Vec::new();
        match spec.get("aggregates") {
            Some(Json::Object(m)) => for (col, f) in m {
                if let Some(agg) = f.as_str().and_then(Agg::parse) {
                    aggs.push(AggSpec { column: col.clone(), agg, out: col.clone() });
                }
            },
            Some(Json::Array(a)) => for s in a {
                if let (Some(col), Some(f)) = (s.get("column").and_then(Json::as_str), s.get("fn").and_then(Json::as_str)) {
                    if let Some(agg) = Agg::parse(f) {
                        let out = s.get("as").and_then(Json::as_str).unwrap_or(col).to_string();
                        aggs.push(AggSpec { column: col.to_string(), agg, out });
                    }
                }
            },
            _ => {}
        }
        ViewSpec { filter, sort, group_cols, aggs }
    }
}

pub struct View {
    pub cache: Arc<Mutex<TableCache>>,
    pub spec: ViewSpec,
    pub session_id: String,
    expanded: HashSet<Vec<String>>,
    /// The view's slot order, valid ONLY for the cache revision it was built at.
    ///
    /// Every read used to re-run `filtered_slots` over the whole table and, for a
    /// flat view, re-sort it. That cost does not shrink with a selective filter —
    /// the scan is over every live slot regardless — so a blotter scrolling
    /// through blocks paid a full-table pass per block, and ten blotters paid ten.
    /// Now the work happens once per revision and every read inside it is a slice.
    ///
    /// This only became possible once ingest started batching revisions: while
    /// `rev` advanced per row, a memo stamped with it was stale before it could
    /// be read twice.
    memo: Option<SlotMemo>,
}

/// A materialized slot order plus the revision that produced it.
struct SlotMemo {
    revision: u64,
    /// Filtered slots; additionally sorted when the view is flat (a grouped view
    /// sorts leaves within each group, so the pre-group order is irrelevant).
    slots: Vec<usize>,
}

impl View {
    pub fn new(cache: Arc<Mutex<TableCache>>, spec: ViewSpec, session_id: String) -> View {
        View { cache, spec, session_id, expanded: HashSet::new(), memo: None }
    }

    /// Rebuild the slot order if the cache has moved since it was built.
    ///
    /// Deliberately keyed on revision alone, not on expansion state: expanding a
    /// group changes which rows are VISIBLE, never which rows pass the filter.
    fn refresh_memo(&mut self, cache: &TableCache) {
        let revision = cache.revision();
        if matches!(&self.memo, Some(m) if m.revision == revision) { return; }
        let mut slots = filtered_slots(cache, &self.spec.filter);
        if self.spec.group_cols.is_empty() {
            sort_slots(cache, &mut slots, &self.spec.sort);
        }
        self.memo = Some(SlotMemo { revision, slots });
    }

    /// The memoized slot order. Call `refresh_memo` first.
    fn slots(&self) -> &[usize] {
        self.memo.as_ref().map(|m| m.slots.as_slice()).unwrap_or(&[])
    }

    /// Number of times the order was rebuilt — diagnostics for the memo's value.
    pub fn memo_revision(&self) -> Option<u64> { self.memo.as_ref().map(|m| m.revision) }

    /// The flattened visible rows (group rows + leaves under expanded nodes).
    fn flatten(&mut self) -> Vec<Json> {
        let cache_arc = self.cache.clone();
        let cache = cache_arc.lock().unwrap();
        self.refresh_memo(&cache);
        let mut out = Vec::new();
        if self.spec.group_cols.is_empty() {
            for &s in self.slots() { if let Some(r) = cache.row_json(s) { out.push(r); } }
        } else {
            self.emit_level(&cache, self.slots(), &[], 0, &mut out);
        }
        out
    }

    fn emit_level(&self, cache: &TableCache, slots: &[usize], path: &[String], level: usize, out: &mut Vec<Json>) {
        let group_col = &self.spec.group_cols[level];
        let mut groups = group_slots(cache, slots, group_col);
        // Order groups by the group column under the sort model (if it targets it),
        // else by value ascending for a stable tree.
        let desc = self.spec.sort.iter().find(|s| &s.column == group_col).map(|s| s.desc).unwrap_or(false);
        groups.sort_by(|a, b| {
            let o = crate::query::compare_values(&a.0, &b.0);
            if desc { o.reverse() } else { o }
        });
        for (value, member_slots) in groups {
            let mut gpath = path.to_vec();
            gpath.push(group_key_string(&value));
            let expanded = self.expanded.contains(&gpath);
            let aggregates = aggregate_over(cache, &member_slots, &self.spec.aggs);
            out.push(group_row_json(group_col, &value, member_slots.len(), &aggregates, level, expanded, &gpath));
            if expanded {
                if level + 1 < self.spec.group_cols.len() {
                    self.emit_level(cache, &member_slots, &gpath, level + 1, out);
                } else {
                    let mut leaves = member_slots;
                    sort_slots(cache, &mut leaves, &self.spec.sort);
                    for s in leaves { if let Some(r) = cache.row_json(s) { out.push(r); } }
                }
            }
        }
    }

    pub fn num_rows(&mut self) -> usize {
        // A flat view's row count is just its filtered slot count — building JSON
        // for every row only to count them is the same waste `read_window` avoids.
        if self.spec.group_cols.is_empty() {
            let cache_arc = self.cache.clone();
            let cache = cache_arc.lock().unwrap();
            self.refresh_memo(&cache);
            return self.slots().len();
        }
        self.flatten().len()
    }

    /// Read a window `[start, end)` of the flattened tree.
    ///
    /// For a FLAT view (no groupBy) only the window slice is materialized to JSON.
    /// The sort operates on slot INDICES, not rows, so reading rows `[s,e)` of a
    /// 500k table builds `e-s` row objects, not 500k — window read is the hot SSRM
    /// path and must be O(window), not O(table).
    pub fn read_window(&mut self, start: usize, end: Option<usize>) -> (Vec<Json>, usize) {
        let cache_arc = self.cache.clone();
        let cache = cache_arc.lock().unwrap();
        self.refresh_memo(&cache);

        if self.spec.group_cols.is_empty() {
            let leaves = self.slots();
            let total = leaves.len();
            let e = end.unwrap_or(total).min(total);
            let s = start.min(e);
            let rows: Vec<Json> = leaves[s..e].iter().filter_map(|&sl| cache.row_json(sl)).collect();
            return (rows, total);
        }

        // Grouped/tree view: the flattened tree is small (group rows + leaves under
        // expanded nodes only), so materialize it and slice.
        let mut out = Vec::new();
        self.emit_level(&cache, self.slots(), &[], 0, &mut out);
        let total = out.len();
        let e = end.unwrap_or(total).min(total);
        let s = start.min(e);
        (out[s..e].to_vec(), total)
    }

    /// Expand or collapse the group at a visible row index. Returns new row count.
    pub fn set_expanded(&mut self, index: usize, collapse: bool) -> Result<usize, String> {
        if self.spec.group_cols.is_empty() {
            return Err("this view is not a tree; expand/collapse need a groupBy".into());
        }
        let rows = self.flatten();
        let row = rows.get(index).ok_or("row index out of range")?;
        if row.get("__group").and_then(Json::as_bool) != Some(true) {
            return Err("row is a leaf, not a group".into());
        }
        let path: Vec<String> = row["__path"].as_array().unwrap().iter()
            .map(|v| v.as_str().unwrap().to_string()).collect();
        if collapse {
            // Drop this path and any descendants.
            self.expanded.retain(|p| !(p.len() >= path.len() && p[..path.len()] == path[..]));
        } else {
            self.expanded.insert(path);
        }
        Ok(self.num_rows())
    }
}

fn group_row_json(col: &str, value: &Value, count: usize, aggregates: &indexmap::IndexMap<String, Value>, level: usize, expanded: bool, path: &[String]) -> Json {
    let mut o = serde_json::Map::new();
    o.insert("__group".into(), json!(true));
    o.insert("__level".into(), json!(level));
    o.insert("__expanded".into(), json!(expanded));
    o.insert("__count".into(), json!(count));
    o.insert("__path".into(), json!(path));
    o.insert(col.to_string(), value.to_json());
    for (k, v) in aggregates { o.insert(k.clone(), v.to_json()); }
    Json::Object(o)
}

#[cfg(test)]
mod memo_tests {
    use super::*;
    use serde_json::json;

    fn cache_with(rows: usize) -> Arc<Mutex<TableCache>> {
        let mut c = TableCache::new(["id", "desk", "mv"]);
        c.begin_batch();
        for i in 0..rows {
            let desk = if i % 2 == 0 { "govies" } else { "credit" };
            c.upsert(&format!("P{i}"), json!({ "id": format!("P{i}"), "desk": desk, "mv": i })
                .as_object().unwrap());
        }
        c.end_batch();
        Arc::new(Mutex::new(c))
    }

    fn view(cache: Arc<Mutex<TableCache>>, spec: Json) -> View {
        View::new(cache, ViewSpec::from_json(&spec), "s1".into())
    }

    #[test]
    fn repeated_window_reads_reuse_one_order() {
        let cache = cache_with(50);
        let mut v = view(cache, json!({ "sort": [{ "column": "mv", "sort": "desc" }] }));

        v.read_window(0, Some(10));
        let built_at = v.memo_revision().expect("order built on first read");

        // Every later read inside the same revision must reuse it — this is the
        // block-scroll path, where AG Grid issues many reads per revision.
        for start in [10, 20, 30, 40] { v.read_window(start, Some(start + 10)); }
        assert_eq!(v.memo_revision(), Some(built_at));
    }

    #[test]
    fn an_ingest_batch_invalidates_the_order_exactly_once() {
        let cache = cache_with(50);
        let mut v = view(cache.clone(), json!({ "sort": [{ "column": "mv", "sort": "asc" }] }));
        v.read_window(0, Some(10));
        let before = v.memo_revision().unwrap();

        // A 20-row batch is ONE revision, so it strands the order once, not 20 times.
        {
            let mut c = cache.lock().unwrap();
            c.begin_batch();
            for i in 0..20 {
                c.upsert(&format!("P{i}"), json!({ "id": format!("P{i}"), "mv": 1000 + i })
                    .as_object().unwrap());
            }
            c.end_batch();
        }
        v.read_window(0, Some(10));
        assert_eq!(v.memo_revision(), Some(before + 1));
    }

    #[test]
    fn a_rebuilt_order_reflects_the_new_data() {
        let cache = cache_with(10);
        let mut v = view(cache.clone(), json!({ "sort": [{ "column": "mv", "sort": "desc" }] }));
        let (rows, _) = v.read_window(0, Some(1));
        assert_eq!(rows[0]["mv"], json!(9));

        // A stale memo would keep answering 9 here.
        cache.lock().unwrap().upsert("P0", json!({ "id": "P0", "mv": 99 }).as_object().unwrap());
        let (rows, _) = v.read_window(0, Some(1));
        assert_eq!(rows[0]["mv"], json!(99), "memo must not survive the row that outranks its head");
    }

    #[test]
    fn expanding_a_group_does_not_rebuild_the_order() {
        let cache = cache_with(20);
        let mut v = view(cache, json!({ "groupBy": ["desk"], "aggregates": { "mv": "sum" } }));
        v.read_window(0, None);
        let built_at = v.memo_revision().unwrap();

        // Expansion changes which rows are VISIBLE, never which pass the filter.
        v.set_expanded(0, false).expect("group row expands");
        v.read_window(0, None);
        assert_eq!(v.memo_revision(), Some(built_at));
    }

    #[test]
    fn a_filtered_view_memoizes_only_its_own_rows() {
        let cache = cache_with(20);
        let mut v = view(cache, json!({
            "filter": [{ "column": "desk", "op": "equals", "value": "govies" }],
            "sort": [{ "column": "mv", "sort": "asc" }],
        }));
        let (_, total) = v.read_window(0, Some(5));
        assert_eq!(total, 10, "half the rows are govies");
        assert_eq!(v.slots().len(), 10, "the memo holds the filtered set, not the table");
    }
}
