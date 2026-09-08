//! Upstream ingest — turn feed messages into cache writes.
//!
//! A bootstrapped datasource carries a `connection` spec and the message shape
//! (`bodyShape`, `opField`, `keyColumns`). This module is the normalize + apply
//! path: parse a raw message into rows, compute each row's `__key`, resolve its
//! op, and upsert/delete against the shared cache. The socket loop
//! (`Ingestor`) sits on top and feeds it.
//!
//! The `__key` encoding is a byte-for-byte port of `rowkey.mjs`: single key
//! stringified; composite keys joined by U+0001. The hub and the browser MUST
//! agree on row identity or updates land on the wrong row — so this is the same
//! rule, not a lookalike.

use crate::registry::Datasource;
use crate::store::TableCache;
use serde_json::{Map, Value as Json};

/// U+0001 — the composite-key separator. Never a literal in source (rowkey.mjs).
const KEY_SEP: char = '\u{1}';

/// JS `String(v)` for a key part.
fn key_string(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Number(n) => n.to_string(),
        Json::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// Compute a row's `__key` from its key columns — `None` if any part is absent.
pub fn encode_key(fields: &Map<String, Json>, key_columns: &[String]) -> Option<String> {
    if key_columns.is_empty() { return None; }
    if key_columns.len() == 1 {
        return match fields.get(&key_columns[0]) {
            Some(v) if !v.is_null() => Some(key_string(v)),
            _ => None,
        };
    }
    let mut parts = Vec::with_capacity(key_columns.len());
    for c in key_columns {
        match fields.get(c) {
            Some(v) if !v.is_null() => parts.push(key_string(v)),
            _ => return None, // an incomplete composite key cannot be addressed
        }
    }
    Some(parts.join(&KEY_SEP.to_string()))
}

/// Split a message body into rows per `bodyShape` (base.mjs `bodyToRows`).
pub fn body_to_rows(parsed: &Json, body_shape: Option<&str>) -> Vec<Json> {
    match body_shape {
        Some("record") => vec![parsed.clone()],
        Some("record-array") | _ => match parsed {
            Json::Array(a) => a.clone(),
            other => vec![other.clone()],
        },
    }
}

/// A read of a dotted path, e.g. `"meta.action"`.
fn read_path<'a>(obj: &'a Json, path: &str) -> Option<&'a Json> {
    let mut cur = obj;
    for seg in path.split('.') {
        cur = cur.get(seg)?;
    }
    Some(cur)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Op { Insert, Update, Delete }

/// Resolve a row's op from `opField` (`{path, map}`); default Update.
pub fn resolve_op(row: &Json, op_field: Option<&Json>) -> Result<Op, String> {
    let Some(of) = op_field else { return Ok(Op::Update); };
    let path = of.get("path").and_then(Json::as_str).ok_or("opField.path missing")?;
    let token = read_path(row, path).map(key_string).unwrap_or_default();
    let mapped = of.get("map").and_then(|m| m.get(&token)).and_then(Json::as_str);
    match mapped {
        Some("insert") => Ok(Op::Insert),
        Some("update") => Ok(Op::Update),
        Some("delete") => Ok(Op::Delete),
        Some(other) => Err(format!("opField maps \"{token}\" to unknown op \"{other}\"")),
        None => Err(format!("unmapped op token \"{token}\" at {path}")),
    }
}

/// Coerce a JSON scalar to a declared column type, matching what the engine
/// would store: a numeric string in a float column becomes a float, etc. An
/// uncoercible value (a non-numeric string in a number column) becomes null
/// rather than a wrong type on the wire. Unknown/absent type: pass through.
pub fn coerce_json(v: &Json, ty: Option<&str>) -> Json {
    match ty {
        Some("integer") | Some("int") => match v {
            Json::Number(n) => n.as_i64().map(Json::from)
                .or_else(|| n.as_f64().map(|f| Json::from(f.trunc() as i64))).unwrap_or(Json::Null),
            Json::String(s) => s.trim().parse::<f64>().ok().map(|f| Json::from(f.trunc() as i64)).unwrap_or(Json::Null),
            Json::Bool(b) => Json::from(if *b { 1 } else { 0 }),
            _ => Json::Null,
        },
        Some("float") | Some("double") | Some("number") => match v {
            Json::Number(_) => v.clone(),
            Json::String(s) => s.trim().parse::<f64>().ok().and_then(serde_json::Number::from_f64).map(Json::Number).unwrap_or(Json::Null),
            Json::Bool(b) => Json::from(if *b { 1.0 } else { 0.0 }),
            _ => Json::Null,
        },
        Some("string") => match v { Json::Null => Json::Null, Json::String(_) => v.clone(), other => Json::String(js_scalar_string(other)) },
        Some("boolean") | Some("bool") => match v {
            Json::Bool(_) => v.clone(),
            Json::Number(n) => Json::Bool(n.as_f64().map(|f| f != 0.0).unwrap_or(false)),
            Json::String(s) => Json::Bool(!s.is_empty() && s != "false" && s != "0"),
            _ => Json::Null,
        },
        _ => v.clone(),
    }
}

