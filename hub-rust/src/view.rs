//! Server-side views — the SSRM/VRM model.
//!
//! The in-browser hub opens a Perspective view per handle and reads windows /
//! expands nodes on it. The Rust hub has no engine view, so a `View` is a stored
//! spec (filter, sort, group-by, aggregates) plus expansion state, materialized
//! against the shared cache on demand. Expand/collapse is BY ROW INDEX into the
//! flattened tree — "one view for the entire tree, mutated in place" — which is
//! exactly what AG-Grid's VRM expects and what `expandRow` drives.

use crate::query::{
    aggregate_over, filtered_slots, group_key_string, group_slots, row_matches, sort_slots,
    AggSpec, Agg, Filter, SortKey,
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
    /// Pivot columns. Each group's aggregates are split by the distinct values
    /// of these columns, producing `<splitValue>|<aggColumn>` fields.
    ///
    /// Requires `groupBy`: a split with nothing to split WITHIN has no rows to
    /// attach the columns to, and AG Grid only sends `pivotCols` alongside
    /// `rowGroupCols`. Ignored on a flat view rather than erroring, matching how
    /// the rest of the spec treats fields it cannot use.
    pub split_cols: Vec<String>,
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
        let split_cols = spec.get("splitBy").and_then(Json::as_array)
            .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        ViewSpec { filter, sort, group_cols, aggs, split_cols }
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
    /// The flattened group tree, valid for one (revision, expansion) pair.
    ///
    /// The slot memo removes the filter scan, but a grouped read still re-ran
    /// `group_slots` and `aggregate_over` across every filtered row — so a
    /// grouped blotter paid two full passes per block instead of one. AG Grid
    /// reads several blocks of the same tree per revision, so building it once
    /// and slicing is the same trade the slot memo makes one level down.
    tree: Option<TreeMemo>,
    /// Bumped by every expand/collapse, so the tree memo can tell "same data,
    /// different shape" from "same shape, new data".
    expand_gen: u64,
    /// How many times each memo actually rebuilt. The revision alone cannot show
    /// reuse - a rebuild at the same revision looks identical - so the counters
    /// are what the tests assert on and what a diagnostics pane would report.
    order_builds: u64,
    tree_builds: u64,
    order_patches: u64,
}

/// A materialized slot order plus the revision that produced it.
struct SlotMemo {
    revision: u64,
    /// Filtered slots; additionally sorted when the view is flat (a grouped view
    /// sorts leaves within each group, so the pre-group order is irrelevant).
    slots: Vec<usize>,
    /// Slot -> in the filtered set. Carried alongside `slots` so a patch can ask
    /// "was this row in the view?" in O(1); answering it by searching `slots`
    /// would make each patched row O(n) and the patch no cheaper than the scan
    /// it replaces.
    member: Vec<bool>,
}

/// Past this share of the table, patching costs more than rebuilding.
///
/// A patch is O(touched) predicate evaluations plus one O(slots) pass over a
/// bool vector; a rebuild is O(live) predicate evaluations. The predicate is the
/// expensive half — it clones a `Value` per column it reads — so the crossover
/// is well below "half the table", not at it.
const PATCH_MAX_TOUCH_RATIO: usize = 4;

/// A materialized group tree plus the (revision, expansion) it was built for.
struct TreeMemo {
    revision: u64,
    expand_gen: u64,
    rows: Vec<Json>,
}

/// Above this many visible rows the tree is built transiently rather than kept.
///
/// A grouped read already materializes the whole flattened tree and slices it,
/// so memoizing costs no extra peak. RETAINING it does: ten views each holding a
/// fully expanded book is ten copies resident instead of one at a time. Past the
/// cap the rebuild is cheaper than the residency, and a tree this large means
/// nearly everything is expanded — which is the client-side row model's job.
const TREE_MEMO_MAX_ROWS: usize = 50_000;

impl View {
    pub fn new(cache: Arc<Mutex<TableCache>>, spec: ViewSpec, session_id: String) -> View {
        View { cache, spec, session_id, expanded: HashSet::new(), memo: None, tree: None, expand_gen: 0,
               order_builds: 0, tree_builds: 0, order_patches: 0 }
    }

