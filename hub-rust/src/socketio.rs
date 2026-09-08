//! Engine.IO / Socket.IO wire codec — a faithful Rust port of
//! `packages/dshub-spec/src/socketio-codec.mjs`.
//!
//! socket.io is Engine.IO framing (`<type><payload>`) with the Socket.IO
//! protocol layered on top (`<type>[namespace,]<json>`), both plain text over a
//! normal WebSocket. It is a small codec, not a dependency — which is also why
//! it is portable to Rust 1.78 where socketioxide (needs 1.94) is not.
//!
//! This MUST match the JS codec byte-for-byte: the browser client
//! (`socketIoPort`) speaks the JS framing, and the conformance corpus pins it.
//! The tests assert against golden strings captured from the JS `encode*`/
//! `decode*` functions directly.

use serde::Serialize;
use serde_json::Value;

/// Engine.IO packet type (the leading character).
pub mod eio {
    pub const OPEN: char = '0';
    pub const CLOSE: char = '1';
    pub const PING: char = '2';
    pub const PONG: char = '3';
    pub const MESSAGE: char = '4';
}

/// Socket.IO packet type (the character after the Engine.IO `4`).
pub mod sio {
    pub const CONNECT: char = '0';
    pub const DISCONNECT: char = '1';
    pub const EVENT: char = '2';
    pub const ACK: char = '3';
    pub const ERROR: char = '4';
}

/// `2` — the Engine.IO PING packet, answered with `PONG`.
pub const PING: &str = "2";
/// `3` — the Engine.IO PONG packet.
pub const PONG: &str = "3";

/// A decoded Engine.IO packet: `<type><payload>`.
#[derive(Debug, Clone, PartialEq)]
pub struct EnginePacket {
    /// `None` for an empty frame, mirroring the JS `{ type: null }`.
    pub kind: Option<char>,
    pub payload: String,
}

/// Decode one Engine.IO packet.
pub fn decode_engine_io(text: &str) -> EnginePacket {
    match text.chars().next() {
        None => EnginePacket { kind: None, payload: String::new() },
        Some(c) => EnginePacket { kind: Some(c), payload: text[c.len_utf8()..].to_string() },
    }
}

/// A decoded Socket.IO packet body.
#[derive(Debug, Clone, PartialEq)]
pub struct SocketPacket {
    pub kind: Option<char>,
    /// Binary-attachment syntax (`51-…`) is reported, not silently misparsed.
    pub binary: bool,
    pub namespace: String,
    pub data: Option<Value>,
}

/// Decode a Socket.IO packet body (the payload of an Engine.IO `4`).
pub fn decode_socket_io(payload: &str) -> SocketPacket {
    if payload.is_empty() {
        return SocketPacket { kind: None, binary: false, namespace: "/".into(), data: None };
    }
    let kind = payload.chars().next();
    let mut rest = &payload[1..];

    if starts_binary(rest) {
        return SocketPacket { kind, binary: true, namespace: "/".into(), data: None };
    }

    let mut namespace = String::from("/");
    if rest.starts_with('/') {
        match rest.find(',') {
            None => { namespace = rest.to_string(); rest = ""; }
            Some(comma) => { namespace = rest[..comma].to_string(); rest = &rest[comma + 1..]; }
        }
    }

    // JS: parse if non-empty, and fall soft to null on a parse error.
    let data = if rest.is_empty() { None } else { serde_json::from_str::<Value>(rest).ok() };
    SocketPacket { kind, binary: false, namespace, data }
}

/// `^\d+-` — one or more digits then a dash marks a binary attachment header.
fn starts_binary(rest: &str) -> bool {
    let b = rest.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() { i += 1; }
    i > 0 && i < b.len() && b[i] == b'-'
}

/// Encode a Socket.IO EVENT inside an Engine.IO message: `42[name,payload]`.
pub fn encode_event(name: &str, payload: &Value, namespace: &str) -> String {
    let ns = if !namespace.is_empty() && namespace != "/" { format!("{namespace},") } else { String::new() };
    // JSON.stringify([name, payload]) — a 2-tuple serializes to a 2-element array.
    let body = serde_json::to_string(&(name, payload)).expect("event payload serializes");
    format!("{}{}{}{}", eio::MESSAGE, sio::EVENT, ns, body)
}

