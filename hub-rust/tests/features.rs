//! The remaining hub features, exercised through the control/transport stack:
//! SSRM view model, live row deltas, the write path, distinct/search/rank,
//! stats, and hot reload.

use dshub::hub::Hub;
use dshub::registry::Datasource;
use dshub::server::Endpoint;
use dshub::socketio::{decode_engine_io, decode_socket_io, encode_event};
use serde_json::{json, Value as Json};

fn hub() -> Hub {
    Hub::new([Datasource {
        id: "positions".into(), schema_ref: "positions@v1".into(),
        columns: vec!["positionId".into(), "desk".into(), "qty".into(), "note".into()],
        key_columns: vec!["positionId".into()], estimated_rows: 100,
        config: serde_json::json!({"conflation":{"defaultIntervalMs":0}}), ..Default::default()
    }], 1, "sha256:x")
}
fn ev(msg: Json) -> String { encode_event("msg", &msg, "/") }
fn msgs(frames: &[String]) -> Vec<Json> {
    frames.iter().map(|f| decode_socket_io(&decode_engine_io(f).payload).data.unwrap().as_array().unwrap()[1].clone()).collect()
}
fn reply(frames: &[String]) -> Json { msgs(frames).remove(0) }
const REF: fn() -> Json = || json!({ "datasourceId": "positions", "params": { "clientId": "t1" } });

fn setup() -> (Hub, Endpoint) {
    let mut hub = hub();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"h","type":"hello","appId":"a","protocolVersion":1})));
    (hub, ep)
}
fn feed(hub: &Hub, rows: &[(&str, &str, i64)]) {
    let cache = hub.registry.cache_for("positions", &json!({"clientId":"t1"})).unwrap();
    let mut c = cache.lock().unwrap();
    for (k, desk, qty) in rows {
        c.upsert(k, json!({"positionId":k,"desk":desk,"qty":qty}).as_object().unwrap());
    }
}

#[test]
fn ssrm_view_group_read_expand() {
    let (mut hub, mut ep) = setup();
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    feed(&hub, &[("A", "Govies", 10), ("B", "Govies", 20), ("C", "EM", 5)]);

    let ov = reply(&ep.on_text(&mut hub, &ev(json!({
        "id":"o","type":"openView","ref":REF(),
        "view":{"groupBy":["desk"],"aggregates":{"qty":"sum"}}
    }))));
    let view_id = ov["payload"]["viewId"].as_str().unwrap().to_string();

    // Collapsed: two group rows, sorted by desk (EM, Govies), with summed qty.
    let w = reply(&ep.on_text(&mut hub, &ev(json!({"id":"w","type":"readWindow","viewId":view_id}))));
    let rows = w["payload"]["rows"].as_array().unwrap();
    assert_eq!(w["payload"]["rowCount"], 2);
    assert_eq!(rows[0]["__group"], true);
    assert_eq!(rows[0]["desk"], "EM");
    assert_eq!(rows[0]["qty"], 5.0);
    assert_eq!(rows[1]["desk"], "Govies");
    assert_eq!(rows[1]["qty"], 30.0);
    assert_eq!(rows[1]["__count"], 2);

    // Expand Govies (index 1) → its two leaves appear.
    let ex = reply(&ep.on_text(&mut hub, &ev(json!({"id":"e","type":"expandRow","viewId":view_id,"index":1}))));
    assert_eq!(ex["payload"]["rowCount"], 4);
    let w2 = reply(&ep.on_text(&mut hub, &ev(json!({"id":"w2","type":"readWindow","viewId":view_id}))));
    let rows2 = w2["payload"]["rows"].as_array().unwrap();
    assert_eq!(rows2.len(), 4);
    assert!(rows2[2].get("__group").is_none(), "row 2 is a leaf");
    assert_eq!(rows2[2]["desk"], "Govies");

    let d = reply(&ep.on_text(&mut hub, &ev(json!({"id":"d","type":"disposeView","viewId":view_id}))));
    assert_eq!(d["payload"]["disposed"], true);
}

