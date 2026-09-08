//! Hub-side alerts, over the FULL table (architecture §9.1).
//!
//! An alert is a promise: "tell me when ANY row crosses this line." A client in
//! SSRM holds only a window, so a client-side alert would silently watch only
//! the rows scrolled into view — a blow-up 40,000 rows down would go unheard.
//! So the predicate (a DSL expression) is evaluated in the hub against every
//! cached row, and only TRANSITIONS are events: a row that stays over the line
//! for an hour fires once, not once per tick.
//!
//! In this sync hub the evaluation runs in the SUBSCRIBER's own thread on a poll
//! tick, against the shared cache — so the ingest thread just writes data and
//! every subscriber's alerts see it. The `AlertWatcher` diff logic is a faithful
//! port of `alerts.mjs`.

use crate::dsl::{eval, is_truthy, Ast, DslValue};
use crate::store::TableCache;
use serde_json::{json, Value as Json};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

/// The rows currently satisfying a predicate, over the whole cache. This is the
/// "full table" guarantee — it scans every live row, not a window.
pub fn matching_rows(cache: &TableCache, ast: &Ast) -> Vec<Json> {
    cache.live_slots().filter_map(|slot| {
        let get = |name: &str| cache.col_index(name)
            .map(|ci| DslValue::from_cell(cache.cell(slot, ci)))
            .unwrap_or(DslValue::Null);
        if is_truthy(&eval(ast, &get)) { cache.row_json(slot) } else { None }
    }).collect()
}

pub struct AlertDiff {
    /// Full rows that NEWLY match (so the alert carries the values).
    pub fired: Vec<Json>,
    /// Keys that no longer match.
    pub cleared: Vec<String>,
}

/// Tracks the matching key-set and reports entries/exits.
#[derive(Default)]
pub struct AlertWatcher {
    matching: HashSet<String>,
    pub fires: u64,
    pub clears: u64,
}

impl AlertWatcher {
    pub fn new() -> AlertWatcher { AlertWatcher::default() }

    /// Feed the CURRENT set of matching rows (each with `__key`); report the
    /// transitions since the last feed.
    pub fn feed(&mut self, rows: Vec<Json>) -> AlertDiff {
        let mut now = HashSet::new();
        let mut fired = Vec::new();
        for row in rows {
            let Some(key) = row.get("__key").and_then(Json::as_str).map(str::to_string) else { continue; };
            now.insert(key.clone());
            if !self.matching.contains(&key) { fired.push(row); self.fires += 1; }
        }
        let mut cleared = Vec::new();
        for key in &self.matching {
            if !now.contains(key) { cleared.push(key.clone()); self.clears += 1; }
        }
        self.matching = now;
        AlertDiff { fired, cleared }
    }

    /// How many rows are currently over the line.
    pub fn active_count(&self) -> usize { self.matching.len() }
}

/// Build the `alert` wire message for one fired row.
pub fn alert_message(rule_id: &str, row: &Json, fired_at: Option<&str>) -> Json {
    let mut m = serde_json::Map::new();
    m.insert("id".into(), json!(format!("a-{rule_id}")));
    m.insert("type".into(), json!("alert"));
    m.insert("ruleId".into(), json!(rule_id));
    m.insert("row".into(), row.clone());
    if let Some(t) = fired_at { m.insert("firedAt".into(), json!(t)); }
    Json::Object(m)
}

/// One live alert subscription, owned by a session.
pub struct AlertSub {
    pub rule_id: String,
    pub ast: Ast,
    pub cache: Arc<Mutex<TableCache>>,
    pub watcher: AlertWatcher,
}

impl AlertSub {
    /// Re-evaluate over the full table; return alert messages for newly-fired rows.
    pub fn poll(&mut self, fired_at: Option<&str>) -> Vec<Json> {
        let rows = { let c = self.cache.lock().unwrap(); matching_rows(&c, &self.ast) };
        self.watcher.feed(rows).fired.iter()
            .map(|row| alert_message(&self.rule_id, row, fired_at))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsl::parse;
    use serde_json::json;

    fn rows(keys: &[&str]) -> Vec<Json> {
        keys.iter().map(|k| json!({ "__key": k, "pnl": -1 })).collect()
    }

    #[test]
    fn first_feed_fires_for_every_matching_row() {
        let mut w = AlertWatcher::new();
        let d = w.feed(rows(&["a", "b"]));
        let mut keys: Vec<_> = d.fired.iter().map(|r| r["__key"].as_str().unwrap()).collect();
        keys.sort();
        assert_eq!(keys, ["a", "b"]);
    }

    #[test]
    fn a_row_that_stays_fires_once() {
        let mut w = AlertWatcher::new();
        w.feed(rows(&["a"]));
        assert!(w.feed(rows(&["a"])).fired.is_empty(), "silent while it stays matched");
    }

    #[test]
    fn crossing_fires_leaving_clears() {
        let mut w = AlertWatcher::new();
        w.feed(rows(&["a"]));
        let t1 = w.feed(rows(&["a", "b"]));
        assert_eq!(t1.fired.iter().map(|r| r["__key"].as_str().unwrap()).collect::<Vec<_>>(), ["b"]);
        let t2 = w.feed(rows(&["a"]));
        assert_eq!(t2.cleared, ["b"]);
    }

    #[test]
    fn matching_rows_scans_the_whole_cache_not_a_window() {
        let mut c = TableCache::new(["positionId", "pnl"]);
        for i in 0..1000 {
            let pnl = if i == 973 { -600_000 } else { 100 }; // one blow-up, deep in the book
            c.upsert(&format!("P{i}"), json!({"positionId":format!("P{i}"),"pnl":pnl}).as_object().unwrap());
        }
        let ast = parse("pnl < -500000").unwrap();
        let m = matching_rows(&c, &ast);
        assert_eq!(m.len(), 1, "the deep blow-up is found");
        assert_eq!(m[0]["__key"], "P973");
    }

    #[test]
    fn alert_message_shape() {
        let m = alert_message("r1", &json!({"__key":"a"}), Some("2026-01-01T00:00:00Z"));
        assert_eq!(m["type"], "alert");
        assert_eq!(m["ruleId"], "r1");
        assert_eq!(m["firedAt"], "2026-01-01T00:00:00Z");
        assert_eq!(m["row"]["__key"], "a");
    }
}
