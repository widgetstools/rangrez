//! The socket.io server endpoint, as an I/O-free state machine.
//!
//! This is the Rust twin of `attachSidecarSocket`: it performs the Engine.IO
//! OPEN handshake, acknowledges the namespace CONNECT, answers PING with PONG,
//! and routes each `msg` event through the SAME `handle_control` the SharedWorker
//! path uses. Keeping it free of the actual socket makes the whole protocol
//! deterministically testable; a thin `ws` loop feeds `on_text` and writes back
//! the frames it returns.
//!
//! The browser client is unchanged: it speaks `socketIoPort`, and these frames
//! are exactly what that client sends and expects.

use crate::control::handle_control;
use crate::hub::Hub;
use crate::session::Session;
use crate::socketio::{decode_engine_io, decode_socket_io, encode_event, eio, sio, PONG};
use serde_json::{json, Value as Json};

const CONTROL_EVENT: &str = "msg";

pub struct Endpoint {
    pub session: Session,
    connected: bool,
    closing: bool,
}

impl Endpoint {
    /// Create an endpoint for a new connection. Returns the endpoint and the
    /// OPEN frame the server must send first (the client waits for it).
    pub fn new(sid: impl Into<String>) -> (Endpoint, String) {
        let sid = sid.into();
        let open = crate::socketio::encode_open(&sid);
        (Endpoint { session: Session::new(sid), connected: false, closing: false }, open)
    }

    pub fn is_connected(&self) -> bool { self.connected }
    /// The transport should close after flushing — a subscriber dropped for
    /// backpressure (architecture §7.4).
    pub fn is_closing(&self) -> bool { self.closing }

    /// Handle one inbound text frame; return the frames to write back (including
    /// any queued unsolicited messages from the control handler).
    pub fn on_text(&mut self, hub: &mut Hub, text: &str) -> Vec<String> {
        let pkt = decode_engine_io(text);
        match pkt.kind {
            Some(k) if k == eio::PING => vec![PONG.to_string()],
            Some(k) if k == eio::CLOSE => Vec::new(),
            Some(k) if k == eio::MESSAGE => self.on_message(hub, &pkt.payload),
            _ => Vec::new(),
        }
    }

    fn on_message(&mut self, hub: &mut Hub, payload: &str) -> Vec<String> {
        let sio_pkt = decode_socket_io(payload);
        match sio_pkt.kind {
            // Namespace join — ack it; only now does the client flush its outbox.
            Some(k) if k == sio::CONNECT => {
                self.connected = true;
                vec![format!("{}{}", eio::MESSAGE, sio::CONNECT)]
            }
            Some(k) if k == sio::EVENT => {
                let Some(Json::Array(arr)) = sio_pkt.data else { return Vec::new(); };
                let event = arr.first().and_then(Json::as_str).unwrap_or("");
                if event != CONTROL_EVENT { return Vec::new(); }
                let msg = arr.get(1).cloned().unwrap_or(Json::Null);

                let mut frames = Vec::new();
                if let Some(reply) = handle_control(hub, &mut self.session, &msg) {
                    frames.push(encode_event(CONTROL_EVENT, &reply, "/"));
                }
                // Any unsolicited messages the handler queued (deltas, errors).
                for m in self.session.take_outbox() {
                    frames.push(encode_event(CONTROL_EVENT, &m, "/"));
                }
                frames
            }
            _ => Vec::new(),
        }
    }

    /// Poll tick: re-evaluate alerts, deltas, and group deltas over the full
    /// cache and return frames for any that fired. Driven by the transport's read
    /// timeout, so pushes reach the client without it asking. Each push carries a
    /// `seq` for ack-based backpressure; a client that stops acking past the flow
    /// limit is dropped.
    pub fn tick(&mut self, fired_at: Option<&str>) -> Vec<String> {
        let mut msgs = self.session.poll_deltas();
        msgs.extend(self.session.poll_alerts(fired_at));

        let mut frames = Vec::new();
        for mut m in msgs {
            let seq = self.session.flow.next_seq();
            if let Json::Object(ref mut o) = m { o.insert("seq".into(), Json::from(seq)); }
            frames.push(encode_event(CONTROL_EVENT, &m, "/"));
        }
        // A client that has stopped consuming entirely is dropped, with a reason.
        if self.session.flow.should_disconnect() {
            self.closing = true;
            let err = json!({
                "id": "bp", "type": "error", "code": "backpressure-disconnect",
                "message": format!("subscription dropped: {} pushes unacked (limit {})", self.session.flow.lag(), self.session.flow.limit),
            });
            frames.push(encode_event(CONTROL_EVENT, &err, "/"));
        }
        frames
    }

    /// Frame a server-initiated push (a delta or error) as a control event.
    pub fn push_frame(msg: &Json) -> String {
        encode_event(CONTROL_EVENT, msg, "/")
    }
}
