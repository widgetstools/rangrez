//! Group-aggregate deltas: subscribe to a grouped view, get the initial group
//! aggregates, then on a leaf tick get ONLY the group whose aggregate moved.

use dshub::hub::Hub;
use dshub::registry::Datasource;
use dshub::server::Endpoint;
use dshub::socketio::{decode_engine_io, decode_socket_io, encode_event};
use serde_json::{json, Value as Json};

fn hub() -> Hub {
    Hub::new([Datasource {
        id: "positions".into(), schema_ref: "p".into(),
        columns: vec!["positionId".into(), "desk".into(), "qty".into()],
        key_columns: vec!["positionId".into()], estimated_rows: 100,
        config: serde_json::json!({"conflation":{"defaultIntervalMs":0}}), ..Default::default()
    }], 1, "x")
}
fn ev(m: Json) -> String { encode_event("msg", &m, "/") }
fn msgs(frames: &[String]) -> Vec<Json> {
    frames.iter().map(|f| decode_socket_io(&decode_engine_io(f).payload).data.unwrap().as_array().unwrap()[1].clone()).collect()
}
fn reply(frames: &[String]) -> Json { msgs(frames).remove(0) }
const REF: fn() -> Json = || json!({ "datasourceId": "positions", "params": { "clientId": "t1" } });
fn feed(hub: &Hub, rows: &[(&str, &str, i64)]) {
    let c = hub.registry.cache_for("positions", &json!({"clientId":"t1"})).unwrap();
    let mut c = c.lock().unwrap();
    for (k, d, q) in rows { c.upsert(k, json!({"positionId":k,"desk":d,"qty":q}).as_object().unwrap()); }
}

#[test]
fn only_the_moved_group_is_pushed() {
    let mut hub = hub();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    feed(&hub, &[("A", "Govies", 10), ("B", "Govies", 20), ("C", "EM", 5)]);

    // Watch group sums by desk; the reply comes with the initial groups pushed.
    let frames = ep.on_text(&mut hub, &ev(json!({
        "id":"g","type":"watchGroups","ref":REF(),"groupBy":["desk"],"aggregates":{"qty":"sum"}
    })));
    let out = msgs(&frames);
    assert_eq!(out[0]["payload"]["watching"], true);
    assert_eq!(out[0]["payload"]["groupCount"], 2);
    let initial: Vec<_> = out[1..].iter().filter(|m| m["type"] == "groupDelta").collect();
    assert_eq!(initial.len(), 1, "one initial groupDelta with all groups");
    assert_eq!(initial[0]["groups"].as_array().unwrap().len(), 2);

    // No change → no push.
    assert!(ep.tick(None).is_empty(), "quiescent: nothing pushed");

    // A leaf tick in Govies → ONLY the Govies group aggregate is pushed.
    feed(&hub, &[("A", "Govies", 100)]);
    let t = msgs(&ep.tick(None));
    assert_eq!(t.len(), 1);
    assert_eq!(t[0]["type"], "groupDelta");
    let groups = t[0]["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 1, "only the moved group");
    assert_eq!(groups[0]["path"], json!(["sGovies"]));
    assert_eq!(groups[0]["aggregates"]["qty"], 120.0); // 100 + 20

    // A new desk appears → its group is pushed as changed.
    feed(&hub, &[("D", "HY", 7)]);
    let t2 = msgs(&ep.tick(None));
    let g2 = t2[0]["groups"].as_array().unwrap();
    assert_eq!(g2.len(), 1);
    assert_eq!(g2[0]["path"], json!(["sHY"]));
}
