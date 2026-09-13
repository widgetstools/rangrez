//! The in-browser wasm surface — the whole Rust hub as a *SharedWorker* engine.
//!
//! One shared `Hub` + many `Session`s = one SharedWorker serving every tab of an
//! app (origin + appName). The hub owns the registry (refcounted per-datasource
//! caches), the open server-side views and the upstream ingest; each connected
//! MessagePort gets its own `Session` (subscriptions, delta streams, group-watches,
//! backpressure flow). This mirrors the native sidecar exactly, where one `Hub` is
//! driven by many `Endpoint`s — here the "endpoints" are ports and the driver is JS.
//!
//! It exchanges PLAIN control-message JSON over a MessagePort — the same structured
//! objects the browser `ControlClient` already sends — so the client is unchanged
//! and no socket.io codec cost biases a benchmark against Perspective's transport.

use crate::control::handle_control;
use crate::delta::DeltaSub;
use crate::hub::Hub;
use crate::ingest::apply_message;
use crate::registry::Registry;
use crate::session::Session;
use serde_json::{json, Value as Json};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

/// Entered rows materialized per viewDelta push. Key lists are complete; a
/// burst that swings more rows than this still names them all, the payload
/// just stops carrying full rows (the client fetches what it needs).
const VIEW_DELTA_ROW_CAP: usize = 200;

/// One shared hub + a map of per-port sessions. Held alive by JS across calls.
///
/// `shared_deltas` is the O(1) row-delta path: one `DeltaSub` per cache key, polled
/// ONCE per tick and broadcast to every client (they share the cache, so the delta
/// is identical). Without it, N CSRM clients each materialize the full-row delta and
/// the single thread collapses past ~2 clients.
#[wasm_bindgen]
pub struct RustHub {
    hub: Hub,
    sessions: HashMap<String, Session>,
    shared_deltas: HashMap<String, DeltaSub>,
}

#[wasm_bindgen]
impl RustHub {
    /// Construct an empty hub. The worker `boot_datasource`s config before any
    /// client subscribes (the hub starts knowing no datasources, like the sidecar).
    pub fn new() -> RustHub {
        RustHub {
            hub: Hub::from_registry(Registry::empty(), 1, "sha256:rust-wasm"),
            sessions: HashMap::new(),
            shared_deltas: HashMap::new(),
        }
    }

    /// Register one datasource config on the shared hub (the worker seeds this once,
    /// before any subscribe), reusing the `bootstrap` control path. A throwaway
    /// session carries the reply — bootstrap is hub-level, not per-subscriber.
    pub fn boot_datasource(&mut self, config_json: &str) -> String {
        let cfg: Json = serde_json::from_str(config_json).unwrap_or(Json::Null);
        let msg = json!({ "id": "boot", "type": "bootstrap", "datasources": [cfg] });
        let mut boot = Session::new("boot");
        let reply = handle_control(&mut self.hub, &mut boot, &msg);
        serde_json::to_string(&reply).unwrap_or_else(|_| "null".into())
    }

    /// Register a new subscriber (one MessagePort = one session).
    pub fn connect(&mut self, session_id: &str) {
        self.sessions
            .entry(session_id.to_string())
            .or_insert_with(|| Session::new(session_id));
    }

    /// Tear a subscriber down: dispose its open views, release its shared-cache
    /// refcounts, and drop its session (which drops its group-watches and delta
    /// streams). Returns a JSON array of the cache keys that were FULLY freed —
    /// the last subscriber left — so the worker can stop that datasource's upstream
    /// feed. A key absent from the array still has other subscribers (shared).
    pub fn disconnect(&mut self, session_id: &str) -> String {
        let mut freed: Vec<String> = Vec::new();
        if let Some(session) = self.sessions.remove(session_id) {
            for vid in &session.open_views {
                self.hub.dispose_view(vid);
            }
            for key in &session.subscriptions {
                if self.hub.registry.release(key, session_id) {
                    freed.push(key.clone());
                }
            }
        }
        serde_json::to_string(&freed).unwrap_or_else(|_| "[]".into())
    }

