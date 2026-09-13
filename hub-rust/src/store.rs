//! The shared table cache — one per (datasource, params) key, read by many
//! subscribers (multi-tenancy). This is the hub's core: cache upstream data,
//! serve it to every subscriber from ONE copy.
//!
//! Columnar by design. A blotter book is ~500k rows × ~370 columns; column-major
//! storage keeps each column contiguous (fast filter/aggregate scans) and avoids
//! a per-row hashmap. Keys and string cells are `Arc<str>`-interned, so a
//! low-cardinality column (desk, currency, rating) costs a handful of
//! allocations rather than one per row.
//!
//! Upsert is keyed and partial (a tick updates a few fields of a known row);
//! delete tombstones the slot and frees it for reuse, so churn does not grow the
//! backing vectors without bound.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use serde_json::Value as Json;

/// A single cell. Compact, and cheap to clone (strings are ref-counted).
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(Arc<str>),
}

impl Value {
    /// Convert a JSON scalar into a cell. Objects/arrays are not cell values in a
    /// flat blotter row and collapse to Null (the normalizer flattens upstream).
    pub fn from_json(j: &Json) -> Value {
        match j {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::Number(n) => {
                if let Some(i) = n.as_i64() { Value::Int(i) }
                else if let Some(u) = n.as_u64() { Value::Int(u as i64) }
                else { Value::Float(n.as_f64().unwrap_or(f64::NAN)) }
            }
            Json::String(s) => Value::Str(Arc::from(s.as_str())),
            _ => Value::Null,
        }
    }

    /// Back to JSON for the wire. Ints and floats keep their kind so the client
    /// sees the same shape the JS/Perspective path sends.
    pub fn to_json(&self) -> Json {
        match self {
            Value::Null => Json::Null,
            Value::Bool(b) => Json::Bool(*b),
            Value::Int(i) => Json::from(*i),
            Value::Float(f) => serde_json::Number::from_f64(*f).map(Json::Number).unwrap_or(Json::Null),
            Value::Str(s) => Json::String(s.to_string()),
        }
    }

    pub fn is_null(&self) -> bool { matches!(self, Value::Null) }
}

/// A row key — the synthetic `__key` the hub indexes every table by.
pub type RowKey = Arc<str>;

/// A columnar, keyed cache of one table.
pub struct TableCache {
    names: Vec<Arc<str>>,            // column order (matches the artifact)
    index: HashMap<Arc<str>, usize>, // column name -> column position
    cols: Vec<Vec<Value>>,           // column position -> per-slot cells
    keys: Vec<Option<RowKey>>,       // slot -> key, None once tombstoned
    key_to_slot: HashMap<RowKey, usize>,
    free: Vec<usize>,                // tombstoned slots, reused before growing
    interner: HashMap<Arc<str>, Arc<str>>, // dedup repeated string cells
    live: usize,
    // Change tracking for delta push: a monotonic revision, each slot's last
    // change, and a deletion log so a subscriber can pull only what moved.
    rev: u64,
    slot_rev: Vec<u64>,
    deletions: Vec<(u64, RowKey)>,
    // The deletion log is bounded: past `deletions_cap` entries the oldest are
    // dropped and `deletions_floor` records the revision below which a
    // subscriber can no longer trust it saw every delete — and must re-snapshot.
    deletions_cap: usize,
    deletions_floor: u64,
    // Batched revisions. Outside a batch every change bumps `rev` by one, which
    // is correct but makes the revision a per-ROW counter: at 10k updates/sec it
    // advances 10k times a second, and anything keyed on "still revision R" —
    // a query memo, a materialized view order — is stranded before it can be
    // read twice. Inside a batch every change shares ONE revision, assigned
    // lazily on the first actual mutation, so a 1000-row ingest advances the
    // revision once and the cache is quiescent between batches.
    //
    // Delta semantics are unchanged: `changed_since` selects `slot_rev > since`,
    // so a subscriber below the batch revision still sees every row in it, and
    // one at or above it sees none.
    batch_depth: u32,
    batch_dirty: bool,
    // Which slots each recent revision touched, so a reader that is only a few
    // revisions behind can patch what it holds instead of rebuilding it.
    //
    // `changed_since` answers the same question by scanning every slot's
    // `slot_rev`, which is O(table) — fine for a delta stream that has to
    // materialize the changed rows anyway, useless for a view trying to avoid an
    // O(table) pass. This log makes "what moved" cost the size of the move.
    //
    // Bounded: past `touch_log_cap` revisions the oldest entries are dropped and
    // a reader that far behind is told to rebuild. Keeping an unbounded history
    // to spare an occasional rebuild would trade a bounded cost for an unbounded
    // one.
    touch_log: VecDeque<(u64, Vec<usize>)>,
    touch_log_cap: usize,
    batch_touched: Vec<usize>,
    // Typed DATE columns (schema `type: "date" | "dateString" | "timestamp"`).
    // The cell keeps the feed's own string for display; this side-vector holds
    // the parsed epoch (ms, NaN = null/unparseable) so sorting and numeric
    // range filters on the column compare instants, not text. Before this the
    // CLIENT stamped a shadow `<col>__epoch` column into every row — the same
    // parse, done once per write here instead of per row per consumer there.
    date_cols: HashMap<usize, Vec<f64>>,
}

