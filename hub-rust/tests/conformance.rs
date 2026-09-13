//! Socket.io conformance for the Rust hub — the SAME control exchange the JS
//! sidecar conformance test drives (`sidecar.conformance.test.mjs`), now against
//! the native hub through its socket.io endpoint.
//!
//! Frames are built and decoded with the crate's own codec (the byte-parity of
//! which vs the JS client is proven in socketio.rs), so passing this exchange
//! means the browser `socketIoPort` client — which speaks that same framing —
//! would drive the Rust hub identically.

use dshub::hub::Hub;
use dshub::registry::Datasource;
use dshub::server::Endpoint;
use dshub::socketio::{decode_engine_io, decode_socket_io, encode_event};
use serde_json::{json, Value as Json};

fn positions_hub() -> Hub {
    Hub::new(
        [Datasource {
            id: "positions".into(),
            schema_ref: "positions@v1".into(),
            columns: vec!["positionId".into(), "desk".into(), "qty".into()],
            key_columns: vec!["positionId".into()],
            estimated_rows: 100,
            ..Default::default()
        }],
        7, "sha256:rust",
    )
}

/// Build the client frame for a control message.
fn ev(msg: Json) -> String { encode_event("msg", &msg, "/") }

/// Decode the control message carried by the first reply frame.
fn reply(frames: &[String]) -> Json {
    assert!(!frames.is_empty(), "expected a reply frame");
    let eng = decode_engine_io(&frames[0]);
    let sio = decode_socket_io(&eng.payload);
    let arr = sio.data.expect("event has data");
    arr.as_array().unwrap()[1].clone()
}

const REF: fn() -> Json = || json!({ "datasourceId": "positions", "params": { "clientId": "t1" } });

fn connect(ep: &mut Endpoint, hub: &mut Hub) {
    // Client joins the namespace; server acks with "40".
    let acks = ep.on_text(hub, "40");
    assert_eq!(acks, vec!["40".to_string()], "namespace CONNECT is acked");
    assert!(ep.is_connected());
}

#[test]
fn full_exchange_over_the_endpoint() {
    let mut hub = positions_hub();
    let (mut ep, open) = Endpoint::new("s1");
    assert!(open.starts_with("0{\"sid\""), "OPEN handshake sent first: {open}");
    connect(&mut ep, &mut hub);

    // hello -> configAck, carrying the hub's real bundle version.
    let ack = reply(&ep.on_text(&mut hub, &ev(json!({"id":"1","type":"hello","appId":"rs","protocolVersion":1}))));
    assert_eq!(ack["type"], "configAck");
    assert_eq!(ack["bundleVersion"], 7);

    // subscribe -> subscribed (creates the shared cache).
    let sub = reply(&ep.on_text(&mut hub, &ev(json!({"id":"2","type":"subscribe","ref":REF()}))));
    assert_eq!(sub["type"], "subscribed");
    assert_eq!(sub["schemaRef"], "positions@v1");

    // Feed rows into the shared cache — standing in for the upstream adapter.
    {
        let cache = hub.registry.cache_for("positions", &json!({"clientId":"t1"})).unwrap();
        let mut c = cache.lock().unwrap();
        for (k, q) in [("A", 10), ("B", 20), ("C", 5)] {
            c.upsert(k, json!({"positionId":k,"desk":"Govies","qty":q}).as_object().unwrap());
        }
    }

    // rowCount over the socket.
    let rc = reply(&ep.on_text(&mut hub, &ev(json!({"id":"3","type":"rowCount","ref":REF(),"view":{"filter":[]}}))));
    assert_eq!(rc["payload"], 3);

    // Filtered rowCount.
    let rcf = reply(&ep.on_text(&mut hub, &ev(json!({"id":"4","type":"rowCount","ref":REF(),
        "view":{"filter":[{"column":"qty","op":"greaterThan","value":8}]}}))));
    assert_eq!(rcf["payload"], 2, "qty>8 matches A and B");

    // aggregates over the socket.
    let agg = reply(&ep.on_text(&mut hub, &ev(json!({"id":"5","type":"aggregates","ref":REF(),
        "specs":[{"column":"qty","fn":"sum","as":"sumq"},{"column":"qty","fn":"count","as":"n"}],"view":{"filter":[]}}))));
    assert_eq!(agg["payload"]["sumq"], 35.0);
    assert_eq!(agg["payload"]["n"], 3);
}