fn js_scalar_string(v: &Json) -> String {
    match v { Json::Number(n) => n.to_string(), Json::Bool(b) => b.to_string(), Json::String(s) => s.clone(), _ => String::new() }
}

/// Column-name → declared-type map from a datasource config's `columns`
/// (only when columns are objects carrying a `type`).
fn column_types(config: &Json) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    if let Some(cols) = config.get("columns").and_then(Json::as_array) {
        for c in cols {
            if let (Some(name), Some(ty)) = (c.get("name").or_else(|| c.get("column")).and_then(Json::as_str), c.get("type").and_then(Json::as_str)) {
                m.insert(name.to_string(), ty.to_string());
            }
        }
    }
    m
}

/// Apply one raw feed message to the cache. Returns (upserts, deletes) applied.
pub fn apply_message(cache: &mut TableCache, ds: &Datasource, raw: &Json) -> (usize, usize) {
    let body_shape = ds.config.get("updates").and_then(|u| u.get("bodyShape")).and_then(Json::as_str)
        .or_else(|| ds.config.get("bodyShape").and_then(Json::as_str));
    let op_field = ds.config.get("opField");
    let types = column_types(&ds.config);
    let mut ups = 0;
    let mut dels = 0;

    // One upstream message is ONE revision, however many rows it carries. A
    // 1000-row STOMP batch used to advance the revision 1000 times, which left
    // no window in which the cache held still long enough for a downstream
    // memo or materialized view order to be reused.
    cache.begin_batch();
    for row in body_to_rows(raw, body_shape) {
        let Some(obj) = row.as_object() else { continue; };
        let Some(key) = encode_key(obj, &ds.key_columns) else { continue; };
        let op = match resolve_op(&row, op_field) { Ok(o) => o, Err(_) => Op::Update };
        match op {
            Op::Delete => { if cache.delete(&key) { dels += 1; } }
            Op::Insert | Op::Update => {
                // Do not write the op token itself as a data column, and coerce
                // each field to its declared schema type.
                let mut fields = obj.clone();
                if let Some(path) = op_field.and_then(|o| o.get("path")).and_then(Json::as_str) {
                    if !path.contains('.') { fields.remove(path); }
                }
                if !types.is_empty() {
                    for (name, val) in fields.iter_mut() {
                        if let Some(ty) = types.get(name.as_str()) { *val = coerce_json(val, Some(ty)); }
                    }
                }
                cache.upsert(&key, &fields);
                ups += 1;
            }
        }
    }
    cache.end_batch();
    (ups, dels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Value;
    use serde_json::json;

    fn ds(config: Json) -> Datasource {
        Datasource {
            id: "p".into(), schema_ref: "p".into(),
            columns: vec!["positionId".into(), "book".into(), "desk".into(), "qty".into()],
            key_columns: config.get("keyColumns").and_then(Json::as_array)
                .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
                .unwrap_or_else(|| vec!["positionId".into()]),
            estimated_rows: 0, connection: Json::Null, config, checksum: String::new(),
        }
    }

    #[test]
    fn composite_key_uses_u0001_separator() {
        let f = json!({"book":"CMBS","positionId":"P-1"}).as_object().unwrap().clone();
        let k = encode_key(&f, &["book".into(), "positionId".into()]).unwrap();
        assert_eq!(k, format!("CMBS{}P-1", '\u{1}'));
        // The collision rowkey.mjs warns about does NOT happen with the separator.
        let f2 = json!({"book":"CMBSP","positionId":"-1"}).as_object().unwrap().clone();
        assert_ne!(k, encode_key(&f2, &["book".into(), "positionId".into()]).unwrap());
    }

    #[test]
    fn incomplete_composite_key_is_unaddressable() {
        let f = json!({"book":"CMBS"}).as_object().unwrap().clone();
        assert!(encode_key(&f, &["book".into(), "positionId".into()]).is_none());
    }

    #[test]
    fn record_array_upserts_each_row() {
        let mut c = TableCache::new(["positionId", "desk", "qty"]);
        let d = ds(json!({"keyColumns":["positionId"],"updates":{"bodyShape":"record-array"}}));
        let (u, del) = apply_message(&mut c, &d, &json!([
            {"positionId":"A","desk":"Govies","qty":10},
            {"positionId":"B","desk":"EM","qty":20}
        ]));
        assert_eq!((u, del), (2, 0));
        assert_eq!(c.len(), 2);
        assert_eq!(c.get("A", "qty"), Some(&Value::Int(10)));
    }

    #[test]
    fn partial_update_leaves_other_fields() {
        let mut c = TableCache::new(["positionId", "desk", "qty"]);
        let d = ds(json!({"keyColumns":["positionId"]}));
        apply_message(&mut c, &d, &json!({"positionId":"A","desk":"Govies","qty":10}));
        apply_message(&mut c, &d, &json!({"positionId":"A","qty":11}));
        assert_eq!(c.get("A", "qty"), Some(&Value::Int(11)));
        assert_eq!(c.get("A", "desk"), Some(&Value::Str("Govies".into())));
    }

    #[test]
    fn op_field_delete_removes_the_row() {
        let mut c = TableCache::new(["positionId", "desk"]);
        let d = ds(json!({"keyColumns":["positionId"],"opField":{"path":"action","map":{"N":"insert","U":"update","D":"delete"}}}));
        apply_message(&mut c, &d, &json!({"positionId":"A","desk":"Govies","action":"N"}));
        assert_eq!(c.len(), 1);
        assert!(c.col_index("action").is_none(), "op token is not stored as a column");
        let (_, del) = apply_message(&mut c, &d, &json!({"positionId":"A","action":"D"}));
        assert_eq!(del, 1);
        assert_eq!(c.len(), 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The live socket loop — connect to the upstream feed and fill the cache.
// ─────────────────────────────────────────────────────────────────────────────

use crate::store::TableCache as Cache;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
#[cfg(feature = "native")]
use std::net::TcpStream;
#[cfg(feature = "native")]
use std::sync::atomic::Ordering;
#[cfg(feature = "native")]
use std::time::Duration;
#[cfg(feature = "native")]
use tungstenite::Message;

/// A request to start ingesting one (datasource, params) into a shared cache.
pub struct IngestRequest {
    pub datasource: Datasource,
    pub params: Json,
    pub cache: Arc<Mutex<Cache>>,
    /// Set when the last subscriber leaves; the ingestor stops when it sees it.
    pub shutdown: Arc<AtomicBool>,
}

/// Substitute `{key}` templates from params (base.mjs `substitute`).
pub fn substitute(template: &str, params: &Json) -> String {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' {
            let mut key = String::new();
            while let Some(&n) = chars.peek() {
                if n == '}' { chars.next(); break; }
                key.push(n); chars.next();
            }
            let v = params.get(&key).map(key_string).unwrap_or_default();
            out.push_str(&v);
        } else {
            out.push(c);
        }
    }
    out
}

/// Parse `ws://host:port/path` into a `host:port` socket target.
#[cfg(feature = "native")]
pub(crate) fn ws_target(url: &str) -> Option<String> {
    let rest = url.strip_prefix("ws://").or_else(|| url.strip_prefix("wss://"))?;
    // Authority ends at the first '/' (path) OR '?' (query) — a socket.io URL is
    // `ws://host:port?EIO=4&...` with no path, so the query must be stripped too.
    let authority = rest.split(['/', '?']).next().unwrap_or(rest);
    if authority.contains(':') { Some(authority.to_string()) }
    else { Some(format!("{authority}:80")) }
}

/// Connect a WebSocket client with a read timeout, so a stream loop can notice
/// the shutdown flag between messages. Shared by every WS-based transport.
#[cfg(feature = "native")]
pub(crate) fn ws_connect(url: &str) -> Result<tungstenite::WebSocket<TcpStream>, String> {
    let target = ws_target(url).ok_or_else(|| format!("not a ws url: {url}"))?;
    let stream = TcpStream::connect(&target).map_err(|e| format!("connect {target}: {e}"))?;
    let (ws, _resp) = tungstenite::client(url, stream).map_err(|e| format!("ws handshake: {e}"))?;
    let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(200)));
    Ok(ws)
}

