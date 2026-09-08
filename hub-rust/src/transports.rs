//! Ingest transports beyond raw WebSocket: STOMP, socket.io, and REST.
//!
//! Each is a `*_once` session function with the same contract as the raw-WS one
//! (`ingest::ws_once`): connect, subscribe BEFORE triggering the snapshot
//! (architecture §5.5), stream rows into the cache via `apply_message`, and
//! return Ok on a clean close / Err if the connection could not be established
//! (so `run_ingestor` fails over). Reconnect, backoff, failover and shutdown are
//! all handled by the caller.

use crate::ingest::{apply_message, substitute, ws_connect, IngestRequest};
use crate::registry::Datasource;
use serde_json::{json, Value as Json};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tungstenite::Message;

// ───────────────────────────────── STOMP ───────────────────────────────────

const STOMP_NULL: char = '\u{0}';

/// STOMP 1.2 header escaping (exempt for CONNECT/CONNECTED per spec).
fn escape_header(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for ch in v.chars() {
        match ch { '\\' => out.push_str("\\\\"), '\r' => out.push_str("\\r"), '\n' => out.push_str("\\n"), ':' => out.push_str("\\c"), _ => out.push(ch) }
    }
    out
}

fn encode_frame(command: &str, headers: &[(&str, &str)], body: &str) -> String {
    let exempt = command == "CONNECT" || command == "CONNECTED";
    let mut s = String::from(command);
    s.push('\n');
    for (k, v) in headers {
        if exempt { s.push_str(&format!("{k}:{v}\n")); }
        else { s.push_str(&format!("{}:{}\n", escape_header(k), escape_header(v))); }
    }
    s.push('\n');
    s.push_str(body);
    s.push(STOMP_NULL);
    s
}

#[derive(Debug)]
struct StompFrame { command: String, headers: Vec<(String, String)>, body: String }

impl StompFrame {
    fn header(&self, k: &str) -> Option<&str> { self.headers.iter().find(|(hk, _)| hk == k).map(|(_, v)| v.as_str()) }
}

/// Incremental STOMP frame splitter (a broker may coalesce or split frames).
#[derive(Default)]
struct FrameBuffer { buf: String }

impl FrameBuffer {
    fn push(&mut self, chunk: &str) -> Vec<StompFrame> {
        self.buf.push_str(chunk);
        let mut frames = Vec::new();
        loop {
            // Skip leading heartbeats (bare newlines).
            while self.buf.starts_with('\n') || self.buf.starts_with("\r\n") {
                let n = if self.buf.starts_with("\r\n") { 2 } else { 1 };
                self.buf.drain(0..n);
            }
            if self.buf.is_empty() { break; }
            let Some(header_end) = self.buf.find("\n\n") else { break; };
            let head = self.buf[..header_end].to_string();
            // content-length decides the body end; otherwise the NULL does.
            let clen = head.lines().find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().ok())).flatten();
            let body_start = header_end + 2;
            let (body_end_excl, frame_end) = if let Some(n) = clen {
                let e = body_start + n;
                if self.buf.len() < e + 1 { break; } // wait for full body + NULL
                (e, e + 1)
            } else {
                match self.buf[body_start..].find(STOMP_NULL) {
                    Some(rel) => (body_start + rel, body_start + rel + 1),
                    None => break, // NULL not yet arrived
                }
            };
            let body = self.buf[body_start..body_end_excl].to_string();
            frames.push(parse_head(&head, body));
            self.buf.drain(0..frame_end);
        }
        frames
    }
}

fn parse_head(head: &str, body: String) -> StompFrame {
    let mut lines = head.lines();
    let command = lines.next().unwrap_or("").trim().to_string();
    let exempt = command == "CONNECT" || command == "CONNECTED";
    let mut headers = Vec::new();
    for line in lines {
        if let Some(i) = line.find(':') {
            let (k, v) = (&line[..i], &line[i + 1..]);
            let (k, v) = if exempt { (k.to_string(), v.to_string()) } else { (unescape(k), unescape(v)) };
            if !headers.iter().any(|(hk, _): &(String, String)| hk == &k) { headers.push((k, v)); }
        }
    }
    StompFrame { command, headers, body }
}

