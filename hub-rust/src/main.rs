//! dshub-sidecar-rs — the DataSource Hub, native host, runnable.
//!
//! A sync, thread-per-connection WebSocket server (no async runtime — clean on
//! Rust 1.78). Each connection gets an `Endpoint`; inbound text frames feed
//! `Endpoint::on_text` and the returned frames are written straight back. The
//! `Hub` is shared behind one `Arc<Mutex<..>>`, so every subscriber reads the
//! same multi-tenant caches.
//!
//! Run:  cargo run --release            (listens on 127.0.0.1:8787)
//!       DSHUB_PORT=9000 cargo run --release

use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

use dshub::hub::Hub;
use dshub::ingest::{run_ingestor, IngestRequest};
use dshub::registry::Registry;
use dshub::server::Endpoint;
use std::sync::mpsc;
use tungstenite::Message;

/// The hub starts EMPTY. An app connects, `bootstrap`s it with the full upstream
/// datasource config, then subscribes — so config lives with the app, and the
/// first app to push a config establishes the shared cache for the rest.
fn empty_hub(ingest_tx: mpsc::Sender<IngestRequest>) -> Hub {
    let mut hub = Hub::from_registry(Registry::empty(), 1, "sha256:rust-sidecar");
    hub.ingest_tx = Some(ingest_tx);
    hub
}

fn main() {
    let port: u16 = std::env::var("DSHUB_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(8787);

    // The ingest manager: one thread per newly-created shared cache opens the
    // upstream feed and fills it. A subscribe that creates a cache sends here.
    let (ingest_tx, ingest_rx) = mpsc::channel::<IngestRequest>();
    thread::spawn(move || {
        for req in ingest_rx {
            let ds = req.datasource.id.clone();
            thread::spawn(move || {
                if let Err(e) = run_ingestor(req) {
                    eprintln!("[dshub-sidecar-rs] ingest \"{ds}\" ended: {e}");
                }
            });
        }
    });

    let hub = Arc::new(Mutex::new(empty_hub(ingest_tx)));

    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap_or_else(|e| {
        eprintln!("[dshub-sidecar-rs] cannot bind 127.0.0.1:{port}: {e}");
        std::process::exit(1);
    });
    log(&format!("DataSource Hub sidecar (Rust) listening on ws://127.0.0.1:{port}"));
    log("engine: native cache + query (no perspective-server); multi-tenant, SSRM-first");
    log("state: empty — awaiting an app to connect and bootstrap datasource config");

    let mut next_sid = 1u64;
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue; };
        let sid = format!("s{next_sid}");
        next_sid += 1;
        let hub = hub.clone();
        thread::spawn(move || serve_connection(stream, hub, sid));
    }
}

fn serve_connection(stream: std::net::TcpStream, hub: Arc<Mutex<Hub>>, sid: String) {
    let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
    let mut ws = match tungstenite::accept(stream) {
        Ok(ws) => ws,
        Err(_) => return, // not a WebSocket handshake
    };

    let (mut endpoint, open) = Endpoint::new(sid.clone());
    if ws.send(Message::text(open)).is_err() { return; }
    // A read timeout turns the blocking reader into a poll loop: on timeout we
    // re-evaluate alerts and push any that fired, so alerts (and, later, deltas)
    // reach the client without waiting for it to send something.
    let _ = ws.get_ref().set_read_timeout(Some(std::time::Duration::from_millis(40)));
    log(&format!("+ subscriber {sid} ({peer})"));

    'conn: loop {
        match ws.read() {
            Ok(Message::Text(t)) => {
                let frames = {
                    let mut hub = hub.lock().unwrap();
                    endpoint.on_text(&mut hub, t.as_str())
                };
                for f in frames {
                    if ws.send(Message::text(f)).is_err() { eprintln!("[sub {sid}] send failed (reply)"); break 'conn; }
                }
            }
            Ok(Message::Close(_)) => { eprintln!("[sub {sid}] client sent Close"); break; }
            Ok(_) => {} // binary / ping / pong — WebSocket-level, not our protocol
            Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut => {
                // Poll tick: push alerts/deltas/group-deltas; drop the
                // subscriber if it has stopped acking (backpressure).
                for f in endpoint.tick(None) {
                    if ws.send(Message::text(f)).is_err() { eprintln!("[sub {sid}] send failed (push)"); break 'conn; }
                }
                if endpoint.is_closing() { eprintln!("[sub {sid}] backpressure drop lag={}", endpoint.session.flow.lag()); let _ = ws.flush(); break 'conn; }
            }
            Err(e) => { eprintln!("[sub {sid}] read error: {e}"); break; }
        }
    }

    // Teardown: release this session's subscriptions so shared caches with no
    // remaining subscribers are freed.
    {
        let mut hub = hub.lock().unwrap();
        for view_id in endpoint.session.open_views.clone() {
            hub.dispose_view(&view_id);
        }
        for key in endpoint.session.subscriptions.clone() {
            hub.registry.release(&key, &endpoint.session.id);
        }
    }
    log(&format!("- subscriber {sid}"));
}

fn log(m: &str) { println!("[dshub-sidecar-rs] {m}"); }