    /// Handle one inbound control message for a specific session. Returns a JSON
    /// ARRAY string of the reply (if any) followed by that session's queued outbox
    /// — one boundary crossing per client message.
    pub fn on_control(&mut self, session_id: &str, msg_json: &str) -> String {
        let msg: Json = match serde_json::from_str(msg_json) {
            Ok(m) => m,
            Err(_) => return "[]".into(),
        };
        let session = self
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(|| Session::new(session_id));
        let mut out: Vec<Json> = Vec::new();
        if let Some(reply) = handle_control(&mut self.hub, session, &msg) {
            out.push(reply);
        }
        out.extend(session.take_outbox());
        serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
    }

    /// Poll EVERY session's row deltas + group deltas + alerts, seq-stamped for
    /// ack-based backpressure. Returns a JSON array of `{sessionId, messages:[...]}`
    /// so the worker routes each session's pushes to its own port. The JS interval
    /// that calls this IS the delivery conflation window.
    pub fn tick(&mut self) -> String {
        // Membership deltas for watch-flagged views, routed to the session that
        // opened each view. Collected before the session loop so the `&mut`
        // borrows of `hub.views` and `sessions` never overlap.
        let mut view_deltas: HashMap<String, Vec<Json>> = HashMap::new();
        for (vid, view) in self.hub.views.iter_mut() {
            let Some((entered, left, rows)) = view.membership_delta(VIEW_DELTA_ROW_CAP) else { continue; };
            let Some(sid) = self.sessions.iter()
                .find(|(_, s)| s.open_views.contains(vid))
                .map(|(k, _)| k.clone()) else { continue; };
            view_deltas.entry(sid).or_default().push(json!({
                "type": "viewDelta", "viewId": vid,
                "entered": entered, "left": left, "rows": rows,
            }));
        }
        let mut per_session: Vec<Json> = Vec::new();
        for (sid, session) in self.sessions.iter_mut() {
            // Row deltas come from the SHARED stream (poll_shared_delta); here we
            // emit only the per-session group deltas + view deltas + alerts.
            let mut msgs = session.poll_group_deltas();
            msgs.extend(view_deltas.remove(sid).unwrap_or_default());
            msgs.extend(session.poll_alerts(None));

            let mut out: Vec<Json> = Vec::new();
            for mut m in msgs {
                let seq = session.flow.next_seq();
                if let Json::Object(ref mut o) = m {
                    o.insert("seq".into(), Json::from(seq));
                }
                out.push(m);
            }
            if session.flow.should_disconnect() {
                out.push(json!({
                    "id": "bp", "type": "error", "code": "backpressure-disconnect",
                    "message": format!(
                        "subscription dropped: {} pushes unacked (limit {})",
                        session.flow.lag(), session.flow.limit
                    ),
                }));
            }
            if !out.is_empty() {
                per_session.push(json!({ "sessionId": sid, "messages": out }));
            }
        }
        serde_json::to_string(&per_session).unwrap_or_else(|_| "[]".into())
    }

    /// Ingest one upstream message into a subscribed cache. `params_json` must
    /// match the subscribe params (same cache key). The worker flattens nested
    /// JSON before calling this (the Rust ingest assumes pre-flattened rows).
    /// Returns `"[upserts,deletes]"`. Hub-level — every session sharing this cache
    /// sees the update on its next tick.
    pub fn apply_message_json(&mut self, ds_id: &str, params_json: &str, raw_json: &str) -> String {
        let params: Json = serde_json::from_str(params_json).unwrap_or_else(|_| json!({}));
        let raw: Json = match serde_json::from_str(raw_json) {
            Ok(r) => r,
            Err(_) => return "[0,0]".into(),
        };
        let Some(ds) = self.hub.registry.datasource(ds_id).cloned() else {
            return "[0,0]".into();
        };
        // Get-or-create AND pin: ingest declares the table should exist, and
        // retention follows the data. Before this, rows applied while no
        // session was subscribed hit `cache_for` → None and were silently
        // dropped — the cold-start data loss the worker's anchor session
        // worked around.
        let Ok(cache) = self.hub.registry.ensure_pinned(ds_id, &params) else {
            return "[0,0]".into();
        };
        let (up, del) = {
            let mut guard = cache.lock().unwrap();
            apply_message(&mut guard, &ds, &raw)
        };
        format!("[{up},{del}]")
    }

