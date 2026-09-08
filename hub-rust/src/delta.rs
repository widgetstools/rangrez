//! Live row-delta push (CSRM streaming).
//!
//! A streaming subscriber wants the snapshot then only what changes. It tracks a
//! cache revision; on each poll tick it pulls the rows modified since — and the
//! keys deleted since — and pushes ONE `rowDelta`. The first poll (revision 0)
//! returns every current row, which IS the snapshot, so there is no separate
//! snapshot path. Driven by the same tick as alerts.

use crate::store::TableCache;
use serde_json::{json, Value as Json};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub struct DeltaSub {
    pub datasource_id: String,
    pub cache: Arc<Mutex<TableCache>>,
    pub last_rev: u64,
    /// Delivery conflation (config: conflation.defaultIntervalMs).
    pub conflate_ms: u64,
    pub last_flush: Option<Instant>,
}

impl DeltaSub {
    /// Pull the delta since the last poll, or `None` if nothing changed.
    pub fn poll(&mut self) -> Option<Json> {
        // Native: conflate to at most one flush per `conflate_ms`. On wasm there is
        // no `Instant`; the JS tick interval IS the conflation window, so we flush
        // whatever changed since the last tick.
        #[cfg(not(target_arch = "wasm32"))]
        {
            if let Some(last) = self.last_flush {
                if self.conflate_ms > 0 && (last.elapsed().as_millis() as u64) < self.conflate_ms { return None; }
            }
            self.last_flush = Some(Instant::now());
        }
        let c = self.cache.lock().unwrap();
        // Fallen behind the pruned deletion log? We can no longer trust that we
        // saw every delete, so re-snapshot: reset to revision 0 and flag it so
        // the client clears its rows before applying.
        let reset = self.last_rev != 0 && self.last_rev < c.deletions_floor();
        if reset { self.last_rev = 0; }
        let (slots, removals, new_rev) = c.changed_since(self.last_rev);
        self.last_rev = new_rev;
        if slots.is_empty() && removals.is_empty() { return None; }
        let upserts: Vec<Json> = slots.iter().filter_map(|&s| c.row_json(s)).collect();
        let mut m = serde_json::Map::new();
        m.insert("id".into(), json!(format!("d-{}", self.datasource_id)));
        m.insert("type".into(), json!("rowDelta"));
        m.insert("datasourceId".into(), json!(self.datasource_id));
        m.insert("upserts".into(), json!(upserts));
        m.insert("removals".into(), json!(removals));
        if reset { m.insert("reset".into(), json!(true)); }
        Some(Json::Object(m))
    }
}