    /// Rebuild the slot order if the cache has moved since it was built.
    ///
    /// Deliberately keyed on revision alone, not on expansion state: expanding a
    /// group changes which rows are VISIBLE, never which rows pass the filter.
    fn refresh_memo(&mut self, cache: &TableCache) {
        let revision = cache.revision();
        let prev = match &self.memo {
            Some(m) if m.revision == revision => return,
            Some(m) => Some(m.revision),
            None => None,
        };

        // Only a view that is already current-ish can be patched: the touch log
        // is bounded, and a big enough change set is cheaper to rebuild.
        if let Some(prev) = prev {
            if let Some(touched) = cache.touched_since(prev) {
                if touched.len().saturating_mul(PATCH_MAX_TOUCH_RATIO) < cache.len().max(1) {
                    self.patch_memo(cache, revision, &touched);
                    return;
                }
            }
        }
        self.rebuild_memo(cache, revision);
    }

    fn rebuild_memo(&mut self, cache: &TableCache, revision: u64) {
        let mut slots = filtered_slots(cache, &self.spec.filter);
        if self.spec.group_cols.is_empty() {
            sort_slots(cache, &mut slots, &self.spec.sort);
        }
        let mut member = vec![false; cache.slot_count()];
        for &s in &slots { member[s] = true; }
        self.memo = Some(SlotMemo { revision, slots, member });
        self.order_builds += 1;
    }

    /// Bring the memo forward by re-testing only the rows that actually moved.
    ///
    /// The filter scan is the cost that does NOT shrink with a selective filter,
    /// so replacing it with one predicate evaluation per changed row is the
    /// whole point. The rest is bookkeeping: rebuild the dense slot vector from
    /// the membership map (a bool scan, no predicate, no `Value` clones), and
    /// re-sort a flat view because a touched row's sort key may have changed
    /// even when its membership did not.
    fn patch_memo(&mut self, cache: &TableCache, revision: u64, touched: &[usize]) {
        let Some(memo) = self.memo.as_mut() else { return self.rebuild_memo(cache, revision) };
        if memo.member.len() < cache.slot_count() { memo.member.resize(cache.slot_count(), false); }

        let mut dirty = false;
        for &slot in touched {
            let now_in = cache.is_live(slot) && row_matches(cache, &self.spec.filter, slot);
            if memo.member[slot] != now_in { memo.member[slot] = now_in; dirty = true; }
        }

        if dirty {
            memo.slots = (0..memo.member.len()).filter(|&s| memo.member[s]).collect();
        }
        // A touched row that stayed a member can still have moved in the sort, so
        // a flat view reorders whenever anything moved — not only when membership
        // changed. A grouped view does not: it sorts leaves within each group.
        let needs_sort = self.spec.group_cols.is_empty() && !touched.is_empty();
        if needs_sort {
            let mut slots = std::mem::take(&mut memo.slots);
            sort_slots(cache, &mut slots, &self.spec.sort);
            memo.slots = slots;
        }
        memo.revision = revision;
        self.order_patches += 1;
    }

    /// The memoized slot order. Call `refresh_memo` first.
    fn slots(&self) -> &[usize] {
        self.memo.as_ref().map(|m| m.slots.as_slice()).unwrap_or(&[])
    }

    /// Number of times the order was rebuilt — diagnostics for the memo's value.
    pub fn memo_revision(&self) -> Option<u64> { self.memo.as_ref().map(|m| m.revision) }

    /// Whether the flattened tree is currently held. Diagnostics + tests.
    pub fn tree_memo_revision(&self) -> Option<u64> { self.tree.as_ref().map(|t| t.revision) }

    /// Times the slot order was rebuilt since this view opened.
    pub fn order_builds(&self) -> u64 { self.order_builds }
    /// Times the flattened tree was rebuilt since this view opened.
    pub fn tree_builds(&self) -> u64 { self.tree_builds }
    /// Times the slot order was PATCHED rather than rebuilt.
    pub fn order_patches(&self) -> u64 { self.order_patches }

    /// Rebuild the flattened tree if the data or the expansion state has moved.
    ///
    /// Returns `Some(rows)` when the tree was too large to keep — the caller uses
    /// those rows directly — and `None` when it is held in `self.tree`. Splitting
    /// it this way avoids building the tree twice in the over-cap case.
    fn refresh_tree(&mut self, cache: &TableCache) -> Option<Vec<Json>> {
        let revision = cache.revision();
        if matches!(&self.tree, Some(t) if t.revision == revision && t.expand_gen == self.expand_gen) {
            return None;
        }
        let mut rows = Vec::new();
        self.emit_level(cache, self.slots(), &[], 0, &mut rows);
        self.tree_builds += 1;
        if rows.len() <= TREE_MEMO_MAX_ROWS {
            self.tree = Some(TreeMemo { revision, expand_gen: self.expand_gen, rows });
            None
        } else {
            self.tree = None;
            Some(rows)
        }
    }