#[test]
fn malformed_and_mismatch_are_rejected_identically() {
    let mut hub = positions_hub();
    let (mut ep, _open) = Endpoint::new("s1");
    connect(&mut ep, &mut hub);

    // subscribe with no ref.
    let bad = reply(&ep.on_text(&mut hub, &ev(json!({"id":"1","type":"subscribe"}))));
    assert_eq!(bad["type"], "error");
    let m = bad["message"].as_str().unwrap().to_lowercase();
    assert!(m.contains("ref") || m.contains("malformed"), "message: {m}");

    // protocol mismatch.
    let mm = reply(&ep.on_text(&mut hub, &ev(json!({"id":"2","type":"hello","appId":"x","protocolVersion":99}))));
    assert_eq!(mm["type"], "error");
    assert!(mm["message"].as_str().unwrap().to_lowercase().contains("protocol"));
    assert_eq!(mm["code"], "protocol-version-mismatch");
}

#[test]
fn two_subscribers_share_one_cache() {
    let mut hub = positions_hub();
    let (mut a, _) = Endpoint::new("s1");
    let (mut b, _) = Endpoint::new("s2");
    connect(&mut a, &mut hub);
    connect(&mut b, &mut hub);

    a.on_text(&mut hub, &ev(json!({"id":"1","type":"subscribe","ref":REF()})));
    b.on_text(&mut hub, &ev(json!({"id":"1","type":"subscribe","ref":REF()})));

    // One upstream, two subscribers — ONE shared cache. The whole point.
    assert_eq!(hub.registry.entry_count(), 1, "two subscribers collapse to one cache");
    let entry = hub.registry.entry(&dshub::registry::Registry::cache_key("positions", &json!({"clientId":"t1"}))).unwrap();
    assert_eq!(entry.subscribers.len(), 2);
}

#[test]
fn last_subscriber_leaving_frees_the_cache() {
    let mut hub = positions_hub();
    let (mut a, _) = Endpoint::new("s1");
    connect(&mut a, &mut hub);
    a.on_text(&mut hub, &ev(json!({"id":"1","type":"subscribe","ref":REF()})));
    assert_eq!(hub.registry.entry_count(), 1);
    a.on_text(&mut hub, &ev(json!({"id":"2","type":"unsubscribe","ref":REF()})));
    assert_eq!(hub.registry.entry_count(), 0, "the shared cache is released with its last subscriber");
}

// ───────────────────── verb audit: refuse, do not degrade ─────────────────
//
// `watchGroups` turned out to have four defects, every one of which rendered a
// plausible wrong answer rather than an error. These pin the same class in the
// verbs that were never examined. A blotter cannot tell a wrong number from a
// right one, so the engine has to.

fn ready() -> (Hub, Endpoint) {
    let mut hub = positions_hub();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe",
        "ref":{"datasourceId":"positions","params":{}}})));
    let c = hub.registry.cache_for("positions", &json!({})).unwrap();
    {
        let mut c = c.lock().unwrap();
        for (k, d, q) in [("A", "Govies", 10), ("B", "Govies", 20), ("C", "EM", 5)] {
            c.upsert(k, json!({"positionId":k,"desk":d,"qty":q}).as_object().unwrap());
        }
    }
    (hub, ep)
}

fn ask(ep: &mut Endpoint, hub: &mut Hub, msg: Json) -> Json {
    let frames = ep.on_text(hub, &ev(msg));
    decode_socket_io(&decode_engine_io(&frames[0]).payload)
        .data.unwrap().as_array().unwrap()[1].clone()
}

#[test]
fn distinct_values_over_an_unknown_column_is_refused() {
    // `group_slots` answers an empty list for a column it cannot resolve, which
    // is byte-identical to a column that genuinely has no values. A filter
    // dropdown then shows nothing and the desk concludes the data is empty.
    let (mut hub, mut ep) = ready();
    let r = ask(&mut ep, &mut hub, json!({"id":"d","type":"distinctValues",
        "ref":{"datasourceId":"positions","params":{}}, "colId":"trader"}));
    assert_eq!(r["type"], "error", "{r}");
    assert!(r["message"].as_str().unwrap().contains("trader"), "{r}");
}

#[test]
fn distinct_values_over_a_real_column_still_works() {
    let (mut hub, mut ep) = ready();
    let r = ask(&mut ep, &mut hub, json!({"id":"d","type":"distinctValues",
        "ref":{"datasourceId":"positions","params":{}}, "colId":"desk"}));
    assert_eq!(r["type"], "result", "{r}");
    let vals = r["payload"].as_array().unwrap();
    assert_eq!(vals.len(), 2, "Govies and EM");
}

#[test]
fn search_values_inherits_the_refusal() {
    let (mut hub, mut ep) = ready();
    let r = ask(&mut ep, &mut hub, json!({"id":"v","type":"searchValues",
        "ref":{"datasourceId":"positions","params":{}}, "colId":"trader", "prefix":"a"}));
    assert_eq!(r["type"], "error", "{r}");
}

