//! Backpressure: a streaming subscriber that never acks is dropped once its lag
//! passes the flow limit, with a typed reason — never left silently stale.

use dshub::hub::Hub;
use dshub::registry::Datasource;
use dshub::server::Endpoint;
use dshub::socketio::{decode_engine_io, decode_socket_io, encode_event};
use serde_json::{json, Value as Json};

fn hub() -> Hub {
    Hub::new([Datasource {
        id: "positions".into(), schema_ref: "p".into(),
        columns: vec!["positionId".into(), "qty".into()],
        key_columns: vec!["positionId".into()], estimated_rows: 100,
        config: serde_json::json!({"conflation":{"defaultIntervalMs":0}}), ..Default::default()
    }], 1, "x")
}
fn ev(m: Json) -> String { encode_event("msg", &m, "/") }
fn msgs(frames: &[String]) -> Vec<Json> {
    frames.iter().map(|f| decode_socket_io(&decode_engine_io(f).payload).data.unwrap().as_array().unwrap()[1].clone()).collect()
}
const REF: fn() -> Json = || json!({ "datasourceId": "positions", "params": { "clientId": "t1" } });

#[test]
fn a_non_acking_subscriber_is_dropped_with_a_reason() {
    let mut hub = hub();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF(),"delivery":"rows"})));
    ep.session.flow.limit = 3; // tiny limit for the test

    let cache = hub.registry.cache_for("positions", &json!({"clientId":"t1"})).unwrap();
    let mut closed = false;
    for i in 0..5 {
        cache.lock().unwrap().upsert(&format!("P{i}"), json!({"positionId":format!("P{i}"),"qty":i}).as_object().unwrap());
        let out = msgs(&ep.tick(None));
        // Each tracked push carries a seq; the client never acks.
        assert!(out.iter().filter(|m| m["type"] != "error").all(|m| m.get("seq").is_some()), "pushes are seq-stamped");
        if ep.is_closing() {
            assert!(out.iter().any(|m| m["code"] == "backpressure-disconnect"), "dropped with a reason");
            closed = true;
            break;
        }
    }
    assert!(closed, "the silent subscriber was dropped once its lag passed the limit");
}

#[test]
fn an_acking_subscriber_is_never_dropped() {
    let mut hub = hub();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF(),"delivery":"rows"})));
    ep.session.flow.limit = 3;

    let cache = hub.registry.cache_for("positions", &json!({"clientId":"t1"})).unwrap();
    for i in 0..20 {
        cache.lock().unwrap().upsert(&format!("P{i}"), json!({"positionId":format!("P{i}"),"qty":i}).as_object().unwrap());
        let out = msgs(&ep.tick(None));
        // Ack the highest seq we received.
        if let Some(seq) = out.iter().filter_map(|m| m.get("seq").and_then(Json::as_u64)).max() {
            ep.on_text(&mut hub, &ev(json!({"type":"ack","seq":seq})));
        }
        assert!(!ep.is_closing(), "a keeping-up subscriber is never dropped");
    }
}
