//! One connected subscriber's state.

use crate::alerts::AlertSub;
use crate::delta::DeltaSub;
use crate::groupwatch::GroupWatch;
use crate::flow::Flow;
use serde_json::Value as Json;
use std::collections::HashSet;

pub struct Session {
    pub id: String,
    pub app_id: Option<String>,
    pub protocol_version: Option<i64>,
    /// Cache keys this session is subscribed to (for teardown).
    pub subscriptions: HashSet<String>,
    /// Unsolicited messages queued for delivery (deltas, errors) — flushed by
    /// the transport as socket.io events, separate from request replies.
    pub outbox: Vec<Json>,
    /// Live alert subscriptions, re-evaluated over the full cache on each tick.
    pub alerts: Vec<AlertSub>,
    /// Server-side views this session opened (for teardown on disconnect).
    pub open_views: HashSet<String>,
    /// Live row-delta streams (CSRM subscribers).
    pub deltas: Vec<DeltaSub>,
    /// Group-aggregate watches (SSRM grouped subscribers).
    pub group_watches: Vec<GroupWatch>,
    /// Ack-based backpressure state for unsolicited pushes.
    pub flow: Flow,
}

impl Session {
    pub fn new(id: impl Into<String>) -> Session {
        Session {
            id: id.into(), app_id: None, protocol_version: None,
            subscriptions: HashSet::new(), outbox: Vec::new(), alerts: Vec::new(), open_views: HashSet::new(), deltas: Vec::new(), group_watches: Vec::new(), flow: Flow::new(500),
        }
    }
    pub fn push(&mut self, msg: Json) { self.outbox.push(msg); }
    pub fn take_outbox(&mut self) -> Vec<Json> { std::mem::take(&mut self.outbox) }

    pub fn remove_alert(&mut self, rule_id: &str) -> bool {
        let before = self.alerts.len();
        self.alerts.retain(|a| a.rule_id != rule_id);
        self.alerts.len() != before
    }

    /// Re-evaluate every alert over its full cache; collect newly-fired messages.
    pub fn poll_alerts(&mut self, fired_at: Option<&str>) -> Vec<Json> {
        let mut out = Vec::new();
        for sub in &mut self.alerts { out.extend(sub.poll(fired_at)); }
        out
    }

    /// Pull each streaming subscriber's row delta since the last tick.
    pub fn poll_deltas(&mut self) -> Vec<Json> {
        let mut out = Vec::new();
        for sub in &mut self.deltas { if let Some(m) = sub.poll() { out.push(m); } }
        for w in &mut self.group_watches { if let Some(m) = w.poll() { out.push(m); } }
        out
    }

    /// Pull only the group-aggregate deltas (SSRM). The wasm hub delivers ROW
    /// deltas via a SHARED per-datasource stream (built once, broadcast to all),
    /// so the per-session row DeltaSubs are not polled there — group watches are
    /// inherently per-session (each client groups differently) and stay here.
    pub fn poll_group_deltas(&mut self) -> Vec<Json> {
        let mut out = Vec::new();
        for w in &mut self.group_watches { if let Some(m) = w.poll() { out.push(m); } }
        out
    }
}