/// Reconnect/backoff config (connection.reconnect), with the JS defaults.
#[cfg(feature = "native")]
struct Backoff { initial: Duration, max: Duration, factor: f64, cur: Duration }
#[cfg(feature = "native")]
impl Backoff {
    fn from(conn: &Json) -> Backoff {
        let r = conn.get("reconnect");
        let ms = |k: &str, d: u64| r.and_then(|r| r.get(k)).and_then(Json::as_u64).unwrap_or(d);
        let factor = r.and_then(|r| r.get("factor")).and_then(Json::as_f64).unwrap_or(2.0);
        let initial = Duration::from_millis(ms("initialMs", 500));
        Backoff { initial, max: Duration::from_millis(ms("maxMs", 30_000)), factor, cur: initial }
    }
    fn reset(&mut self) { self.cur = self.initial; }
    fn next(&mut self) -> Duration {
        let d = self.cur;
        self.cur = Duration::from_millis(((self.cur.as_millis() as f64 * self.factor) as u64).min(self.max.as_millis() as u64));
        d
    }
}

/// Connect to the upstream feed and stream it into the cache, with reconnect,
/// exponential backoff, and failover across endpoints — the BaseAdapter
/// lifecycle, ported. Runs until the datasource's `shutdown` flag is set (its
/// last subscriber left). Subscribe BEFORE triggering the snapshot, so no
/// updates are lost in the gap (architecture §5.5).
///
/// Transport: raw WebSocket (JSON bodies). STOMP / socket.io / REST ingest reuse
/// this loop with their own frame decode — not yet ported.
#[cfg(feature = "native")]
pub fn run_ingestor(req: IngestRequest) -> Result<(), String> {
    let ds = &req.datasource;
    // Endpoints: connection.url plus any connection.failover[].
    let mut urls: Vec<String> = Vec::new();
    if let Some(u) = ds.connection.get("url").and_then(Json::as_str) { urls.push(substitute(u, &req.params)); }
    if let Some(fo) = ds.connection.get("failover").and_then(Json::as_array) {
        for u in fo { if let Some(u) = u.as_str() { urls.push(substitute(u, &req.params)); } }
    }
    if urls.is_empty() { return Err("datasource connection has no url".into()); }

    let mut backoff = Backoff::from(&ds.connection);
    let mut url_idx = 0;
    while !req.shutdown.load(Ordering::Relaxed) {
        let url = urls[url_idx % urls.len()].clone();
        let started = std::time::Instant::now();
        eprintln!("[ingest {}] connecting {url}", ds.id);
        match stream_once(&url, ds, &req) {
            Ok(_) => { eprintln!("[ingest {}] session ended after {:?} — reconnecting", ds.id, started.elapsed()); backoff.reset(); }
            Err(e) => { eprintln!("[ingest {}] connect failed after {:?}: {e}", ds.id, started.elapsed()); url_idx += 1; }
        }
        if req.shutdown.load(Ordering::Relaxed) { break; }
        // Sleep the backoff in small slices so shutdown is responsive.
        let mut left = backoff.next();
        while left > Duration::ZERO && !req.shutdown.load(Ordering::Relaxed) {
            let slice = left.min(Duration::from_millis(100));
            std::thread::sleep(slice);
            left = left.saturating_sub(slice);
        }
    }
    Ok(())
}