impl TableCache {
    /// Build a cache with a fixed column schema, in the given order.
    pub fn new<I, S>(columns: I) -> TableCache
    where I: IntoIterator<Item = S>, S: AsRef<str> {
        let names: Vec<Arc<str>> = columns.into_iter().map(|s| Arc::from(s.as_ref())).collect();
        let index = names.iter().enumerate().map(|(i, n)| (n.clone(), i)).collect();
        let cols = names.iter().map(|_| Vec::new()).collect();
        TableCache {
            names, index, cols,
            keys: Vec::new(), key_to_slot: HashMap::new(),
            free: Vec::new(), interner: HashMap::new(), live: 0,
            rev: 0, slot_rev: Vec::new(), deletions: Vec::new(),
            deletions_cap: 100_000, deletions_floor: 0,
            batch_depth: 0, batch_dirty: false,
            touch_log: VecDeque::new(), touch_log_cap: 64, batch_touched: Vec::new(),
            date_cols: HashMap::new(),
        }
    }

    /// Open a batch: every mutation until the matching `end_batch` shares one
    /// revision. Re-entrant, so a caller that batches cannot be broken by an
    /// inner one that also does.
    pub fn begin_batch(&mut self) { self.batch_depth += 1; }

    /// Close a batch. The revision assigned inside it stays put; the next
    /// mutation outside any batch bumps as usual.
    pub fn end_batch(&mut self) {
        self.batch_depth = self.batch_depth.saturating_sub(1);
        if self.batch_depth != 0 { return; }
        if self.batch_dirty {
            let touched = std::mem::take(&mut self.batch_touched);
            let rev = self.rev;
            self.push_touches(rev, touched);
        }
        self.batch_dirty = false;
        self.batch_touched.clear();
    }

    /// Record that `slot` moved at `rev`. Inside a batch the touches accumulate
    /// and land as one log entry when the batch closes, matching the one
    /// revision the batch shares.
    fn record_touch(&mut self, slot: usize, rev: u64) {
        if self.batch_depth > 0 { self.batch_touched.push(slot); return; }
        self.push_touches(rev, vec![slot]);
    }

    fn push_touches(&mut self, rev: u64, slots: Vec<usize>) {
        self.touch_log.push_back((rev, slots));
        while self.touch_log.len() > self.touch_log_cap { self.touch_log.pop_front(); }
    }

    /// Slots touched after `since`, or `None` when the log no longer reaches
    /// that far back and the caller must rebuild from scratch.
    ///
    /// Revisions are contiguous, so the log can answer only if its oldest entry
    /// is at or before `since + 1`. Returning `None` rather than a partial
    /// answer is the point: a patch applied against an incomplete change set is
    /// silently wrong, and silently wrong is what this whole path must not be.
    pub fn touched_since(&self, since: u64) -> Option<Vec<usize>> {
        if since == self.rev { return Some(Vec::new()); }
        if since > self.rev { return None; }
        let oldest = self.touch_log.front().map(|(r, _)| *r)?;
        if oldest > since + 1 { return None; }
        let mut out = Vec::new();
        for (r, slots) in &self.touch_log {
            if *r > since { out.extend_from_slice(slots); }
        }
        Some(out)
    }

    /// How many revisions the touch log holds, and how many it can.
    ///
    /// The CAP is the useful half: a consumer patching from revision R keeps
    /// its fast path only while `current - R` stays under it. The depth
    /// saturates within seconds of a feed starting and reads "full" from then
    /// on, so it is a fill level, not headroom — see
    /// `GroupWatch::revisions_behind` for the number that actually predicts a
    /// fallback.
    pub fn touch_log_depth(&self) -> (usize, usize) {
        (self.touch_log.len(), self.touch_log_cap)
    }