fn unescape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' { out.push(c); continue; }
        match chars.next() { Some('\\') => out.push('\\'), Some('r') => out.push('\r'), Some('n') => out.push('\n'), Some('c') => out.push(':'), other => { if let Some(o) = other { out.push(o); } } }
    }
    out
}

pub fn stomp_once(url: &str, ds: &Datasource, req: &IngestRequest) -> Result<(), String> {
    let mut ws = ws_connect(url)?;
    let hb = format!("{},{}",
        ds.connection.get("heartbeat").and_then(|h| h.get("outMs")).and_then(Json::as_u64).unwrap_or(0),
        ds.connection.get("heartbeat").and_then(|h| h.get("inMs")).and_then(Json::as_u64).unwrap_or(0));
    let host = ds.connection.get("vhost").and_then(Json::as_str).unwrap_or("localhost");
    let _ = ws.send(Message::text(encode_frame("CONNECT", &[("accept-version", "1.2"), ("host", host), ("heart-beat", &hb)], "")));

    let mut fb = FrameBuffer::default();
    let snapshot = ds.config.get("snapshot");
    let updates = ds.config.get("updates");
    let listen = updates.and_then(|u| u.get("destination")).and_then(Json::as_str)
        .or_else(|| snapshot.and_then(|s| s.get("replyDestination")).and_then(Json::as_str))
        .map(|d| substitute(d, &req.params));

    // What we advertised we can send (heartbeat.outMs). The negotiated interval
    // is settled from the server's CONNECTED frame.
    let cx = ds.connection.get("heartbeat").and_then(|h| h.get("outMs")).and_then(Json::as_u64).unwrap_or(0);
    let mut hb_send_ms: u64 = 0;
    let mut last_hb = Instant::now();

    loop {
        if req.shutdown.load(Ordering::Relaxed) { return Ok(()); }
        // Emit a STOMP heartbeat (bare newline) before the negotiated deadline,
        // else the broker drops the connection (which showed as a ~1.3s stall/
        // reconnect cycle). Sent at half the interval for jitter margin.
        if hb_send_ms > 0 && (last_hb.elapsed().as_millis() as u64) >= hb_send_ms / 2 {
            let _ = ws.send(Message::text("\n"));
            last_hb = Instant::now();
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                for f in fb.push(t.as_str()) {
                    match f.command.as_str() {
                        "CONNECTED" => {
                            // Negotiate heartbeat: server "sx,sy"; client->server
                            // interval is max(cx, sy) when both are non-zero.
                            let sy = f.header("heart-beat")
                                .and_then(|hb| hb.split(',').nth(1))
                                .and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
                            hb_send_ms = if cx == 0 || sy == 0 { 0 } else { cx.max(sy) };
                            eprintln!("[stomp {}] CONNECTED heart-beat={:?} -> send every {}ms", ds.id, f.header("heart-beat"), hb_send_ms);
                            // Subscribe FIRST, then trigger the snapshot.
                            if let Some(dest) = &listen {
                                let _ = ws.send(Message::text(encode_frame("SUBSCRIBE", &[("id", "sub-0"), ("destination", dest), ("ack", "auto")], "")));
                            }
                            if snapshot.and_then(|s| s.get("mode")).and_then(Json::as_str) == Some("trigger-reply") {
                                let dest = snapshot.and_then(|s| s.get("triggerDestination")).and_then(Json::as_str).map(|d| substitute(d, &req.params)).unwrap_or_default();
                                let body = snapshot.and_then(|s| s.get("triggerBody")).map(|b| match b { Json::String(s) => substitute(s, &req.params), other => substitute(&other.to_string(), &req.params) }).unwrap_or_default();
                                let cl = body.len().to_string();
                                let _ = ws.send(Message::text(encode_frame("SEND", &[("destination", &dest), ("content-length", &cl)], &body)));
                            }
                        }
                        "MESSAGE" => {
                            if let Ok(parsed) = serde_json::from_str::<Json>(&f.body) {
                                apply_message(&mut req.cache.lock().unwrap(), ds, &parsed);
                            }
                        }
                        "ERROR" => return Err(f.header("message").unwrap_or("STOMP ERROR").to_string()),
                        _ => {} // HEARTBEAT / RECEIPT / other
                    }
                }
            }
            Ok(Message::Close(cf)) => { eprintln!("[stomp {}] server Close: {cf:?}", ds.id); return Ok(()); }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if is_idle(&e) => {}
            Err(e) => { eprintln!("[stomp {}] read error: {e}", ds.id); return Ok(()); }
        }
    }
}

