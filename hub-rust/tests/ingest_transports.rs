//! Live ingest over STOMP, socket.io, and REST: a mock server for each protocol
//! feeds the real `run_ingestor`, and the row lands in the shared cache.

use dshub::ingest::{run_ingestor, IngestRequest};
use dshub::registry::Datasource;
use dshub::store::{TableCache, Value};
use dshub::socketio::{decode_engine_io, decode_socket_io, encode_event, eio, sio};
use serde_json::{json, Value as Json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tungstenite::Message;

fn run_against(connection: Json, config: Json) -> Arc<Mutex<TableCache>> {
    let cache = Arc::new(Mutex::new(TableCache::new(["positionId", "qty"])));
    let shutdown = Arc::new(AtomicBool::new(false));
    let ds = Datasource {
        id: "p".into(), schema_ref: "p".into(),
        columns: vec!["positionId".into(), "qty".into()],
        key_columns: vec!["positionId".into()], estimated_rows: 0,
        connection, config, checksum: String::new(),
    };
    let req = IngestRequest { datasource: ds, params: json!({}), cache: cache.clone(), shutdown: shutdown.clone() };
    let sd = shutdown.clone();
    thread::spawn(move || { thread::sleep(Duration::from_millis(300)); sd.store(true, Ordering::Relaxed); });
    run_ingestor(req).expect("ran");
    cache
}

#[test]
fn stomp_ingest() {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    thread::spawn(move || {
        if let Ok((s, _)) = l.accept() {
            let mut ws = tungstenite::accept(s).unwrap();
            let _ = ws.read();                              // CONNECT
            let _ = ws.send(Message::text("CONNECTED\nversion:1.2\nheart-beat:0,0\n\n\u{0}"));
            let _ = ws.read();                              // SUBSCRIBE
            let body = json!([{"positionId":"S1","qty":5}]).to_string();
            let _ = ws.send(Message::text(format!("MESSAGE\ndestination:/d\ncontent-length:{}\n\n{}\u{0}", body.len(), body)));
            let _ = ws.close(None);
            while ws.read().is_ok() {}
        }
    });
    let cache = run_against(
        json!({"transport":"stomp","url":format!("ws://127.0.0.1:{port}"),"reconnect":{"initialMs":50}}),
        json!({"keyColumns":["positionId"],"updates":{"destination":"/d","bodyShape":"record-array"}}),
    );
    assert_eq!(cache.lock().unwrap().get("S1", "qty"), Some(&Value::Int(5)), "STOMP MESSAGE ingested");
}

#[test]
fn socketio_ingest() {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    thread::spawn(move || {
        if let Ok((s, _)) = l.accept() {
            let mut ws = tungstenite::accept(s).unwrap();
            let _ = ws.send(Message::text(dshub::socketio::encode_open("srv"))); // Engine.IO OPEN
            let _ = ws.read();                                                    // namespace CONNECT ("40")
            let _ = ws.send(Message::text(format!("{}{}", eio::MESSAGE, sio::CONNECT))); // CONNECT ack
            let _ = ws.read();                                                    // subscribe event
            let _ = ws.send(Message::text(encode_event("rows", &json!([{"positionId":"IO1","qty":7}]), "/")));
            let _ = ws.close(None);
            while ws.read().is_ok() {}
        }
    });
    let cache = run_against(
        json!({"transport":"socketio","url":format!("ws://127.0.0.1:{port}/socket.io"),"reconnect":{"initialMs":50}}),
        json!({"keyColumns":["positionId"],"updates":{"destination":"rows","bodyShape":"record-array"}}),
    );
    assert_eq!(cache.lock().unwrap().get("IO1", "qty"), Some(&Value::Int(7)), "socket.io EVENT ingested");
}

#[test]
fn rest_ingest() {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    thread::spawn(move || {
        if let Ok((mut s, _)) = l.accept() {
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);                       // the GET request
            let body = json!([{"positionId":"RE1","qty":9}]).to_string();
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}");
            let _ = s.write_all(resp.as_bytes());
            // drop closes the connection → client's read_to_end returns
        }
    });
    let cache = run_against(
        json!({"transport":"rest","url":format!("http://127.0.0.1:{port}/snapshot"),"reconnect":{"initialMs":50}}),
        json!({"keyColumns":["positionId"]}),
    );
    assert_eq!(cache.lock().unwrap().get("RE1", "qty"), Some(&Value::Int(9)), "REST snapshot ingested");
}

// Keep the socketio decode imports referenced (used by the mock only via helpers).
#[allow(dead_code)]
fn _touch() { let _ = (decode_engine_io, decode_socket_io); }