/// The transport for a datasource — `connection.transport` or `connection.kind`,
/// defaulting to raw WebSocket.
#[cfg(feature = "native")]
fn transport_of(ds: &Datasource) -> String {
    ds.connection.get("transport").or_else(|| ds.connection.get("kind"))
        .and_then(Json::as_str).unwrap_or("websocket").to_lowercase()
}

/// One connect-subscribe-stream session, dispatched by transport. Returns Ok on
/// a clean close, Err if the connection could not be established (so the caller
/// fails over to the next endpoint).
#[cfg(feature = "native")]
fn stream_once(url: &str, ds: &Datasource, req: &IngestRequest) -> Result<(), String> {
    match transport_of(ds).as_str() {
        "stomp" => crate::transports::stomp_once(url, ds, req),
        "socketio" | "socket.io" => crate::transports::socketio_once(url, ds, req),
        "rest" => crate::transports::rest_once(url, ds, req),
        _ => ws_once(url, ds, req),
    }
}

/// Raw-WebSocket session: JSON bodies, optional subscribe frame, optional
/// trigger. The original and simplest transport.
#[cfg(feature = "native")]
fn ws_once(url: &str, ds: &Datasource, req: &IngestRequest) -> Result<(), String> {
    let target = ws_target(url).ok_or_else(|| format!("not a ws url: {url}"))?;
    let stream = TcpStream::connect(&target).map_err(|e| format!("connect {target}: {e}"))?;
    let (mut ws, _resp) = tungstenite::client(url, stream).map_err(|e| format!("ws handshake: {e}"))?;
    // Read timeout so the loop can notice shutdown between messages.
    let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(200)));

    // Subscribe before triggering (architecture §5.5).
    let updates = ds.config.get("updates");
    if let Some(dest) = updates.and_then(|u| u.get("destination")).and_then(Json::as_str) {
        let mut sub = serde_json::Map::new();
        sub.insert("type".into(), Json::String("subscribe".into()));
        sub.insert("destination".into(), Json::String(substitute(dest, &req.params)));
        if let Some(sel) = updates.and_then(|u| u.get("selector")).and_then(Json::as_str) {
            sub.insert("selector".into(), Json::String(substitute(sel, &req.params)));
        }
        let _ = ws.send(Message::text(Json::Object(sub).to_string()));
    }
    // Trigger the snapshot, if this feed replies to a request.
    let snapshot = ds.config.get("snapshot");
    if snapshot.and_then(|s| s.get("mode")).and_then(Json::as_str) == Some("trigger-reply") {
        if let Some(body) = snapshot.and_then(|s| s.get("triggerBody")) {
            let _ = ws.send(Message::text(substitute(&body.to_string(), &req.params)));
        }
    }

    loop {
        if req.shutdown.load(Ordering::Relaxed) { return Ok(()); }
        match ws.read() {
            Ok(Message::Text(t)) => {
                if let Ok(parsed) = serde_json::from_str::<Json>(t.as_str()) {
                    apply_message(&mut req.cache.lock().unwrap(), ds, &parsed);
                }
            }
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut => { /* idle — loop to check shutdown */ }
            Err(_) => return Ok(()), // a live connection dropped — reconnect (Ok, not failover)
        }
    }
}

