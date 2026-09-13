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

use crate::expr::{client_aggregate, to_num};
use crate::query::{filtered_slots, group_key_string, numeric_cell, row_matches, Agg, AggSpec, Filter, MultiAcc};
use crate::store::{TableCache, Value};
use crate::view::{ComputedCol, Scope};
use indexmap::IndexMap;
use serde_json::{json, Value as Json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

type Aggs = IndexMap<String, Value>;

/// Can this watch be maintained by adding and subtracting single rows?
///
/// Only folds that can be UNDONE. `sum`, `avg` and `count` are running totals
/// a departing row can be subtracted out of; `min`, `max`, `median` and
/// `distinct_count` are not — undoing them needs the members back, which is
/// the scan this exists to avoid. Such a watch keeps the full-rescan path,
/// which is correct and merely as slow as it was before.
fn invertible(a: Agg) -> bool { matches!(a, Agg::Sum | Agg::Avg | Agg::Count) }

/// The same question for an `agg` node inside a computed column, whose folds
/// follow the CLIENT's semantics (`expr::client_aggregate`) rather than the
/// grid's.
fn invertible_client(f: &str) -> bool { matches!(f, "sum" | "avg" | "count") }

/// A full rebuild every this many single-row mutations, to bound drift.
///
/// Adding and subtracting f64 repeatedly does not return to where it started.
/// A trading day at 40k rows/s is ~1.7e9 mutations, and the error accumulates
/// in the direction of whatever the arithmetic happened to round. Periodically
/// refolding from the cache resets it: at a few hundred thousand mutations the
/// rebuild costs one slow tick roughly every few minutes, which is invisible
/// beside being wrong by an amount nobody can predict.
const REBUILD_AFTER_MUTATIONS: u64 = 250_000;

/// Running aggregates for ONE group node at one level.
#[derive(Clone)]
struct NodeState {
    /// Member rows, which is `count` and the wire shape's leaf count.
    rows: usize,
    /// Per `AggSpec`: running total, and how many cells contributed (blanks
    /// and non-numerics do not, so this is not `rows`).
    sum: Vec<f64>,
    n: Vec<usize>,
    /// Per computed-column `agg` node, with client fold semantics: `sum`
    /// coerces every value (null counts as 0) and `avg` divides by the count
    /// of ALL values, so the length is tracked separately from the non-nulls
    /// that `count` reports.
    ref_sum: Vec<f64>,
    ref_len: Vec<usize>,
    ref_nonnull: Vec<usize>,
    /// Raw group values, one per level down to this node.
    values: Vec<Json>,
}

impl NodeState {
    fn new(nspecs: usize, nrefs: usize, values: Vec<Json>) -> NodeState {
        NodeState {
            rows: 0,
            sum: vec![0.0; nspecs], n: vec![0; nspecs],
            ref_sum: vec![0.0; nrefs], ref_len: vec![0; nrefs], ref_nonnull: vec![0; nrefs],
            values,
        }
    }
}

/// A distinct deepest group path, resolved to the node it and each of its
/// ancestors live in.
///
/// Walking a row's ancestors by hashing path prefixes would allocate a
/// `Vec<String>` per level per row — a full build of a 500k book at two levels
/// is a million allocations inside the hot loop. Interning each path once and
/// keeping its node indices turns the per-row work into array indexing.
struct PathEntry {
    /// Node index per level: `node_ids[d]` is the prefix of length `d + 1`.
    node_ids: Vec<u32>,
}

/// A slot that contributes to nothing: dead, filtered out, or never seen.
/// Removal reads this, so removing twice is a no-op rather than a corruption.
const NO_NODE: u32 = u32::MAX;

/// Everything needed to answer the next tick without rescanning the cache.
///
/// The load-bearing part is `spec_contrib` / `ref_contrib`. The touch log says
/// WHICH slots moved, but the cache holds only their new values — a departing
/// row's old contribution cannot be read back out of it, so it has to have
/// been kept. Storing what each slot put in is what makes this incremental
/// rather than merely dirty-marked; without it, subtracting re-reads the new
/// value and the running totals drift away from the truth on the first tick.
struct Incr {
    /// The cache revision this state is current as of.
    rev: u64,
    paths: Vec<PathEntry>,
    path_ix: HashMap<Vec<String>, u32>,
    /// Node id -> its group path, parallel to `nodes`.
    node_key: Vec<Vec<String>>,
    node_ix: HashMap<Vec<String>, u32>,
    nodes: Vec<NodeState>,
    /// slot -> interned path index, or `NO_NODE`.
    slot_path: Vec<u32>,
    /// Slot-major `slot * nspecs + si`: what this slot contributed to each
    /// spec's total. NaN means it did not contribute — exactly the cells
    /// `numeric_cell` rejects, so the two cannot disagree about what counted.
    spec_contrib: Vec<f64>,
    /// Slot-major `slot * nrefs + ri`: the coerced value each computed `agg`
    /// node folded, and whether the source was non-null.
    ref_contrib: Vec<f64>,
    ref_nonnull: Vec<bool>,
    /// Row-scoped computed values, patched per touched slot.
    row_vals: Vec<Vec<Value>>,
    mutations: u64,
}

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
    /// Incremental state, when this watch qualifies for it. `None` forces the
    /// next poll to rebuild — which is also how a fallen-behind touch log and a
    /// drift rebuild are expressed.
    incr: Option<Incr>,
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
                     incr: None, last: HashMap::new(), conflate_ms, last_flush: None }
    }

    fn computed_idx(&self, name: &str) -> Option<usize> {
        self.computed.iter().position(|c| c.name == name)
    }

    /// Does this watch qualify for incremental maintenance?
    ///
    /// Every fold has to be undoable, and no computed column may be
    /// `Scope::NodeRow` — a mixed column's per-row value shifts whenever its
    /// node's scalars shift, so one row moving invalidates every row in the
    /// node, which is the scan again wearing a different hat.
    fn incremental_ok(&self) -> bool {
        self.aggs.iter().all(|a| invertible(a.agg))
            && self.agg_refs.iter().all(|(f, _)| invertible_client(f))
            && self.scopes.iter().all(|sc| *sc != Scope::NodeRow)
    }

    /// The group path a slot belongs to, or `None` if it is dead or filtered
    /// out. One place, so membership cannot disagree between the full build
    /// and the patch.
    fn path_of(&self, cache: &TableCache, slot: usize, row_vals: &[Vec<Value>]) -> Option<(Vec<String>, Vec<Json>)> {
        if !cache.is_live(slot) { return None; }
        if !self.filter.is_empty() && !row_matches(cache, &self.filter, slot) { return None; }
        let mut path = Vec::with_capacity(self.group_cols.len());
        let mut values = Vec::with_capacity(self.group_cols.len());
        for col in &self.group_cols {
            let v = self.value_of(cache, slot, col, row_vals);
            path.push(group_key_string(&v));
            values.push(v.to_json());
        }
        Some((path, values))
    }

    /// Intern a path, creating the node for each of its prefixes.
    fn intern(&self, incr: &mut Incr, path: &[String], values: &[Json]) -> u32 {
        if let Some(&ix) = incr.path_ix.get(path) { return ix; }
        let mut node_ids = Vec::with_capacity(path.len());
        for depth in 1..=path.len() {
            let key = path[..depth].to_vec();
            let id = match incr.node_ix.get(&key) {
                Some(&id) => id,
                None => {
                    let id = incr.nodes.len() as u32;
                    incr.nodes.push(NodeState::new(
                        self.aggs.len(), self.agg_refs.len(), values[..depth].to_vec()));
                    incr.node_key.push(key.clone());
                    incr.node_ix.insert(key, id);
                    id
                }
            };
            node_ids.push(id);
        }
        let ix = incr.paths.len() as u32;
        incr.paths.push(PathEntry { node_ids });
        incr.path_ix.insert(path.to_vec(), ix);
        ix
    }

    /// Read what a slot contributes out of the cache and store it, so the
    /// contribution can be undone later without the cache's help.
    fn record_contrib(&self, cache: &TableCache, incr: &mut Incr, slot: usize) {
        let nspecs = self.aggs.len();
        for si in 0..nspecs {
            let cell = self.agg_cell(cache, slot, &self.aggs[si].column, &incr.row_vals);
            incr.spec_contrib[slot * nspecs + si] = numeric_cell(&cell).unwrap_or(f64::NAN);
        }
        let nrefs = self.agg_refs.len();
        for ri in 0..nrefs {
            let v = self.value_of(cache, slot, &self.agg_refs[ri].1, &incr.row_vals);
            incr.ref_contrib[slot * nrefs + ri] = to_num(&v);
            incr.ref_nonnull[slot * nrefs + ri] = !matches!(v, Value::Null);
        }
    }

    /// Apply a slot's STORED contribution to every node on its path.
    fn fold(&self, incr: &mut Incr, slot: usize, pix: u32, add: bool) {
        let nspecs = self.aggs.len();
        let nrefs = self.agg_refs.len();
        let Incr { paths, nodes, spec_contrib, ref_contrib, ref_nonnull, .. } = incr;
        for &nid in &paths[pix as usize].node_ids {
            let node = &mut nodes[nid as usize];
            if add { node.rows += 1; } else { node.rows = node.rows.saturating_sub(1); }
            for si in 0..nspecs {
                let c = spec_contrib[slot * nspecs + si];
                if c.is_nan() { continue; }
                if add { node.sum[si] += c; node.n[si] += 1; }
                else { node.sum[si] -= c; node.n[si] = node.n[si].saturating_sub(1); }
            }
            for ri in 0..nrefs {
                let c = ref_contrib[slot * nrefs + ri];
                let nonnull = ref_nonnull[slot * nrefs + ri];
                if add {
                    node.ref_sum[ri] += c;
                    node.ref_len[ri] += 1;
                    if nonnull { node.ref_nonnull[ri] += 1; }
                } else {
                    node.ref_sum[ri] -= c;
                    node.ref_len[ri] = node.ref_len[ri].saturating_sub(1);
                    if nonnull { node.ref_nonnull[ri] = node.ref_nonnull[ri].saturating_sub(1); }
                }
            }
        }
    }

    fn add_slot(&self, cache: &TableCache, incr: &mut Incr, slot: usize) {
        let Some((path, values)) = self.path_of(cache, slot, &incr.row_vals) else { return; };
        let pix = self.intern(incr, &path, &values);
        self.record_contrib(cache, incr, slot);
        incr.slot_path[slot] = pix;
        self.fold(incr, slot, pix, true);
    }

    fn remove_slot(&self, incr: &mut Incr, slot: usize) {
        let pix = incr.slot_path[slot];
        if pix == NO_NODE { return; }
        self.fold(incr, slot, pix, false);
        incr.slot_path[slot] = NO_NODE;
    }

    /// A cell as an `AggSpec` sees it — computed columns resolved, cache
    /// columns through `query_value`, matching `node_aggs`.
    fn agg_cell(&self, cache: &TableCache, slot: usize, name: &str, row_vals: &[Vec<Value>]) -> Value {
        if let Some(k) = self.computed_idx(name) {
            // A node-scoped column is constant across its node, so it has no
            // per-row contribution; `materialize` writes its value directly.
            if self.scopes[k] != Scope::Row { return Value::Null; }
            return row_vals[k].get(slot).cloned().unwrap_or(Value::Null);
        }
        cache.col_index(name).map(|ci| cache.query_value(slot, ci)).unwrap_or(Value::Null)
    }

    /// Build the incremental state from scratch, by the same full scan the
    /// non-incremental path uses.
    fn build_incr(&self, cache: &TableCache) -> Incr {
        let slots = filtered_slots(cache, &self.filter);
        let nslots = cache.slot_count();
        let nspecs = self.aggs.len();
        let nrefs = self.agg_refs.len();
        let mut incr = Incr {
            rev: cache.revision(),
            paths: Vec::new(), path_ix: HashMap::new(),
            node_key: Vec::new(), node_ix: HashMap::new(), nodes: Vec::new(),
            slot_path: vec![NO_NODE; nslots],
            spec_contrib: vec![f64::NAN; nslots * nspecs],
            ref_contrib: vec![0.0; nslots * nrefs],
            ref_nonnull: vec![false; nslots * nrefs],
            row_vals: self.eval_row_scoped(cache, &slots),
            mutations: 0,
        };
        for &slot in &slots { self.add_slot(cache, &mut incr, slot); }
        incr
    }

    /// Fold only what moved. The caller has already established that the touch
    /// log reaches back far enough to name every change since `incr.rev`.
    fn patch_incr(&self, cache: &TableCache, incr: &mut Incr, touched: &[usize]) {
        let nslots = cache.slot_count();
        let nspecs = self.aggs.len();
        let nrefs = self.agg_refs.len();
        if incr.slot_path.len() < nslots {
            // Slot-major strides, so growing at the end leaves every existing
            // index where it was.
            incr.slot_path.resize(nslots, NO_NODE);
            incr.spec_contrib.resize(nslots * nspecs, f64::NAN);
            incr.ref_contrib.resize(nslots * nrefs, 0.0);
            incr.ref_nonnull.resize(nslots * nrefs, false);
        }
        for col in incr.row_vals.iter_mut() {
            if !col.is_empty() && col.len() < nslots { col.resize(nslots, Value::Null); }
        }
        for &slot in touched {
            if slot >= nslots { continue; }
            // Remove FIRST, using the stored contribution, then re-derive the
            // row's computed values and add it back where it now belongs.
            self.remove_slot(incr, slot);
            self.patch_row_scoped(cache, &[slot], &mut incr.row_vals);
            self.add_slot(cache, incr, slot);
            incr.mutations += 1;
        }
        incr.rev = cache.revision();
    }

    /// Turn the running state into the shape the full scan produces.
    fn materialize(&self, incr: &Incr) -> HashMap<Vec<String>, (Aggs, usize, Vec<Json>)> {
        let mut out = HashMap::with_capacity(incr.nodes.len());
        for (nid, node) in incr.nodes.iter().enumerate() {
            // A node emptied by the last tick is gone, not a zero row; `poll`
            // reports its disappearance through `removed`.
            if node.rows == 0 { continue; }
            let mut aggs: Aggs = IndexMap::new();
            for (si, spec) in self.aggs.iter().enumerate() {
                let v = match spec.agg {
                    Agg::Sum => Value::Float(node.sum[si]),
                    Agg::Avg => if node.n[si] > 0 { Value::Float(node.sum[si] / node.n[si] as f64) } else { Value::Null },
                    Agg::Count => Value::Int(node.rows as i64),
                    // `incremental_ok` admits nothing else onto this path.
                    _ => Value::Null,
                };
                aggs.insert(spec.out.clone(), v);
            }
            if !self.computed.is_empty() {
                let scalars: Vec<Value> = self.agg_refs.iter().enumerate().map(|(ri, (f, _))| {
                    match f.as_str() {
                        "sum" => Value::Float(node.ref_sum[ri]),
                        // Client `avg` divides by every value seen, nulls
                        // included, and answers 0 for an empty fold.
                        "avg" => if node.ref_len[ri] > 0 {
                            Value::Float(node.ref_sum[ri] / node.ref_len[ri] as f64)
                        } else { Value::Float(0.0) },
                        "count" => Value::Float(node.ref_nonnull[ri] as f64),
                        _ => Value::Null,
                    }
                }).collect();
                let agg = |f: &str, c: &str| -> Value {
                    self.agg_refs.iter().position(|(af, ac)| af == f && ac == c)
                        .and_then(|i| scalars.get(i).cloned()).unwrap_or(Value::Null)
                };
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
                for (k, cc) in self.computed.iter().enumerate() {
                    if self.scopes[k] == Scope::Node {
                        aggs.insert(cc.name.clone(), node_vals[k].clone());
                    }
                }
            }
            out.insert(incr.node_key[nid].clone(), (aggs, node.rows, node.values.clone()));
        }
        out
    }

    /// Aggregates for every group node at every level, keyed by group path.
    ///
    /// Incremental when the folds allow it: the cache's touch log names the
    /// slots that moved since the last poll, and only those are subtracted
    /// from their old node and added to their new one. A watch that cannot be
    /// maintained that way, a touch log that has fallen behind, and a state
    /// that has taken enough single-row arithmetic to be worth re-deriving all
    /// land on the same full rescan — which is what this did unconditionally
    /// before, and is still the definition the incremental path is checked
    /// against.
    fn snapshot(&mut self) -> HashMap<Vec<String>, (Aggs, usize, Vec<Json>)> {
        let cache = self.cache.lock().unwrap();
        if self.incremental_ok() {
            let reusable = match &self.incr {
                Some(i) if i.mutations < REBUILD_AFTER_MUTATIONS => cache.touched_since(i.rev),
                _ => None,
            };
            match reusable {
                Some(touched) => {
                    let incr = self.incr.as_mut().expect("reusable implies present");
                    // Taken out so `patch_incr` can borrow `self` immutably
                    // alongside it; put back below.
                    let mut incr = std::mem::replace(incr, Incr {
                        rev: 0, paths: Vec::new(), path_ix: HashMap::new(),
                        node_key: Vec::new(), node_ix: HashMap::new(), nodes: Vec::new(),
                        slot_path: Vec::new(), spec_contrib: Vec::new(),
                        ref_contrib: Vec::new(), ref_nonnull: Vec::new(),
                        row_vals: Vec::new(), mutations: 0,
                    });
                    self.patch_incr(&cache, &mut incr, &touched);
                    let out = self.materialize(&incr);
                    self.incr = Some(incr);
                    return out;
                }
                None => {
                    let incr = self.build_incr(&cache);
                    let out = self.materialize(&incr);
                    self.incr = Some(incr);
                    return out;
                }
            }
        }
        self.incr = None;
        self.full_snapshot(&cache)
    }

    /// The unconditional rescan: every group node at every level, folded from
    /// the cache. The incremental path's correctness is defined as agreeing
    /// with this.
    fn full_snapshot(&self, cache: &TableCache) -> HashMap<Vec<String>, (Aggs, usize, Vec<Json>)> {
        let slots = filtered_slots(cache, &self.filter);
        // Row-scoped columns are node-independent, so they are evaluated ONCE
        // over the filtered set rather than per node per level. That is what
        // keeps this affordable: a two-level grouping visits every row twice,
        // and re-deriving `spread * dv01` on each visit would double the scan
        // this path is fast because of.
        let row_vals = self.eval_row_scoped(cache, &slots);
        let mut out = HashMap::new();
        self.collect(cache, &slots, &[], &[], 0, &row_vals, &mut out);
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
        self.write_row_scoped(cache, slots, &mut vals);
        vals
    }

    /// Re-evaluate the row-scoped computed columns for just these slots,
    /// writing into an already-sized table. The incremental path patches the
    /// slots the touch log names; the full build passes every filtered slot.
    fn patch_row_scoped(&self, cache: &TableCache, slots: &[usize], vals: &mut [Vec<Value>]) {
        if vals.iter().all(|c| c.is_empty()) { return; }
        self.write_row_scoped(cache, slots, vals);
    }

    fn write_row_scoped(&self, cache: &TableCache, slots: &[usize], vals: &mut [Vec<Value>]) {
        let n = self.computed.len();
        let no_agg = |_: &str, _: &str| Value::Null; // Scope::Row has no agg nodes
        for &slot in slots {
            if !cache.is_live(slot) {
                // A tombstoned slot keeps no stale value: its slot can be
                // reused by an unrelated row, and a leftover would be folded
                // into that row's node.
                for col in vals.iter_mut() {
                    if let Some(v) = col.get_mut(slot) { *v = Value::Null; }
                }
                continue;
            }
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
                if let Some(col) = vals.get_mut(k) {
                    if let Some(cell) = col.get_mut(slot) { *cell = v; }
                }
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The equivalence gate.
    ///
    /// Incremental aggregation is only safe if it lands where a full fold
    /// would, and the ways it can silently diverge are all subtle: a row that
    /// moved between groups, a row deleted while its contribution stayed
    /// behind, a slot reused by an unrelated key, a cell that stopped being
    /// numeric. None of those show up in a hand-written example — they show up
    /// under churn. So these drive a pseudo-random feed and compare the two
    /// paths after every tick.
    fn lcg(seed: u32) -> impl FnMut() -> u32 {
        let mut s = seed;
        move || { s = s.wrapping_mul(1664525).wrapping_add(1013904223); s }
    }

    const DESKS: [&str; 4] = ["Rates", "Credit", "EM", "Munis"];
    const REGIONS: [&str; 3] = ["US", "EU", "AP"];

    fn cache() -> Arc<Mutex<TableCache>> {
        Arc::new(Mutex::new(TableCache::new(
            ["id", "desk", "region", "qty", "px"])))
    }

    fn watch(c: &Arc<Mutex<TableCache>>, levels: usize, computed: Vec<ComputedCol>) -> GroupWatch {
        let aggs = vec![
            AggSpec { column: "qty".into(), agg: Agg::Sum, out: "qty".into() },
            AggSpec { column: "px".into(), agg: Agg::Avg, out: "px".into() },
        ];
        let group_cols: Vec<String> = ["desk", "region"][..levels]
            .iter().map(|s| s.to_string()).collect();
        GroupWatch::new("ds".into(), c.clone(), Filter::from_json(&Json::Null),
                        group_cols, aggs, computed, 0)
    }

    /// `wprod = qty * px` (row-scoped) and `w = SUM(wprod) / SUM(qty)`
    /// (node-scoped) — the shape that exercises both contribution stores.
    fn weighted() -> Vec<ComputedCol> {
        let (cols, errs) = crate::view::parse_computed(Some(&json!([
            {"as":"wprod","expr":{"k":"bin","op":"mul",
                "l":{"k":"col","name":"qty"},"r":{"k":"col","name":"px"}}},
            {"as":"w","expr":{"k":"bin","op":"div",
                "l":{"k":"agg","fn":"sum","col":"wprod"},
                "r":{"k":"agg","fn":"sum","col":"qty"}}}
        ])));
        assert!(errs.is_empty(), "{errs:?}");
        cols
    }

    /// Compare the incremental snapshot against a fresh full fold of the same
    /// cache, node by node.
    fn assert_agrees(w: &mut GroupWatch, when: &str) {
        let incremental = w.snapshot();
        let full = { let c = w.cache.lock().unwrap(); w.full_snapshot(&c) };
        let mut ik: Vec<_> = incremental.keys().cloned().collect();
        let mut fk: Vec<_> = full.keys().cloned().collect();
        ik.sort(); fk.sort();
        assert_eq!(ik, fk, "group paths diverged {when}");
        for (path, (aggs, rows, values)) in &full {
            let (iaggs, irows, ivalues) = &incremental[path];
            assert_eq!(irows, rows, "leaf count diverged at {path:?} {when}");
            assert_eq!(ivalues, values, "group values diverged at {path:?} {when}");
            for (k, v) in aggs {
                let got = &iaggs[k];
                match (v, got) {
                    (Value::Float(a), Value::Float(b)) => assert!(
                        (a - b).abs() < 1e-6 || (a - b).abs() / a.abs().max(1.0) < 1e-9,
                        "{k} at {path:?} diverged {when}: full {a} vs incremental {b}"),
                    _ => assert_eq!(v, got, "{k} at {path:?} diverged {when}"),
                }
            }
        }
    }

    fn churn(levels: usize, computed: Vec<ComputedCol>, ticks: usize, seed: u32) {
        let c = cache();
        let mut w = watch(&c, levels, computed);
        let mut rnd = lcg(seed);
        {
            let mut cc = c.lock().unwrap();
            for i in 0..200u32 {
                cc.upsert(&format!("k{i}"), json!({
                    "id": format!("k{i}"),
                    "desk": DESKS[(rnd() % 4) as usize],
                    "region": REGIONS[(rnd() % 3) as usize],
                    "qty": (rnd() % 1000) as f64,
                    "px": (rnd() % 500) as f64 / 10.0,
                }).as_object().unwrap());
            }
        }
        assert_agrees(&mut w, "after the initial load");

        for t in 0..ticks {
            {
                let mut cc = c.lock().unwrap();
                for _ in 0..7 {
                    let i = rnd() % 240;
                    match rnd() % 10 {
                        // A delete, which must take its contribution with it.
                        0 => { cc.delete(&format!("k{i}")); }
                        // A regroup: the row moves to another desk/region, so
                        // one node must lose exactly what another gains.
                        1..=3 => { cc.upsert(&format!("k{i}"), json!({
                            "id": format!("k{i}"),
                            "desk": DESKS[(rnd() % 4) as usize],
                            "region": REGIONS[(rnd() % 3) as usize],
                            "qty": (rnd() % 1000) as f64,
                            "px": (rnd() % 500) as f64 / 10.0,
                        }).as_object().unwrap()); }
                        // A cell that stops being numeric contributes nothing,
                        // and must stop being counted in the AVG divisor.
                        4 => { cc.upsert(&format!("k{i}"), json!({
                            "id": format!("k{i}"),
                            "desk": DESKS[(rnd() % 4) as usize],
                            "region": REGIONS[(rnd() % 3) as usize],
                            "qty": (rnd() % 1000) as f64,
                            "px": Json::Null,
                        }).as_object().unwrap()); }
                        // An ordinary value tick.
                        _ => { cc.upsert(&format!("k{i}"), json!({
                            "id": format!("k{i}"),
                            "desk": DESKS[(rnd() % 4) as usize],
                            "region": REGIONS[(rnd() % 3) as usize],
                            "qty": (rnd() % 1000) as f64,
                            "px": (rnd() % 500) as f64 / 10.0,
                        }).as_object().unwrap()); }
                    }
                }
            }
            assert_agrees(&mut w, &format!("after tick {t}"));
        }
    }

    #[test]
    fn one_level_agrees_under_churn() { churn(1, Vec::new(), 40, 7); }

    #[test]
    fn two_levels_agree_under_churn() { churn(2, Vec::new(), 40, 11); }

    #[test]
    fn computed_columns_agree_under_churn() { churn(2, weighted(), 40, 13); }

    #[test]
    fn a_different_feed_agrees_too() { churn(2, weighted(), 40, 29); }

    #[test]
    fn a_fallen_behind_touch_log_rebuilds_rather_than_drifting() {
        // The log is bounded. Past its window `touched_since` answers None,
        // and the only correct response is to rebuild — a patch applied
        // against an incomplete change set is silently wrong.
        let c = cache();
        c.lock().unwrap().set_touch_log_cap(2);
        let mut w = watch(&c, 2, weighted());
        let mut rnd = lcg(5);
        {
            let mut cc = c.lock().unwrap();
            for i in 0..80u32 {
                cc.upsert(&format!("k{i}"), json!({
                    "id": format!("k{i}"), "desk": DESKS[(rnd() % 4) as usize],
                    "region": REGIONS[(rnd() % 3) as usize],
                    "qty": (rnd() % 1000) as f64, "px": (rnd() % 500) as f64 / 10.0,
                }).as_object().unwrap());
            }
        }
        assert_agrees(&mut w, "initial");
        for t in 0..10 {
            {
                let mut cc = c.lock().unwrap();
                // More revisions than the log holds, between polls.
                for _ in 0..12 {
                    let i = rnd() % 80;
                    cc.upsert(&format!("k{i}"), json!({
                        "id": format!("k{i}"), "desk": DESKS[(rnd() % 4) as usize],
                        "region": REGIONS[(rnd() % 3) as usize],
                        "qty": (rnd() % 1000) as f64, "px": (rnd() % 500) as f64 / 10.0,
                    }).as_object().unwrap());
                }
            }
            assert_agrees(&mut w, &format!("past the log window, tick {t}"));
        }
    }

    #[test]
    fn a_non_invertible_aggregate_keeps_the_full_scan() {
        // `min` cannot be undone for one row, so the watch must not pretend.
        let c = cache();
        let mut w = GroupWatch::new("ds".into(), c.clone(), Filter::from_json(&Json::Null),
            vec!["desk".into()],
            vec![AggSpec { column: "qty".into(), agg: Agg::Min, out: "qty".into() }],
            Vec::new(), 0);
        assert!(!w.incremental_ok());
        {
            let mut cc = c.lock().unwrap();
            for i in 0..30u32 {
                cc.upsert(&format!("k{i}"), json!({
                    "id": format!("k{i}"), "desk": DESKS[(i % 4) as usize],
                    "region": "US", "qty": (100 - i) as f64, "px": 1.0,
                }).as_object().unwrap());
            }
        }
        let first = w.snapshot();
        assert!(w.incr.is_none(), "no incremental state is kept for this watch");
        // Remove the minimum of a group; a running accumulator could not
        // recover the next-smallest, and the full scan must.
        c.lock().unwrap().delete("k28");
        let after = w.snapshot();
        assert_ne!(first[&vec!["sRates".to_string()]].0["qty"],
                   after[&vec!["sRates".to_string()]].0["qty"]);
    }

    #[test]
    fn drift_is_bounded_by_a_periodic_rebuild() {
        // Not a numerical assertion — just that the counter actually fires, so
        // the bound is real rather than a comment.
        let c = cache();
        let mut w = watch(&c, 1, Vec::new());
        c.lock().unwrap().upsert("k0", json!({
            "id":"k0","desk":"Rates","region":"US","qty":1.0,"px":1.0
        }).as_object().unwrap());
        w.snapshot();
        w.incr.as_mut().unwrap().mutations = REBUILD_AFTER_MUTATIONS;
        let before_rev = w.incr.as_ref().unwrap().rev;
        c.lock().unwrap().upsert("k1", json!({
            "id":"k1","desk":"Rates","region":"US","qty":2.0,"px":2.0
        }).as_object().unwrap());
        w.snapshot();
        let incr = w.incr.as_ref().unwrap();
        assert_eq!(incr.mutations, 0, "the rebuild reset the mutation count");
        assert!(incr.rev > before_rev);
        assert_agrees(&mut w, "after a drift rebuild");
    }
}