#[derive(Serialize)]
struct Handshake<'a> {
    sid: &'a str,
    upgrades: Vec<String>,
    #[serde(rename = "pingInterval")]
    ping_interval: u64,
    #[serde(rename = "pingTimeout")]
    ping_timeout: u64,
}

/// The Engine.IO OPEN handshake a server sends on connect (default timings).
pub fn encode_open(sid: &str) -> String {
    encode_open_with(sid, 25000, 20000)
}

/// The Engine.IO OPEN handshake with explicit ping timings.
pub fn encode_open_with(sid: &str, ping_interval: u64, ping_timeout: u64) -> String {
    let hs = Handshake { sid, upgrades: Vec::new(), ping_interval, ping_timeout };
    format!("{}{}", eio::OPEN, serde_json::to_string(&hs).expect("handshake serializes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- goldens captured from packages/dshub-spec/src/socketio-codec.mjs ----

    #[test]
    fn encode_open_matches_js_byte_for_byte() {
        assert_eq!(encode_open("srv"),
            r#"0{"sid":"srv","upgrades":[],"pingInterval":25000,"pingTimeout":20000}"#);
        assert_eq!(encode_open_with("abc", 10000, 5000),
            r#"0{"sid":"abc","upgrades":[],"pingInterval":10000,"pingTimeout":5000}"#);
    }

    #[test]
    fn encode_event_matches_js() {
        assert_eq!(encode_event("msg", &json!({"type":"hello","n":1}), "/"),
            r#"42["msg",{"type":"hello","n":1}]"#);
        assert_eq!(encode_event("msg", &json!([1, 2]), "/trades"),
            r#"42/trades,["msg",[1,2]]"#);
        assert_eq!(encode_event("ping", &Value::Null, "/"),
            r#"42["ping",null]"#);
    }

    #[test]
    fn decode_engine_io_matches_js() {
        let p = decode_engine_io("2");
        assert_eq!(p.kind, Some('2'));
        assert_eq!(p.payload, "");
        let m = decode_engine_io(r#"42["msg",{"a":1}]"#);
        assert_eq!(m.kind, Some('4'));
        assert_eq!(m.payload, r#"2["msg",{"a":1}]"#);
        assert_eq!(decode_engine_io("").kind, None);
    }

    #[test]
    fn decode_socket_io_matches_js() {
        let e = decode_socket_io(r#"2["msg",{"a":1}]"#);
        assert_eq!(e.kind, Some('2'));
        assert_eq!(e.namespace, "/");
        assert_eq!(e.data, Some(json!(["msg", {"a":1}])));

        let ns = decode_socket_io(r#"2/trades,["ev",{"x":1}]"#);
        assert_eq!(ns.namespace, "/trades");
        assert_eq!(ns.data, Some(json!(["ev", {"x":1}])));

        let c = decode_socket_io("0");
        assert_eq!(c.kind, Some('0'));
        assert_eq!(c.namespace, "/");
        assert_eq!(c.data, None);

        let bin = decode_socket_io(r#"51-["ev"]"#);
        assert_eq!(bin.kind, Some('5'));
        assert!(bin.binary);
        assert_eq!(bin.data, None);

        let nso = decode_socket_io("0/admin");
        assert_eq!(nso.namespace, "/admin");
        assert_eq!(nso.data, None);
    }

    #[test]
    fn round_trip_event_through_both_layers() {
        // What the sidecar does: encode an event, then a client decodes it.
        let wire = encode_event("msg", &json!({"type":"configAck","bundleVersion":7}), "/");
        let eng = decode_engine_io(&wire);
        assert_eq!(eng.kind, Some(eio::MESSAGE));
        let pkt = decode_socket_io(&eng.payload);
        assert_eq!(pkt.kind, Some(sio::EVENT));
        let arr = pkt.data.unwrap();
        assert_eq!(arr[0], "msg");
        assert_eq!(arr[1]["type"], "configAck");
        assert_eq!(arr[1]["bundleVersion"], 7);
    }
}