// ─────────────────────────────── socket.io ─────────────────────────────────

pub fn socketio_once(url: &str, ds: &Datasource, req: &IngestRequest) -> Result<(), String> {
    use crate::socketio::{decode_engine_io, decode_socket_io, encode_event, eio, sio, PONG};
    // Engine.IO requires these query params or the server 400s the upgrade.
    let sep = if url.contains('?') { '&' } else { '?' };
    let full = format!("{url}{sep}EIO=4&transport=websocket");
    let mut ws = ws_connect(&full)?;

    let namespace = ds.connection.get("vhost").and_then(Json::as_str).unwrap_or("/").to_string();
    let updates = ds.config.get("updates");
    let snapshot = ds.config.get("snapshot");
    let wanted = updates.and_then(|u| u.get("destination")).and_then(Json::as_str).map(|d| substitute(d, &req.params)).unwrap_or_else(|| "rows".into());

    loop {
        if req.shutdown.load(Ordering::Relaxed) { return Ok(()); }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let pkt = decode_engine_io(t.as_str());
                match pkt.kind {
                    Some(k) if k == eio::PING => { let _ = ws.send(Message::text(PONG)); }
                    Some(k) if k == eio::OPEN => {
                        // Join the namespace.
                        let ns = if namespace != "/" { namespace.as_str() } else { "" };
                        let _ = ws.send(Message::text(format!("{}{}{}", eio::MESSAGE, sio::CONNECT, ns)));
                    }
                    Some(k) if k == eio::MESSAGE => {
                        let sp = decode_socket_io(&pkt.payload);
                        match sp.kind {
                            Some(k) if k == sio::CONNECT => {
                                // Subscribe before triggering (architecture §5.5).
                                if let Some(dest) = updates.and_then(|u| u.get("destination")).and_then(Json::as_str) {
                                    let sel = updates.and_then(|u| u.get("selector")).cloned().unwrap_or(Json::Null);
                                    let _ = ws.send(Message::text(encode_event("subscribe", &json!({"destination": substitute(dest, &req.params), "selector": sel}), &namespace)));
                                }
                                if snapshot.and_then(|s| s.get("mode")).and_then(Json::as_str) == Some("trigger-reply") {
                                    let td = snapshot.and_then(|s| s.get("triggerDestination")).and_then(Json::as_str).unwrap_or("snapshot");
                                    let body = snapshot.and_then(|s| s.get("triggerBody")).cloned().unwrap_or(json!({}));
                                    let _ = ws.send(Message::text(encode_event(td, &body, &namespace)));
                                }
                            }
                            Some(k) if k == sio::EVENT => {
                                if let Some(arr) = sp.data.as_ref().and_then(Json::as_array) {
                                    let event = arr.first().and_then(Json::as_str).unwrap_or("");
                                    if event == wanted {
                                        if let Some(payload) = arr.get(1) {
                                            apply_message(&mut req.cache.lock().unwrap(), ds, payload);
                                        }
                                    }
                                }
                            }
                            Some(k) if k == sio::ERROR => return Err("socket.io error".into()),
                            _ => {}
                        }
                    }
                    Some(k) if k == eio::CLOSE => return Ok(()),
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if is_idle(&e) => {}
            Err(_) => return Ok(()),
        }
    }
}

