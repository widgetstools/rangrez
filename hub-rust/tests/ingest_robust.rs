//! Ingest robustness: an ingestor stops when its datasource is released, and
//! fails over to the next endpoint when the first is unreachable.

use dshub::ingest::{run_ingestor, IngestRequest};
use dshub::registry::Datasource;
use dshub::store::{TableCache, Value};
use serde_json::{json, Value as Json};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tungstenite::Message;

/// One-shot feed: accept a client, send one row, close.
fn feed_once(row: Json) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    thread::spawn(move || {
        if let Ok((s, _)) = l.accept() {
            let mut ws = tungstenite::accept(s).unwrap();
            // Send immediately on connect (this feed sends no subscribe handshake).
            let _ = ws.send(Message::text(json!([row]).to_string()));
            let _ = ws.close(None);
            while ws.read().is_ok() {}
        }
    });
    port
}

/// A port with nothing listening → connections are refused fast.
fn dead_port() -> u16 { let l = TcpListener::bind("127.0.0.1:0").unwrap(); let p = l.local_addr().unwrap().port(); drop(l); p }

fn ds(connection: Json) -> Datasource {
    Datasource {
        id: "p".into(), schema_ref: "p".into(),
        columns: vec!["positionId".into(), "qty".into()],
        key_columns: vec!["positionId".into()], estimated_rows: 0,
        connection, config: json!({"keyColumns":["positionId"],"updates":{"bodyShape":"record-array"}}),
        checksum: String::new(),
    }
}

#[test]
fn shutdown_flag_stops_the_ingestor() {
    let port = feed_once(json!({"positionId":"A","qty":1}));
    let cache = Arc::new(Mutex::new(TableCache::new(["positionId", "qty"])));
    let shutdown = Arc::new(AtomicBool::new(false));
    let req = IngestRequest {
        datasource: ds(json!({"url": format!("ws://127.0.0.1:{port}"), "reconnect": {"initialMs": 50}})),
        params: json!({}), cache: cache.clone(), shutdown: shutdown.clone(),
    };
    // Stop it shortly after it has connected and ingested.
    let sd = shutdown.clone();
    thread::spawn(move || { thread::sleep(Duration::from_millis(250)); sd.store(true, Ordering::Relaxed); });

    let h = thread::spawn(move || run_ingestor(req));
    h.join().unwrap().expect("ingestor returned cleanly on shutdown");   // would hang if shutdown were ignored
    assert_eq!(cache.lock().unwrap().get("A", "qty"), Some(&Value::Int(1)), "data ingested before shutdown");
}

#[test]
fn failover_moves_to_the_next_endpoint() {
    let dead = dead_port();
    let good = feed_once(json!({"positionId":"B","qty":2}));
    let cache = Arc::new(Mutex::new(TableCache::new(["positionId", "qty"])));
    let shutdown = Arc::new(AtomicBool::new(false));
    let req = IngestRequest {
        datasource: ds(json!({
            "url": format!("ws://127.0.0.1:{dead}"),
            "failover": [format!("ws://127.0.0.1:{good}")],
            "reconnect": {"initialMs": 30}
        })),
        params: json!({}), cache: cache.clone(), shutdown: shutdown.clone(),
    };
    let sd = shutdown.clone();
    thread::spawn(move || { thread::sleep(Duration::from_millis(400)); sd.store(true, Ordering::Relaxed); });

    run_ingestor(req).expect("ran");
    assert_eq!(cache.lock().unwrap().get("B", "qty"), Some(&Value::Int(2)), "failed over to the good endpoint and ingested");
}