    /// Test seam: shrink the touch log so the fall-behind path can be exercised.
    pub fn set_touch_log_cap(&mut self, cap: usize) { self.touch_log_cap = cap.max(1); }

    /// Whether a slot currently holds a live row.
    pub fn is_live(&self, slot: usize) -> bool {
        self.keys.get(slot).map_or(false, |k| k.is_some())
    }

    /// The revision to stamp on a mutation happening right now.
    ///
    /// Lazily assigned inside a batch: a batch that turns out to change nothing
    /// must not advance the revision, or every no-op ingest would invalidate
    /// every cache downstream for no reason.
    fn next_rev(&mut self) -> u64 {
        if self.batch_depth > 0 {
            if !self.batch_dirty { self.rev += 1; self.batch_dirty = true; }
        } else {
            self.rev += 1;
        }
        self.rev
    }

    pub fn column_names(&self) -> &[Arc<str>] { &self.names }
    pub fn col_index(&self, name: &str) -> Option<usize> { self.index.get(name).copied() }
    /// Number of live (non-tombstoned) rows.
    pub fn len(&self) -> usize { self.live }
    pub fn is_empty(&self) -> bool { self.live == 0 }
    /// Total slots including tombstones — capacity pressure, for diagnostics.
    pub fn slot_count(&self) -> usize { self.keys.len() }

    fn intern(&mut self, s: &str) -> Arc<str> {
        if let Some(a) = self.interner.get(s) { return a.clone(); }
        let a: Arc<str> = Arc::from(s);
        self.interner.insert(a.clone(), a.clone());
        a
    }

    fn intern_value(&mut self, j: &Json) -> Value {
        match j {
            Json::String(s) => Value::Str(self.intern(s)),
            other => Value::from_json(other),
        }
    }

    /// Insert or partially update a row. Only known columns are written; a tick
    /// carrying a subset of fields leaves the rest of the row untouched.
    /// Returns true if the row was newly created.
    pub fn upsert(&mut self, key: &str, fields: &serde_json::Map<String, Json>) -> bool {
        let (slot, is_new) = match self.key_to_slot.get(key) {
            Some(&s) => (s, false),
            None => {
                let rk: RowKey = self.intern(key);
                let slot = match self.free.pop() {
                    Some(s) => { self.keys[s] = Some(rk.clone()); s }
                    None => {
                        let s = self.keys.len();
                        self.keys.push(Some(rk.clone()));
                        for c in &mut self.cols { c.push(Value::Null); }
                        self.slot_rev.push(0);
                        s
                    }
                };
                self.key_to_slot.insert(rk, slot);
                self.live += 1;
                (slot, true)
            }
        };
        for (name, jv) in fields {
            if name == "__key" { continue; }
            if let Some(&ci) = self.index.get(name.as_str()) {
                let v = self.intern_value(jv);
                if let Some(epochs) = self.date_cols.get_mut(&ci) {
                    if epochs.len() <= slot { epochs.resize(slot + 1, f64::NAN); }
                    epochs[slot] = date_epoch_ms(&v);
                }
                self.cols[ci][slot] = v;
            }
        }
        let rev = self.next_rev();
        self.slot_rev[slot] = rev;
        self.record_touch(slot, rev);
        is_new
    }

    /// Remove a row. The slot is tombstoned and its cells cleared (releasing any
    /// Arc strings), then queued for reuse. Returns true if the row existed.
    pub fn delete(&mut self, key: &str) -> bool {
        let Some(slot) = self.key_to_slot.remove(key) else { return false; };
        let rk = self.keys[slot].take();
        for c in &mut self.cols { c[slot] = Value::Null; }
        for epochs in self.date_cols.values_mut() {
            if let Some(e) = epochs.get_mut(slot) { *e = f64::NAN; }
        }
        self.free.push(slot);
        self.live -= 1;
        let rev = self.next_rev();
        self.record_touch(slot, rev);
        if let Some(rk) = rk { self.deletions.push((rev, rk)); }
        if self.deletions.len() > self.deletions_cap {
            let drop = self.deletions.len() - self.deletions_cap;
            // Everything at or below the newest dropped revision is now unknown.
            self.deletions_floor = self.deletions[drop - 1].0;
            self.deletions.drain(0..drop);
        }
        true
    }