// ───────────────────────────────── REST ────────────────────────────────────

/// REST snapshot (one HTTP GET) then, if configured, updates over a WebSocket.
/// A minimal HTTP/1.1 client — enough for a localhost snapshot endpoint; a
/// production build would use a real HTTP client with pagination and chunked
/// decoding.
pub fn rest_once(url: &str, ds: &Datasource, req: &IngestRequest) -> Result<(), String> {
    // 1. Fetch the snapshot and apply it.
    let snap = http_get_json(url)?;
    apply_message(&mut req.cache.lock().unwrap(), ds, &snap);

    // 2. If there's an updates WebSocket, stream it (reuse the raw-WS loop shape).
    let updates_url = ds.connection.get("updatesUrl").and_then(Json::as_str);
    let Some(u) = updates_url else { return Ok(()); }; // static reference table
    let u = substitute(u, &req.params);
    let mut ws = ws_connect(&u)?;
    let updates = ds.config.get("updates");
    if let Some(dest) = updates.and_then(|u| u.get("destination")).and_then(Json::as_str) {
        let _ = ws.send(Message::text(json!({"type":"subscribe","destination": substitute(dest, &req.params)}).to_string()));
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
            Err(tungstenite::Error::Io(e)) if is_idle(&e) => {}
            Err(_) => return Ok(()),
        }
    }
}

/// Minimal HTTP/1.1 GET returning the parsed JSON body. Close-delimited.
fn http_get_json(url: &str) -> Result<Json, String> {
    let rest = url.strip_prefix("http://").ok_or_else(|| format!("not an http url: {url}"))?;
    let (authority, path) = match rest.find('/') { Some(i) => (&rest[..i], &rest[i..]), None => (rest, "/") };
    let target = if authority.contains(':') { authority.to_string() } else { format!("{authority}:80") };
    let mut stream = TcpStream::connect(&target).map_err(|e| format!("connect {target}: {e}"))?;
    let host = authority.split(':').next().unwrap_or(authority);
    let reqs = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nAccept: application/json\r\nConnection: close\r\n\r\n");
    stream.write_all(reqs.as_bytes()).map_err(|e| format!("write: {e}"))?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).map_err(|e| format!("read: {e}"))?;
    let text = String::from_utf8_lossy(&buf);
    let body = text.split("\r\n\r\n").nth(1).ok_or("no HTTP body")?;
    serde_json::from_str::<Json>(body.trim()).map_err(|e| format!("snapshot JSON: {e}"))
}

fn is_idle(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stomp_frame_round_trips() {
        let f = encode_frame("SEND", &[("destination", "/q/x"), ("content-length", "2")], "hi");
        assert!(f.starts_with("SEND\ndestination:/q/x\n"));
        assert!(f.ends_with("\n\nhi\u{0}"));
    }

    #[test]
    fn frame_buffer_splits_coalesced_and_partial() {
        let mut fb = FrameBuffer::default();
        // Two frames in one chunk.
        let two = format!("CONNECTED\nversion:1.2\n\n{0}MESSAGE\ndestination:/d\n\n[{{\"k\":1}}]{0}", '\u{0}');
        let frames = fb.push(&two);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].command, "CONNECTED");
        assert_eq!(frames[1].command, "MESSAGE");
        assert_eq!(frames[1].body, "[{\"k\":1}]");
        // A frame split across two chunks.
        let mut fb2 = FrameBuffer::default();
        assert_eq!(fb2.push("MESSAGE\ndest").len(), 0);
        let f = fb2.push(&format!("ination:/d\n\nbody{}", '\u{0}'));
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].body, "body");
    }

    #[test]
    fn header_escaping_round_trips() {
        assert_eq!(escape_header("a:b\nc"), "a\\cb\\nc");
        assert_eq!(unescape("a\\cb\\nc"), "a:b\nc");
    }
}
