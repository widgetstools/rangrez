//! Live ingest: a mock upstream WebSocket feed, the real `Ingestor` connecting
//! to it, and the shared cache filling with normalized rows. Proves the socket
//! path end to end — connect, subscribe, apply snapshot + updates + a delete.

use dshub::ingest::{run_ingestor, IngestRequest};
use dshub::registry::Datasource;
use dshub::store::{TableCache, Value};
use serde_json::{json, Value as Json};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use tungstenite::Message;

/// A one-shot upstream feed: accept a client, push messages, close.
fn mock_feed() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        if let Ok((stream, _)) = listener.accept() {
            let mut ws = tungstenite::accept(stream).unwrap();
            // The client sends a subscribe frame first; drain it.
            let _ = ws.read();
            // Snapshot (record-array), then a partial update, then a delete.
            let msgs = [
                json!([{"positionId":"A","desk":"Govies","qty":10},
                       {"positionId":"B","desk":"EM","qty":20}]),
                json!([{"positionId":"A","qty":15}]),
                json!([{"positionId":"B","action":"D"}]),
            ];
            for m in msgs {
                let _ = ws.send(Message::text(m.to_string()));
            }
            let _ = ws.close(None);
            while ws.read().is_ok() {} // complete the close handshake
        }
    });
    port
}

#[test]
fn ingestor_connects_and_fills_the_cache() {
    let port = mock_feed();
    let datasource = Datasource {
        id: "positions".into(),
        schema_ref: "positions@v1".into(),
        columns: vec!["positionId".into(), "desk".into(), "qty".into()],
        key_columns: vec!["positionId".into()],
        estimated_rows: 0,
        connection: json!({ "transport": "websocket", "url": format!("ws://127.0.0.1:{port}") }),
        config: json!({
            "keyColumns": ["positionId"],
            "updates": { "destination": "positions.delta", "bodyShape": "record-array" },
            "opField": { "path": "action", "map": { "D": "delete" } }
        }),
        checksum: String::new(),
    };

    let cache = Arc::new(Mutex::new(TableCache::new(["positionId", "desk", "qty"])));
    let req = IngestRequest { datasource, params: json!({}), cache: cache.clone(), shutdown: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)) };

    // Runs until the feed closes, then returns.
    let h = thread::spawn(move || run_ingestor(req));
    h.join().unwrap().expect("ingest ran clean");

    let c = cache.lock().unwrap();
    assert_eq!(c.len(), 1, "A remains (updated), B was deleted");
    assert_eq!(c.get("A", "qty"), Some(&Value::Int(15)), "the partial update applied");
    assert_eq!(c.get("A", "desk"), Some(&Value::Str("Govies".into())), "snapshot field survived the partial update");
    assert!(c.get("B", "qty").is_none(), "the delete removed B");
}

/// A second column-name shape: the feed url carries a param placeholder.
#[test]
fn ingestor_substitutes_url_params() {
    use dshub::ingest::substitute;
    let url = substitute("ws://host/{clientId}/feed", &json!({"clientId":"desk7"}));
    assert_eq!(url, "ws://host/desk7/feed");
}
