//! App-driven bootstrap: the hub starts empty; an app connects, pushes the full
//! upstream datasource config, then subscribes. The first app to push a config
//! establishes the shared cache; later apps with the same config attach, a
//! divergent one is surfaced, not silently adopted.

use dshub::hub::Hub;
use dshub::registry::Registry;
use dshub::server::Endpoint;
use dshub::socketio::{decode_engine_io, decode_socket_io, encode_event};
use serde_json::{json, Value as Json};

fn empty_hub() -> Hub {
    Hub::from_registry(Registry::empty(), 1, "sha256:x")
}
fn ev(msg: Json) -> String { encode_event("msg", &msg, "/") }
fn reply(frames: &[String]) -> Json {
    let eng = decode_engine_io(&frames[0]);
    let sio = decode_socket_io(&eng.payload);
    sio.data.unwrap().as_array().unwrap()[1].clone()
}
fn connect(ep: &mut Endpoint, hub: &mut Hub) { ep.on_text(hub, "40"); }

fn positions_config() -> Json {
    json!({
        "id": "positions",
        "schemaRef": "positions@v1",
        "keyColumns": ["positionId"],
        "columns": ["positionId", "desk", "qty"],
        "estimatedRows": 500000,
        "connection": { "transport": "websocket", "url": "wss://feed.example/positions", "snapshot": { "mode": "trigger-reply" } }
    })
}

#[test]
fn app_bootstraps_then_subscribes_and_queries() {
    let mut hub = empty_hub();
    assert_eq!(hub.registry.datasource_count(), 0, "hub starts empty");

    let (mut ep, _open) = Endpoint::new("s1");
    connect(&mut ep, &mut hub);
    ep.on_text(&mut hub, &ev(json!({"id":"h","type":"hello","appId":"app","protocolVersion":1})));

    // The app pushes ALL the upstream config.
    let boot = reply(&ep.on_text(&mut hub, &ev(json!({"id":"b","type":"bootstrap","datasources":[positions_config()]}))));
    assert_eq!(boot["type"], "result");
    assert_eq!(boot["payload"]["datasources"][0]["status"], "registered");
    assert!(hub.registry.is_registered("positions"));

    // Now subscribe works, and the shared cache exists.
    let ref_ = json!({"datasourceId":"positions","params":{"clientId":"t1"}});
    let sub = reply(&ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":ref_}))));
    assert_eq!(sub["type"], "subscribed");
    assert_eq!(sub["estimatedRows"], 500000);

    // Feed the shared cache (stands in for ingest) and query over the socket.
    {
        let cache = hub.registry.cache_for("positions", &json!({"clientId":"t1"})).unwrap();
        let mut c = cache.lock().unwrap();
        for (k, q) in [("A", 10), ("B", 20)] {
            c.upsert(k, json!({"positionId":k,"desk":"Govies","qty":q}).as_object().unwrap());
        }
    }
    let rc = reply(&ep.on_text(&mut hub, &ev(json!({"id":"r","type":"rowCount","ref":json!({"datasourceId":"positions","params":{"clientId":"t1"}}),"view":{"filter":[]}}))));
    assert_eq!(rc["payload"], 2);
}

#[test]
fn subscribe_before_bootstrap_is_refused() {
    let mut hub = empty_hub();
    let (mut ep, _) = Endpoint::new("s1");
    connect(&mut ep, &mut hub);
    let sub = reply(&ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":json!({"datasourceId":"positions","params":{}})}))));
    assert_eq!(sub["type"], "error");
    assert_eq!(sub["code"], "unknown-datasource");
}

#[test]
fn two_apps_same_config_share_a_different_config_conflicts() {
    let mut hub = empty_hub();
    let (mut a, _) = Endpoint::new("a");
    let (mut b, _) = Endpoint::new("b");
    connect(&mut a, &mut hub);
    connect(&mut b, &mut hub);

    // App A bootstraps.
    let ra = reply(&a.on_text(&mut hub, &ev(json!({"id":"1","type":"bootstrap","datasources":[positions_config()]}))));
    assert_eq!(ra["payload"]["datasources"][0]["status"], "registered");

    // App B pushes the SAME config (even with keys reordered) → shares.
    let same = json!({
        "columns": ["positionId", "desk", "qty"], "id": "positions", "schemaRef": "positions@v1",
        "keyColumns": ["positionId"], "estimatedRows": 500000,
        "connection": { "snapshot": { "mode": "trigger-reply" }, "transport": "websocket", "url": "wss://feed.example/positions" }
    });
    let rb = reply(&b.on_text(&mut hub, &ev(json!({"id":"1","type":"bootstrap","datasources":[same]}))));
    assert_eq!(rb["payload"]["datasources"][0]["status"], "shared", "byte-equivalent config attaches");

    // App B pushes a DIFFERENT config for the same id → conflict, not overwrite.
    let mut diff = positions_config();
    diff["connection"]["url"] = json!("wss://other.example/positions");
    let rc = reply(&b.on_text(&mut hub, &ev(json!({"id":"2","type":"bootstrap","datasources":[diff]}))));
    assert_eq!(rc["payload"]["datasources"][0]["status"], "conflict", "divergent config surfaced, not adopted");
}