    /// Delete every live row in ONE revision (schema, interner and slot storage
    /// kept). Each key goes through {@link delete}, so the deletion log — and
    /// therefore the delta stream's removals — see the truncation like any
    /// other delete. The restart-flush primitive: before this existed nothing
    /// could shrink a table, so a restart whose snapshot lost keys left them
    /// rendering as current.
    pub fn truncate(&mut self) -> usize {
        let keys: Vec<RowKey> = self.keys.iter().flatten().cloned().collect();
        if keys.is_empty() { return 0; }
        self.begin_batch();
        for k in &keys { self.delete(k.as_ref()); }
        self.end_batch();
        keys.len()
    }

    /// Revision below which the deletion log has been pruned. A subscriber whose
    /// last-seen revision is under this must re-snapshot rather than diff.
    pub fn deletions_floor(&self) -> u64 { self.deletions_floor }

    /// Test seam: shrink the deletion-log cap.
    pub fn set_deletions_cap(&mut self, cap: usize) { self.deletions_cap = cap.max(1); }

    /// The current revision. Outside a batch every change bumps it by one;
    /// inside one, the whole batch shares a single revision.
    pub fn revision(&self) -> u64 { self.rev }

    /// What changed since `since`: live slots modified after it, and keys deleted
    /// after it. Returns the new revision to track. This is the delta a streaming
    /// subscriber pulls each tick.
    pub fn changed_since(&self, since: u64) -> (Vec<usize>, Vec<String>, u64) {
        let mut slots = Vec::new();
        for (slot, key) in self.keys.iter().enumerate() {
            if key.is_some() && self.slot_rev[slot] > since { slots.push(slot); }
        }
        // A key deleted and then re-upserted inside the window is LIVE now and
        // already rides the upsert list — emitting its stale removal too would
        // have the client remove a live row (delete + upsert land in one
        // transaction). The re-add's slot_rev is necessarily newer than the
        // delete's revision, so "currently live" is exactly "superseded".
        // This is what makes replace_snapshot (truncate + re-ingest) safe for
        // the keys that survive the replace.
        let removed: Vec<String> = self.deletions.iter()
            .filter(|(r, _)| *r > since)
            .filter(|(_, k)| !self.key_to_slot.contains_key(k.as_ref()))
            .map(|(_, k)| k.to_string()).collect();
        (slots, removed, self.rev)
    }

    /// The cell at a slot/column, or `&Value::Null` if out of range.
    pub fn cell(&self, slot: usize, col: usize) -> &Value {
        self.cols.get(col).and_then(|c| c.get(slot)).unwrap_or(&Value::Null)
    }

