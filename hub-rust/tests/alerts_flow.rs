//! Alerts through the control/transport stack: subscribe to a predicate over the
//! full table, fire for existing matches immediately, fire on transition as the
//! cache changes (the poll tick), and stop on unsubscribe.

use dshub::hub::Hub;
use dshub::registry::Datasource;
use dshub::server::Endpoint;
use dshub::socketio::{decode_engine_io, decode_socket_io, encode_event};
use serde_json::{json, Value as Json};

fn pnl_hub() -> Hub {
    Hub::new([Datasource {
        id: "positions".into(), schema_ref: "positions@v1".into(),
        columns: vec!["positionId".into(), "desk".into(), "pnl".into()],
        key_columns: vec!["positionId".into()], estimated_rows: 100,
        ..Default::default()
    }], 1, "sha256:x")
}
fn ev(msg: Json) -> String { encode_event("msg", &msg, "/") }
fn msgs(frames: &[String]) -> Vec<Json> {
    frames.iter().map(|f| {
        let e = decode_engine_io(f);
        decode_socket_io(&e.payload).data.unwrap().as_array().unwrap()[1].clone()
    }).collect()
}
const REF: fn() -> Json = || json!({ "datasourceId": "positions", "params": { "clientId": "t1" } });

fn feed(hub: &Hub, rows: &[(&str, i64)]) {
    let cache = hub.registry.cache_for("positions", &json!({"clientId":"t1"})).unwrap();
    let mut c = cache.lock().unwrap();
    for (k, pnl) in rows {
        c.upsert(k, json!({"positionId":k,"desk":"Govies","pnl":pnl}).as_object().unwrap());
    }
}

#[test]
fn alerts_fire_over_the_full_table_and_on_transition() {
    let mut hub = pnl_hub();
    let (mut ep, _open) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"h","type":"hello","appId":"a","protocolVersion":1})));
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));

    // Two breaches already in the book, plus a healthy row.
    feed(&hub, &[("P1", -600_000), ("P2", 100), ("P3", -700_000)]);

    // Subscribe to the alert: fires immediately for the existing breaches.
    let frames = ep.on_text(&mut hub, &ev(json!({
        "id":"a","type":"alertSubscribe","ref":REF(),"ruleId":"pnl-blowup","predicate":"pnl < -500000"
    })));
    let out = msgs(&frames);
    let ack = &out[0];
    assert_eq!(ack["type"], "result");
    assert_eq!(ack["payload"]["watching"], true);
    assert_eq!(ack["payload"]["activeCount"], 2);
    let fired: Vec<_> = out[1..].iter().filter(|m| m["type"] == "alert").collect();
    assert_eq!(fired.len(), 2, "both existing breaches fired");
    let mut keys: Vec<_> = fired.iter().map(|m| m["row"]["__key"].as_str().unwrap()).collect();
    keys.sort();
    assert_eq!(keys, ["P1", "P3"]);

    // A poll tick with no change fires nothing (breaches that STAY are silent).
    assert!(ep.tick(None).is_empty(), "no repeat alerts while rows stay over the line");

    // A new breach deep in the book crosses the line → the tick fires it.
    feed(&hub, &[("P4", -800_000)]);
    let t = msgs(&ep.tick(None));
    assert_eq!(t.len(), 1);
    assert_eq!(t[0]["row"]["__key"], "P4");

    // P1 recovers → it clears (no alert message), and stops counting.
    feed(&hub, &[("P1", 100)]);
    assert!(ep.tick(None).is_empty(), "recovery clears silently, no alert");

    // Unsubscribe stops it.
    let u = msgs(&ep.on_text(&mut hub, &ev(json!({"id":"u","type":"alertUnsubscribe","ruleId":"pnl-blowup"}))));
    assert_eq!(u[0]["payload"]["watching"], false);
    feed(&hub, &[("P5", -900_000)]);
    assert!(ep.tick(None).is_empty(), "no alerts after unsubscribe");
}

#[test]
fn a_bad_predicate_is_refused_not_registered() {
    let mut hub = pnl_hub();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    let out = msgs(&ep.on_text(&mut hub, &ev(json!({
        "id":"a","type":"alertSubscribe","ref":REF(),"ruleId":"bad","predicate":"pnl <"
    }))));
    assert_eq!(out[0]["type"], "error");
    assert_eq!(out[0]["code"], "invalid-predicate");
}