#[test]
fn an_aggregate_over_an_unknown_column_is_refused() {
    // The third caller of `aggregate_over`, and the one the first pass missed.
    let (mut hub, mut ep) = ready();
    let r = ask(&mut ep, &mut hub, json!({"id":"a","type":"aggregates",
        "ref":{"datasourceId":"positions","params":{}},
        "specs":[{"column":"notional","fn":"sum"}]}));
    assert_eq!(r["type"], "error", "{r}");
    assert!(r["message"].as_str().unwrap().contains("notional"), "{r}");
}

#[test]
fn a_real_aggregate_still_answers() {
    let (mut hub, mut ep) = ready();
    let r = ask(&mut ep, &mut hub, json!({"id":"a","type":"aggregates",
        "ref":{"datasourceId":"positions","params":{}},
        "specs":[{"column":"qty","fn":"sum"}]}));
    assert_eq!(r["type"], "result", "{r}");
    // The output name defaults to `fn(column)` when no `as` is given.
    assert_eq!(r["payload"]["sum(qty)"], 35.0);
}

#[test]
fn an_unknown_aggregate_function_is_refused() {
    // It used to be filter_map'd away, so the result object came back missing a
    // key — which reads as "that number is unavailable", not "you typed the
    // function name wrong".
    let (mut hub, mut ep) = ready();
    let r = ask(&mut ep, &mut hub, json!({"id":"a","type":"aggregates",
        "ref":{"datasourceId":"positions","params":{}},
        "specs":[{"column":"qty","fn":"tolal"}]}));
    assert_eq!(r["type"], "error", "{r}");
    assert!(r["message"].as_str().unwrap().contains("tolal"), "{r}");
}

#[test]
fn resubscribing_an_alert_replaces_it_rather_than_stacking() {
    // The `watchGroups` bug, in the verb next door. A client re-registers
    // whenever its rule is edited; every stacked copy scans the whole table on
    // each tick and fires its own duplicate.
    let (mut hub, mut ep) = ready();
    let rule = json!({"id":"r","type":"alertSubscribe",
        "ref":{"datasourceId":"positions","params":{}},
        "ruleId":"wide","predicate":"qty > 5"});
    for _ in 0..4 { ask(&mut ep, &mut hub, rule.clone()); }
    assert_eq!(ep.session.alerts.len(), 1, "four registrations, one watch");
}

#[test]
fn two_different_alert_rules_both_survive() {
    // The replacement is scoped to the rule, not to the session.
    let (mut hub, mut ep) = ready();
    ask(&mut ep, &mut hub, json!({"id":"r1","type":"alertSubscribe",
        "ref":{"datasourceId":"positions","params":{}},
        "ruleId":"wide","predicate":"qty > 5"}));
    ask(&mut ep, &mut hub, json!({"id":"r2","type":"alertSubscribe",
        "ref":{"datasourceId":"positions","params":{}},
        "ruleId":"tight","predicate":"qty < 5"}));
    assert_eq!(ep.session.alerts.len(), 2);
}

#[test]
fn an_alert_without_a_rule_id_is_refused() {
    // It used to default to "rule", so two unnamed rules shared one identity:
    // unsubscribing either killed both.
    let (mut hub, mut ep) = ready();
    let r = ask(&mut ep, &mut hub, json!({"id":"r","type":"alertSubscribe",
        "ref":{"datasourceId":"positions","params":{}}, "predicate":"qty > 5"}));
    assert_eq!(r["type"], "error", "{r}");
    assert!(r["message"].as_str().unwrap().contains("ruleId"), "{r}");
}

#[test]
fn a_hot_reload_reports_the_config_it_could_not_parse() {
    // Dropping it silently left the OLD datasource running and reported
    // success, so a fix a desk was waiting on simply never arrived.
    let (mut hub, mut ep) = ready();
    let r = ask(&mut ep, &mut hub, json!({"id":"p","type":"pushConfig","bundle":{
        "bundleVersion": 9,
        "datasources": [
            {"id":"positions","schemaRef":"positions@v1","columns":["positionId","desk","qty","trader"]},
            {"id":"broken"}
        ]}}));
    assert_eq!(r["type"], "configApplied", "{r}");
    let out = r["datasources"].as_array().unwrap();
    let broken = out.iter().find(|d| d["id"] == "broken").expect("the bad entry is reported");
    assert_eq!(broken["status"], "invalid");
    assert!(out.iter().any(|d| d["id"] == "positions" && d.get("reload").is_some()));
}