    /// Delete rows by key (a JSON array of key strings). Deletions ride the
    /// delta stream like any other change, so subscribed grids receive them as
    /// `removals`. Returns `"[deleted]"`.
    pub fn delete_rows(&mut self, ds_id: &str, params_json: &str, keys_json: &str) -> String {
        let params: Json = serde_json::from_str(params_json).unwrap_or_else(|_| json!({}));
        let keys: Vec<String> = serde_json::from_str(keys_json).unwrap_or_default();
        let Some(cache) = self.hub.registry.cache_for(ds_id, &params) else {
            return "[0]".into();
        };
        let mut guard = cache.lock().unwrap();
        guard.begin_batch();
        let mut n = 0usize;
        for k in &keys {
            if guard.delete(k) { n += 1; }
        }
        guard.end_batch();
        format!("[{n}]")
    }

    /// Remove every row, keeping the schema and the table itself (and its
    /// subscriptions). One revision; the delta stream sees the truncation as
    /// removals. Returns `"[removed]"`.
    pub fn truncate(&mut self, ds_id: &str, params_json: &str) -> String {
        let params: Json = serde_json::from_str(params_json).unwrap_or_else(|_| json!({}));
        let Some(cache) = self.hub.registry.cache_for(ds_id, &params) else {
            return "[0]".into();
        };
        let n = cache.lock().unwrap().truncate();
        format!("[{n}]")
    }

    /// Atomic truncate + ingest, in ONE revision — restart semantics: after it
    /// the table holds exactly the rows sent, so a snapshot that SHRANK no
    /// longer leaves stale keys rendering as current. Keys that survive the
    /// replace are never emitted as removals (`changed_since` drops a deletion
    /// superseded by a live re-upsert). Returns `"[upserts,truncated]"`.
    pub fn replace_snapshot(&mut self, ds_id: &str, params_json: &str, raw_json: &str) -> String {
        let params: Json = serde_json::from_str(params_json).unwrap_or_else(|_| json!({}));
        let raw: Json = match serde_json::from_str(raw_json) {
            Ok(r) => r,
            Err(_) => return "[0,0]".into(),
        };
        let Some(ds) = self.hub.registry.datasource(ds_id).cloned() else {
            return "[0,0]".into();
        };
        let Ok(cache) = self.hub.registry.ensure_pinned(ds_id, &params) else {
            return "[0,0]".into();
        };
        let mut guard = cache.lock().unwrap();
        guard.begin_batch();
        let removed = guard.truncate();
        let (up, _) = apply_message(&mut guard, &ds, &raw);
        guard.end_batch();
        format!("[{up},{removed}]")
    }

    /// Drop the ingest retention pin (provider stop). The table frees now when
    /// no session holds it, else with the last disconnect. Returns "true" when
    /// the cache was freed here.
    pub fn drop_table(&mut self, ds_id: &str, params_json: &str) -> String {
        let params: Json = serde_json::from_str(params_json).unwrap_or_else(|_| json!({}));
        self.hub.registry.unpin(ds_id, &params).to_string()
    }