    /// Mark columns as date-typed and (re)parse any cells already written.
    /// The registry calls this right after construction from the datasource
    /// schema, but late marking must not strand existing rows unparsed.
    pub fn set_date_columns<'a>(&mut self, names: impl IntoIterator<Item = &'a str>) {
        for name in names {
            let Some(&ci) = self.index.get(name) else { continue; };
            let col = &self.cols[ci];
            let epochs: Vec<f64> = col.iter().map(date_epoch_ms).collect();
            self.date_cols.insert(ci, epochs);
        }
    }

    pub fn is_date_col(&self, col: usize) -> bool { self.date_cols.contains_key(&col) }

    /// The cell as the QUERY layer should see it: date-typed columns resolve to
    /// their parsed epoch (Null when unparseable) so sorts and numeric range
    /// filters compare instants; everything else is the stored cell. Display
    /// (`row_json`) keeps the feed's own string — only comparison changes.
    pub fn query_value(&self, slot: usize, col: usize) -> Value {
        if let Some(epochs) = self.date_cols.get(&col) {
            let e = epochs.get(slot).copied().unwrap_or(f64::NAN);
            return if e.is_nan() { Value::Null } else { Value::Float(e) };
        }
        self.cell(slot, col).clone()
    }

    /// Look up a live row's cell by key and column name.
    pub fn get(&self, key: &str, col: &str) -> Option<&Value> {
        let slot = *self.key_to_slot.get(key)?;
        let ci = self.col_index(col)?;
        Some(self.cell(slot, ci))
    }

    /// The live slots, in slot order (roughly insertion order, with reused
    /// tombstones interleaved). The query layer imposes its own ordering.
    pub fn live_slots(&self) -> impl Iterator<Item = usize> + '_ {
        self.keys.iter().enumerate().filter_map(|(s, k)| k.as_ref().map(|_| s))
    }

    /// The key at a slot.
    pub fn key_at(&self, slot: usize) -> Option<&RowKey> {
        self.keys.get(slot).and_then(|k| k.as_ref())
    }

    /// Materialize one row as an ordered JSON object (column order preserved),
    /// including the `__key`. This is the wire shape a subscriber receives.
    pub fn row_json(&self, slot: usize) -> Option<Json> {
        let key = self.keys.get(slot)?.as_ref()?;
        let mut obj = serde_json::Map::new();
        obj.insert("__key".to_string(), Json::String(key.to_string()));
        for (ci, name) in self.names.iter().enumerate() {
            obj.insert(name.to_string(), self.cols[ci][slot].to_json());
        }
        Some(Json::Object(obj))
    }

    /// Column-major snapshot of every live row — the CSRM snapshot shape.
    /// `{ "__key": [...], "<col>": [...], ... }` in artifact column order.
    ///
    /// This is the whole point of a columnar cache: far cheaper than `N × row_json`
    /// (no per-row objects; each column name appears ONCE instead of per row), and
    /// the serialized form is several times smaller than the row-oriented one on a
    /// wide table. `__key` matches the delta `upserts` so the client keys rows the
    /// same way it keys transactions.
    pub fn to_columns(&self) -> Json {
        let live: Vec<usize> = self.live_slots().collect();
        let mut obj = serde_json::Map::with_capacity(self.names.len() + 1);
        let keys: Vec<Json> = live.iter()
            .map(|&s| self.keys[s].as_ref().map(|k| Json::String(k.to_string())).unwrap_or(Json::Null))
            .collect();
        obj.insert("__key".to_string(), Json::Array(keys));
        for (ci, name) in self.names.iter().enumerate() {
            let col = &self.cols[ci];
            let arr: Vec<Json> = live.iter().map(|&s| col[s].to_json()).collect();
            obj.insert(name.to_string(), Json::Array(arr));
        }
        Json::Object(obj)
    }
}