    /// The flattened visible rows (group rows + leaves under expanded nodes).
    fn flatten(&mut self) -> Vec<Json> {
        let cache_arc = self.cache.clone();
        let cache = cache_arc.lock().unwrap();
        self.refresh_memo(&cache);
        if self.spec.group_cols.is_empty() {
            let mut out = Vec::new();
            for &s in self.slots() { if let Some(r) = cache.row_json(s) { out.push(r); } }
            return out;
        }
        match self.refresh_tree(&cache) {
            Some(rows) => rows,
            None => self.tree.as_ref().map(|t| t.rows.clone()).unwrap_or_default(),
        }
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
            let aggregates = if self.spec.split_cols.is_empty() {
                aggregate_over(cache, &member_slots, &self.spec.aggs)
            } else {
                self.aggregate_split(cache, &member_slots)
            };
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

    /// One group's aggregates, split by the pivot columns.
    ///
    /// Names are `<splitValue>|<aggColumn>` — e.g. `USD|marketValue`. The
    /// separator is `|` because that is what AG Grid is told to split on via
    /// `serverSidePivotResultFieldSeparator`, and what the client's
    /// `pivotResultFields` scan looks for; changing it here silently produces a
    /// grid with correct data and no pivot columns.
    ///
    /// Buckets are emitted in sorted key order so a given pivot yields the same
    /// column order on every read. Without that, two reads of the same view
    /// could hand AG Grid its secondary columns in different orders and the
    /// grid would rebuild them mid-scroll.
    fn aggregate_split(
        &self,
        cache: &TableCache,
        slots: &[usize],
    ) -> indexmap::IndexMap<String, Value> {
        let idx: Vec<Option<usize>> =
            self.spec.split_cols.iter().map(|c| cache.col_index(c)).collect();
        let mut buckets: indexmap::IndexMap<String, Vec<usize>> = indexmap::IndexMap::new();
        for &slot in slots {
            let key = idx.iter()
                .map(|ci| ci.map(|ci| split_key_string(cache.cell(slot, ci))).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("|");
            buckets.entry(key).or_default().push(slot);
        }
        buckets.sort_keys();

        let mut out = indexmap::IndexMap::new();
        for (key, member_slots) in buckets {
            for (name, value) in aggregate_over(cache, &member_slots, &self.spec.aggs) {
                out.insert(format!("{key}|{name}"), value);
            }
        }
        out
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

        // Grouped/tree view: the flattened tree is group rows plus leaves under
        // expanded nodes, built once per (revision, expansion) and sliced.
        let transient = self.refresh_tree(&cache);
        let rows: &[Json] = match transient.as_deref() {
            Some(r) => r,
            None => self.tree.as_ref().map(|t| t.rows.as_slice()).unwrap_or(&[]),
        };
        let total = rows.len();
        let e = end.unwrap_or(total).min(total);
        let s = start.min(e);
        (rows[s..e].to_vec(), total)
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
        // The tree memo is keyed on this: without the bump, expanding a group
        // would keep serving the tree shape from before the expansion.
        self.expand_gen += 1;
        Ok(self.num_rows())
    }
}

/// A pivot column-name fragment: the CLEAN value, not the type-tagged group key.
///
/// `group_key_string` prefixes a type tag so that the string "1" and the number
/// 1 cannot collide in a group path. A pivot key is a user-visible column name,
/// where that tag would surface as `sUSD|marketValue` in the grid header.
fn split_key_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Str(s) => s.to_string(),
        other => match other.to_json() {
            Json::String(s) => s,
            j => j.to_string(),
        },
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
    fn a_small_change_patches_the_order_instead_of_rebuilding() {
        let cache = cache_with(200);
        let mut v = view(cache.clone(), json!({
            "filter": [{ "column": "desk", "op": "equals", "value": "govies" }],
            "sort": [{ "column": "mv", "sort": "asc" }],
        }));
        v.read_window(0, Some(10));
        assert_eq!(v.order_builds(), 1);
        assert_eq!(v.order_patches(), 0);

        // Two rows move out of 200 — far too few to justify rescanning the table.
        {
            let mut c = cache.lock().unwrap();
            c.begin_batch();
            c.upsert("P0", json!({ "id": "P0", "mv": 5.0 }).as_object().unwrap());
            c.upsert("P2", json!({ "id": "P2", "mv": 6.0 }).as_object().unwrap());
            c.end_batch();
        }
        v.read_window(0, Some(10));
        assert_eq!(v.order_builds(), 1, "no rebuild");
        assert_eq!(v.order_patches(), 1, "patched instead");
    }

    #[test]
    fn a_patch_agrees_with_a_rebuild_on_membership_and_order() {
        let cache = cache_with(300);
        let spec = json!({
            "filter": [{ "column": "mv", "op": "greaterThan", "value": 100 }],
            "sort": [{ "column": "mv", "sort": "desc" }],
        });
        let mut patched = view(cache.clone(), spec.clone());
        patched.read_window(0, Some(5));

        // Move rows ACROSS the filter boundary in both directions, plus a delete.
        {
            let mut c = cache.lock().unwrap();
            c.begin_batch();
            c.upsert("P5", json!({ "id": "P5", "mv": 9999.0 }).as_object().unwrap());   // enters
            c.upsert("P250", json!({ "id": "P250", "mv": 1.0 }).as_object().unwrap());  // leaves
            c.upsert("P260", json!({ "id": "P260", "mv": 500.0 }).as_object().unwrap()); // stays, moves
            c.delete("P270");                                                            // leaves
            c.end_batch();
        }
        let (from_patch, total_patch) = patched.read_window(0, None);
        assert_eq!(patched.order_patches(), 1, "this must be the patch path");

        // A view opened fresh at the same revision can only rebuild.
        let mut rebuilt = view(cache.clone(), spec);
        let (from_rebuild, total_rebuild) = rebuilt.read_window(0, None);
        assert_eq!(rebuilt.order_patches(), 0);

        assert_eq!(total_patch, total_rebuild, "row counts must agree");
        assert_eq!(from_patch, from_rebuild, "patched order must equal a rebuilt one");
    }

    #[test]
    fn falling_past_the_touch_log_rebuilds_rather_than_patching_wrongly() {
        let cache = cache_with(50);
        cache.lock().unwrap().set_touch_log_cap(2);
        let mut v = view(cache.clone(), json!({ "sort": [{ "column": "mv", "sort": "asc" }] }));
        v.read_window(0, Some(5));
        assert_eq!(v.order_builds(), 1);

        // Three separate revisions with a two-entry log: the view's revision is
        // no longer reachable, so a patch would be applied against an incomplete
        // change set. It must rebuild instead.
        for i in 0..3 {
            let mut c = cache.lock().unwrap();
            c.begin_batch();
            c.upsert(&format!("P{i}"), json!({ "id": format!("P{i}"), "mv": 900.0 + i as f64 })
                .as_object().unwrap());
            c.end_batch();
        }
        v.read_window(0, Some(5));
        assert_eq!(v.order_builds(), 2, "must rebuild, not patch from a pruned log");
        assert_eq!(v.order_patches(), 0);
    }

    #[test]
    fn a_large_change_rebuilds_rather_than_patching() {
        let cache = cache_with(100);
        let mut v = view(cache.clone(), json!({ "sort": [{ "column": "mv", "sort": "asc" }] }));
        v.read_window(0, Some(5));

        // Touch most of the table — a patch would evaluate the predicate nearly
        // as many times as a rebuild, and pay the bookkeeping on top.
        {
            let mut c = cache.lock().unwrap();
            c.begin_batch();
            for i in 0..90 {
                c.upsert(&format!("P{i}"), json!({ "id": format!("P{i}"), "mv": i as f64 })
                    .as_object().unwrap());
            }
            c.end_batch();
        }
        v.read_window(0, Some(5));
        assert_eq!(v.order_builds(), 2);
        assert_eq!(v.order_patches(), 0);
    }

    #[test]
    fn pivot_splits_each_group_aggregate_by_the_split_column() {
        let mut c = TableCache::new(["id", "desk", "ccy", "mv"]);
        c.begin_batch();
        for (id, desk, ccy, mv) in [
            ("1", "govies", "USD", 100.0), ("2", "govies", "EUR", 200.0),
            ("3", "credit", "USD", 400.0), ("4", "credit", "EUR", 800.0),
            ("5", "credit", "USD", 1.0),
        ] {
            c.upsert(id, json!({ "id": id, "desk": desk, "ccy": ccy, "mv": mv })
                .as_object().unwrap());
        }
        c.end_batch();
        let cache = Arc::new(Mutex::new(c));

        let mut v = view(cache, json!({
            "groupBy": ["desk"], "splitBy": ["ccy"], "aggregates": { "mv": "sum" },
        }));
        let (rows, _) = v.read_window(0, None);
        let credit = rows.iter().find(|r| r["desk"] == json!("credit")).expect("credit group");
        let govies = rows.iter().find(|r| r["desk"] == json!("govies")).expect("govies group");

        // The whole point: 400 + 1 and 800 stay APART instead of collapsing to 1201.
        assert_eq!(credit["USD|mv"], json!(401.0));
        assert_eq!(credit["EUR|mv"], json!(800.0));
        assert_eq!(govies["USD|mv"], json!(100.0));
        assert_eq!(govies["EUR|mv"], json!(200.0));

        // The separator must be the one AG Grid is told to split on.
        assert!(credit.as_object().unwrap().keys().any(|k| k.contains('|')));
    }

    #[test]
    fn pivot_column_order_is_stable_across_reads() {
        let cache = cache_with(60);
        let mut v = view(cache, json!({
            "groupBy": ["desk"], "splitBy": ["id"], "aggregates": { "mv": "sum" },
        }));
        let first: Vec<String> = v.read_window(0, None).0[0].as_object().unwrap()
            .keys().cloned().collect();
        let second: Vec<String> = v.read_window(0, None).0[0].as_object().unwrap()
            .keys().cloned().collect();
        assert_eq!(first, second, "unstable column order rebuilds AG Grid's secondary columns");
    }

    #[test]
    fn a_view_without_split_by_is_untouched_by_pivot_support() {
        let cache = cache_with(20);
        let mut v = view(cache, json!({ "groupBy": ["desk"], "aggregates": { "mv": "sum" } }));
        let (rows, _) = v.read_window(0, None);
        assert!(rows[0].get("mv").is_some(), "plain aggregate stays plain");
        assert!(!rows[0].as_object().unwrap().keys().any(|k| k.contains('|')));
    }

    #[test]
    fn grouped_reads_reuse_one_tree_within_a_revision() {
        let cache = cache_with(200);
        let mut v = view(cache, json!({ "groupBy": ["desk"], "aggregates": { "mv": "sum" } }));
        v.read_window(0, Some(10));
        assert_eq!(v.tree_builds(), 1);

        // Grouping and aggregating used to run again on every one of these.
        for start in [0, 2, 4, 6, 8] { v.read_window(start, Some(start + 2)); }
        assert_eq!(v.tree_builds(), 1, "the tree must be built once per revision");
        assert_eq!(v.order_builds(), 1, "and so must the slot order");
    }

    #[test]
    fn expanding_a_group_rebuilds_the_tree_but_not_the_order() {
        let cache = cache_with(20);
        let mut v = view(cache, json!({ "groupBy": ["desk"], "aggregates": { "mv": "sum" } }));
        let (before, _) = v.read_window(0, None);
        assert_eq!(v.tree_builds(), 1);

        v.set_expanded(0, false).expect("group row expands");
        let (after, _) = v.read_window(0, None);

        // Expansion changes the tree's SHAPE, so the tree must rebuild...
        assert!(after.len() > before.len(), "expanding must reveal leaves");
        assert!(v.tree_builds() > 1, "a stale tree would hide the expansion");
        // ...but not which rows pass the filter, so the order must not.
        assert_eq!(v.order_builds(), 1);
    }

    #[test]
    fn new_data_rebuilds_the_tree_and_moves_the_aggregate() {
        let cache = cache_with(10);
        let mut v = view(cache.clone(), json!({ "groupBy": ["desk"], "aggregates": { "mv": "sum" } }));
        let (rows, _) = v.read_window(0, None);
        let credit_before = rows.iter()
            .find(|r| r["desk"] == json!("credit")).expect("credit group")["mv"].clone();

        cache.lock().unwrap()
            .upsert("P1", json!({ "id": "P1", "desk": "credit", "mv": 10_000 }).as_object().unwrap());

        let (rows, _) = v.read_window(0, None);
        let credit_after = rows.iter()
            .find(|r| r["desk"] == json!("credit")).expect("credit group")["mv"].clone();
        assert_ne!(credit_before, credit_after, "a stale tree would serve the old sum");
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