    /// Column-major snapshot of the whole cache for a datasource — the CSRM
    /// snapshot. Returns `{"revision":R,"rowCount":N,"columns":{__key:[...],col:[...]}}`.
    /// Built once from the columnar cache (all columns, no row objects); the worker
    /// MEMOIZES this per revision so 20 subscribers cost one build, not twenty.
    pub fn snapshot_columns(&self, ds_id: &str, params_json: &str) -> String {
        let params: Json = serde_json::from_str(params_json).unwrap_or_else(|_| json!({}));
        let Some(cache) = self.hub.registry.cache_for(ds_id, &params) else {
            return r#"{"revision":0,"rowCount":0,"columns":{}}"#.into();
        };
        let guard = cache.lock().unwrap();
        // revision FIRST so the worker can read it off the head without parsing the
        // whole (large) payload.
        let out = json!({
            "revision": guard.revision(),
            "rowCount": guard.len(),
            "columns": guard.to_columns(),
        });
        serde_json::to_string(&out).unwrap_or_else(|_| "{}".into())
    }

    /// Poll the SHARED row-delta stream for a datasource — built ONCE per tick and
    /// broadcast by the worker to every client (they share the cache, so the delta
    /// is identical). Returns a `rowDelta` JSON string, or "" if nothing changed.
    /// Get-or-creates the stream at the current revision on first poll.
    pub fn poll_shared_delta(&mut self, ds_id: &str, params_json: &str) -> String {
        let params: Json = serde_json::from_str(params_json).unwrap_or_else(|_| json!({}));
        let key = Registry::cache_key(ds_id, &params);
        if !self.shared_deltas.contains_key(&key) {
            let Some(cache) = self.hub.registry.cache_for(ds_id, &params) else { return String::new(); };
            let from = cache.lock().map(|c| c.revision()).unwrap_or(0);
            self.shared_deltas.insert(key.clone(), DeltaSub {
                datasource_id: ds_id.to_string(), cache, last_rev: from, conflate_ms: 0, last_flush: None,
            });
        }
        match self.shared_deltas.get_mut(&key).and_then(|s| s.poll()) {
            Some(m) => serde_json::to_string(&m).unwrap_or_default(),
            None => String::new(),
        }
    }

    /// Rewind the SHARED stream to `from_rev` so a joining client's snapshot@from_rev
    /// has no gap — the next broadcast re-sends every row changed since then (at
    /// CURRENT values, so existing clients re-applying it is a harmless idempotent
    /// no-op). Called on each snapshot request.
    pub fn rewind_shared_delta(&mut self, ds_id: &str, params_json: &str, from_rev: u64) {
        let params: Json = serde_json::from_str(params_json).unwrap_or_else(|_| json!({}));
        let key = Registry::cache_key(ds_id, &params);
        if let Some(s) = self.shared_deltas.get_mut(&key) {
            if from_rev < s.last_rev { s.last_rev = from_rev; }
            return;
        }
        // Not polled yet (first client): create the stream AT the snapshot revision
        // so its very first broadcast covers [from_rev, now] — no gap for tab #1.
        if let Some(cache) = self.hub.registry.cache_for(ds_id, &params) {
            self.shared_deltas.insert(key, DeltaSub {
                datasource_id: ds_id.to_string(), cache, last_rev: from_rev, conflate_ms: 0, last_flush: None,
            });
        }
    }

    /// Number of live sessions (subscribers) this hub is serving.
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    /// What this engine build can do — the client plane gates features on this
    /// instead of probing. Extend, never repurpose, these keys.
    pub fn capabilities(&self) -> String {
        json!({
            "exprContract": 1,
            "computedColumns": true,
            // Computed columns on a GROUP WATCH, with each `agg` node folded
            // per group node rather than once per view. Separate from
            // `computedColumns` because an engine can support one without the
            // other — every build before this one did.
            "groupWatchComputedColumns": true,
            "aggregates": ["sum", "avg", "count", "min", "max", "median", "stdev", "variance", "distinct_count"],
            "viewDeltas": true,
            "dateColumns": true,
            "pivotWithoutGroups": true,
        }).to_string()
    }

    /// Diagnostics for the benchmark (datasource/view/row counts).
    pub fn mem_stats(&self) -> String {
        serde_json::to_string(&self.hub.stats()).unwrap_or_else(|_| "{}".into())
    }
}