/// Epoch ms for a date-typed cell: numbers pass through as ms, strings go
/// through the ISO parser, everything else is NaN (no instant).
fn date_epoch_ms(v: &Value) -> f64 {
    match v {
        Value::Int(i) => *i as f64,
        Value::Float(f) => *f,
        Value::Str(s) => crate::expr::parse_iso_ms(s).map(|ms| ms as f64).unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields(j: Json) -> serde_json::Map<String, Json> {
        j.as_object().unwrap().clone()
    }

    fn cache() -> TableCache {
        TableCache::new(["positionId", "desk", "qty", "px"])
    }

    #[test]
    fn upsert_creates_then_partially_updates() {
        let mut t = cache();
        assert!(t.upsert("P1", &fields(json!({"positionId":"P1","desk":"Govies","qty":100,"px":99.5}))));
        assert_eq!(t.len(), 1);
        assert_eq!(t.get("P1", "qty"), Some(&Value::Int(100)));
        assert_eq!(t.get("P1", "px"), Some(&Value::Float(99.5)));

        // A tick updating only px leaves qty and desk intact.
        assert!(!t.upsert("P1", &fields(json!({"px":101.25}))));
        assert_eq!(t.get("P1", "px"), Some(&Value::Float(101.25)));
        assert_eq!(t.get("P1", "qty"), Some(&Value::Int(100)));
        assert_eq!(t.get("P1", "desk"), Some(&Value::Str(Arc::from("Govies"))));
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn delete_tombstones_and_reuses_the_slot() {
        let mut t = cache();
        t.upsert("P1", &fields(json!({"positionId":"P1","qty":1})));
        t.upsert("P2", &fields(json!({"positionId":"P2","qty":2})));
        assert_eq!(t.slot_count(), 2);
        assert!(t.delete("P1"));
        assert_eq!(t.len(), 1);
        assert!(t.get("P1", "qty").is_none());

        // A new row reuses P1's tombstoned slot rather than growing the vectors.
        t.upsert("P3", &fields(json!({"positionId":"P3","qty":3})));
        assert_eq!(t.len(), 2);
        assert_eq!(t.slot_count(), 2, "the freed slot was reused, not appended");
        assert_eq!(t.get("P3", "qty"), Some(&Value::Int(3)));
    }

    #[test]
    fn deleting_a_missing_row_is_a_noop() {
        let mut t = cache();
        assert!(!t.delete("nope"));
        assert_eq!(t.len(), 0);
    }

    #[test]
    fn string_cells_are_interned_across_rows() {
        let mut t = cache();
        for i in 0..1000 {
            t.upsert(&format!("P{i}"), &fields(json!({"desk":"Govies"})));
        }
        // All 1000 "Govies" cells share one Arc allocation.
        let a = match t.get("P0", "desk") { Some(Value::Str(s)) => s.clone(), _ => panic!() };
        let b = match t.get("P999", "desk") { Some(Value::Str(s)) => s.clone(), _ => panic!() };
        assert!(Arc::ptr_eq(&a, &b), "low-cardinality strings share one allocation");
    }

    #[test]
    fn row_json_preserves_column_order_and_includes_key() {
        let mut t = cache();
        t.upsert("P1", &fields(json!({"positionId":"P1","desk":"Govies","qty":100,"px":99.5})));
        let slot = t.live_slots().next().unwrap();
        let row = t.row_json(slot).unwrap();
        assert_eq!(serde_json::to_string(&row).unwrap(),
            r#"{"__key":"P1","positionId":"P1","desk":"Govies","qty":100,"px":99.5}"#);
    }

    #[test]
    fn unknown_columns_and_key_field_are_ignored_on_write() {
        let mut t = cache();
        t.upsert("P1", &fields(json!({"__key":"ignored","positionId":"P1","bogus":42})));
        assert_eq!(t.get("P1", "positionId"), Some(&Value::Str(Arc::from("P1"))));
        assert!(t.col_index("bogus").is_none());
    }

    #[test]
    fn batch_shares_one_revision_across_every_row() {
        let mut t = cache();
        t.begin_batch();
        for i in 0..100 {
            t.upsert(&format!("P{i}"), &fields(json!({ "positionId": format!("P{i}"), "qty": i })));
        }
        t.end_batch();
        // 100 rows, ONE revision — not 100.
        assert_eq!(t.revision(), 1);

        // And the delta is unaffected: a subscriber below the batch sees all of it.
        let (slots, removals, rev) = t.changed_since(0);
        assert_eq!(slots.len(), 100);
        assert!(removals.is_empty());
        assert_eq!(rev, 1);
        // One at the batch revision sees none of it.
        assert!(t.changed_since(1).0.is_empty());
    }

    #[test]
    fn empty_batch_does_not_advance_the_revision() {
        let mut t = cache();
        t.upsert("P1", &fields(json!({ "positionId": "P1" })));
        let before = t.revision();
        t.begin_batch();
        t.end_batch();
        // A no-op ingest must not invalidate every downstream cache.
        assert_eq!(t.revision(), before);
    }

    #[test]
    fn nested_batches_still_collapse_to_one_revision() {
        let mut t = cache();
        t.begin_batch();
        t.upsert("P1", &fields(json!({ "positionId": "P1" })));
        t.begin_batch();
        t.upsert("P2", &fields(json!({ "positionId": "P2" })));
        t.end_batch();
        // Still inside the outer batch — the inner close must not reopen bumping.
        t.upsert("P3", &fields(json!({ "positionId": "P3" })));
        t.end_batch();
        assert_eq!(t.revision(), 1);
        assert_eq!(t.changed_since(0).0.len(), 3);
    }

    #[test]
    fn deletes_inside_a_batch_share_the_batch_revision() {
        let mut t = cache();
        t.upsert("P1", &fields(json!({ "positionId": "P1" })));
        t.upsert("P2", &fields(json!({ "positionId": "P2" })));
        let before = t.revision();

        t.begin_batch();
        t.upsert("P3", &fields(json!({ "positionId": "P3" })));
        t.delete("P1");
        t.end_batch();

        assert_eq!(t.revision(), before + 1);
        let (slots, removals, _) = t.changed_since(before);
        assert_eq!(slots.len(), 1);              // P3 upserted
        assert_eq!(removals, vec!["P1".to_string()]); // P1 removed, same revision
    }

    #[test]
    fn outside_a_batch_every_change_still_bumps() {
        let mut t = cache();
        t.upsert("P1", &fields(json!({ "positionId": "P1" })));
        t.upsert("P2", &fields(json!({ "positionId": "P2" })));
        assert_eq!(t.revision(), 2);
    }
}