#[cfg(test)]
mod polish_tests {
    use super::*;
    use crate::store::{TableCache, Value};
    use serde_json::json;

    #[test]
    fn ingest_coerces_to_declared_types() {
        let mut c = TableCache::new(["positionId", "qty", "px", "active"]);
        let d = Datasource {
            id: "p".into(), schema_ref: "p".into(),
            columns: vec!["positionId".into(), "qty".into(), "px".into(), "active".into()],
            key_columns: vec!["positionId".into()], estimated_rows: 0, connection: Json::Null,
            config: json!({"keyColumns":["positionId"],"columns":[
                {"name":"qty","type":"integer"},{"name":"px","type":"float"},{"name":"active","type":"boolean"}
            ]}),
            checksum: String::new(),
        };
        // A feed sends numbers as strings and a bool as 1 — coercion fixes the types.
        apply_message(&mut c, &d, &json!({"positionId":"A","qty":"100","px":"99.5","active":1}));
        assert_eq!(c.get("A", "qty"), Some(&Value::Int(100)));
        assert_eq!(c.get("A", "px"), Some(&Value::Float(99.5)));
        assert_eq!(c.get("A", "active"), Some(&Value::Bool(true)));
        // An uncoercible value becomes null, not a wrong-typed cell.
        apply_message(&mut c, &d, &json!({"positionId":"B","qty":"n/a"}));
        assert_eq!(c.get("B", "qty"), Some(&Value::Null));
    }

    #[test]
    fn lagging_subscriber_resnapshots_past_the_pruned_log() {
        use crate::delta::DeltaSub;
        use std::sync::{Arc, Mutex};
        let cache = Arc::new(Mutex::new(TableCache::new(["positionId", "qty"])));
        cache.lock().unwrap().set_deletions_cap(2);
        let mut sub = DeltaSub { datasource_id: "p".into(), cache: cache.clone(), last_rev: 0, conflate_ms: 0, last_flush: None };
        {
            let mut c = cache.lock().unwrap();
            for k in ["A", "B", "C"] { c.upsert(k, json!({"positionId":k,"qty":1}).as_object().unwrap()); }
        }
        // Take the snapshot (last_rev now current).
        let snap = sub.poll().unwrap();
        assert_eq!(snap["upserts"].as_array().unwrap().len(), 3);
        assert!(snap.get("reset").is_none());

        // Churn many deletes so the log prunes past the subscriber's position.
        {
            let mut c = cache.lock().unwrap();
            for k in ["A", "B", "C"] { c.delete(k); }
            for k in ["D", "E", "F", "G"] { c.upsert(k, json!({"positionId":k,"qty":2}).as_object().unwrap()); c.delete(k); }
            assert!(c.deletions_floor() > 0, "the deletion log pruned");
        }
        // The next poll detects the gap and re-snapshots with a reset flag.
        // (After all those deletes the table is empty, so this reset delta may be
        // empty; add a live row so there is something to resend.)
        cache.lock().unwrap().upsert("H", json!({"positionId":"H","qty":9}).as_object().unwrap());
        let d = sub.poll().unwrap();
        assert_eq!(d["reset"], true, "re-snapshot flagged after falling behind the pruned log");
    }
}