#[test]
fn live_row_deltas_stream_upserts_and_removals() {
    let (mut hub, mut ep) = setup();
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF(),"delivery":"rows"})));

    // First tick after feeding = the snapshot (all current rows as upserts).
    feed(&hub, &[("A", "Govies", 10), ("B", "EM", 20)]);
    let t1 = msgs(&ep.tick(None));
    assert_eq!(t1.len(), 1);
    assert_eq!(t1[0]["type"], "rowDelta");
    assert_eq!(t1[0]["upserts"].as_array().unwrap().len(), 2, "snapshot: both rows");

    // A change → only the changed row.
    feed(&hub, &[("A", "Govies", 15)]);
    let t2 = msgs(&ep.tick(None));
    assert_eq!(t2[0]["upserts"].as_array().unwrap().len(), 1);
    assert_eq!(t2[0]["upserts"][0]["__key"], "A");
    assert_eq!(t2[0]["upserts"][0]["qty"], 15);

    // A delete → a removal, no upsert.
    { let c = hub.registry.cache_for("positions", &json!({"clientId":"t1"})).unwrap(); c.lock().unwrap().delete("B"); }
    let t3 = msgs(&ep.tick(None));
    assert_eq!(t3[0]["removals"].as_array().unwrap(), &vec![json!("B")]);

    // Quiescent → nothing pushed.
    assert!(ep.tick(None).is_empty(), "no delta when nothing changed");
}

#[test]
fn write_path_applies_dedups_and_rejects() {
    let (mut hub, mut ep) = setup();
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    feed(&hub, &[("A", "Govies", 10)]);

    let cmd = json!({"id":"c","type":"command","ref":REF(),"idempotencyKey":"w1","verb":"edit","payload":{"key":"A","field":"note","value":"watch"}});
    let r1 = reply(&ep.on_text(&mut hub, &ev(cmd.clone())));
    assert_eq!(r1["type"], "commandResult");
    assert_eq!(r1["outcome"], "applied");
    assert_eq!(hub.registry.cache_for("positions", &json!({"clientId":"t1"})).unwrap().lock().unwrap().get("A", "note"), Some(&dshub::store::Value::Str("watch".into())));

    // Same key again → duplicate (retry-safe).
    assert_eq!(reply(&ep.on_text(&mut hub, &ev(cmd)))["outcome"], "duplicate");

    // Missing field → rejected with a reason.
    let bad = reply(&ep.on_text(&mut hub, &ev(json!({"id":"c2","type":"command","ref":REF(),"idempotencyKey":"w2","payload":{"key":"A"}}))));
    assert_eq!(bad["outcome"], "rejected");
    assert!(bad["detail"].as_str().unwrap().contains("key and field"));
}

#[test]
fn distinct_search_rank_and_stats() {
    let (mut hub, mut ep) = setup();
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    feed(&hub, &[("A", "Govies", 10), ("B", "EM", 20), ("C", "Govies", 5)]);

    let dv = reply(&ep.on_text(&mut hub, &ev(json!({"id":"dv","type":"distinctValues","ref":REF(),"colId":"desk"}))));
    let mut vals: Vec<_> = dv["payload"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    vals.sort();
    assert_eq!(vals, ["EM", "Govies"]);

    let sv = reply(&ep.on_text(&mut hub, &ev(json!({"id":"sv","type":"searchValues","ref":REF(),"colId":"desk","prefix":"go"}))));
    assert_eq!(sv["payload"], json!(["Govies"]));

    // rank of C under qty ascending: qtys 5(C),10(A),20(B) → C is index 0.
    let rk = reply(&ep.on_text(&mut hub, &ev(json!({"id":"rk","type":"rank","ref":REF(),"key":"C","view":{"sort":[{"colId":"qty","sort":"asc"}]}}))));
    assert_eq!(rk["payload"], 0);

    let st = reply(&ep.on_text(&mut hub, &ev(json!({"id":"st","type":"stats"}))));
    assert_eq!(st["payload"]["datasourceCount"], 1);
    assert_eq!(st["payload"]["datasources"][0]["cacheRows"], 3);
    assert_eq!(st["payload"]["datasources"][0]["subscribers"], 1);
}

#[test]
fn push_config_hot_reload_reports_reload_class() {
    let (mut hub, mut ep) = setup();
    // Register via bootstrap first.
    ep.on_text(&mut hub, &ev(json!({"id":"b","type":"bootstrap","datasources":[{
        "id":"other","columns":["id","px"],"keyColumns":["id"]
    }]})));
    // Push a schema change to it → rebuild.
    let r = reply(&ep.on_text(&mut hub, &ev(json!({"id":"p","type":"pushConfig","bundle":{
        "bundleVersion": 5,
        "datasources":[{"id":"other","columns":["id","px","size"],"keyColumns":["id"]}]
    }}))));
    assert_eq!(r["type"], "configApplied");
    assert_eq!(r["bundleVersion"], 5);
    assert_eq!(r["datasources"][0]["reload"], "rebuild");
    assert_eq!(hub.bundle_version, 5);
}
