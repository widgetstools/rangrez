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

/// Re-watching REPLACES a session's watch on that datasource.
///
/// A grid re-watches every time its grouping changes. When the watches stacked
/// instead, a session that had grouped four ways paid four whole-table scans
/// per tick forever, and anything folding the pushes saw the four trees mixed
/// — depth-4 paths arriving for a one-level grouping. There is no
/// `unwatchGroups` to undo it with, so the only escape was dropping the
/// session.
#[test]
fn rewatching_replaces_rather_than_stacks() {
    let mut hub = hub();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    feed(&hub, &[("A", "Govies", 10), ("B", "Govies", 20), ("C", "EM", 5)]);

    // Two levels first, then one — the ordinary "user changed the grouping".
    ep.on_text(&mut hub, &ev(json!({
        "id":"g1","type":"watchGroups","ref":REF(),
        "groupBy":["desk","positionId"],"aggregates":{"qty":"sum"}
    })));
    ep.on_text(&mut hub, &ev(json!({
        "id":"g2","type":"watchGroups","ref":REF(),
        "groupBy":["desk"],"aggregates":{"qty":"sum"}
    })));

    // One tick, one groupDelta, and every path one level deep. Stacking shows
    // up as two deltas, or as depth-2 paths arriving for a depth-1 grouping.
    feed(&hub, &[("A", "Govies", 100)]);
    let t = msgs(&ep.tick(None));
    let deltas: Vec<_> = t.iter().filter(|m| m["type"] == "groupDelta").collect();
    assert_eq!(deltas.len(), 1, "one watch survives, so one delta");
    for g in deltas[0]["groups"].as_array().unwrap() {
        assert_eq!(g["path"].as_array().unwrap().len(), 1, "only the CURRENT grouping's depth");
    }
}

/// Two datasources on one session keep their own watches.
///
/// The replacement is scoped to the datasource, not the session: a viewer with
/// two grids must not have one silently unsubscribe the other.
#[test]
fn replacement_is_scoped_to_the_datasource() {
    let mut hub = Hub::new([
        Datasource {
            id: "positions".into(), schema_ref: "p".into(),
            columns: vec!["positionId".into(), "desk".into(), "qty".into()],
            key_columns: vec!["positionId".into()], estimated_rows: 100,
            config: json!({"conflation":{"defaultIntervalMs":0}}), ..Default::default()
        },
        Datasource {
            id: "orders".into(), schema_ref: "o".into(),
            columns: vec!["positionId".into(), "desk".into(), "qty".into()],
            key_columns: vec!["positionId".into()], estimated_rows: 100,
            config: json!({"conflation":{"defaultIntervalMs":0}}), ..Default::default()
        },
    ], 1, "x");
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    let refs = |ds: &str| json!({ "datasourceId": ds, "params": { "clientId": "t1" } });
    for ds in ["positions", "orders"] {
        ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":refs(ds)})));
        let c = hub.registry.cache_for(ds, &json!({"clientId":"t1"})).unwrap();
        let mut c = c.lock().unwrap();
        c.upsert("A", json!({"positionId":"A","desk":"Govies","qty":1}).as_object().unwrap());
    }
    ep.on_text(&mut hub, &ev(json!({
        "id":"g1","type":"watchGroups","ref":refs("positions"),"groupBy":["desk"],"aggregates":{"qty":"sum"}
    })));
    ep.on_text(&mut hub, &ev(json!({
        "id":"g2","type":"watchGroups","ref":refs("orders"),"groupBy":["desk"],"aggregates":{"qty":"sum"}
    })));

    for ds in ["positions", "orders"] {
        let c = hub.registry.cache_for(ds, &json!({"clientId":"t1"})).unwrap();
        let mut c = c.lock().unwrap();
        c.upsert("A", json!({"positionId":"A","desk":"Govies","qty":99}).as_object().unwrap());
    }
    let t = msgs(&ep.tick(None));
    let ids: Vec<_> = t.iter().filter(|m| m["type"] == "groupDelta")
        .map(|m| m["datasourceId"].as_str().unwrap().to_string()).collect();
    assert!(ids.contains(&"positions".to_string()), "positions watch survived");
    assert!(ids.contains(&"orders".to_string()), "orders watch survived");
}

// ───────────────────────── computed columns on a group watch ──────────────
//
// A view has ONE aggregation scope, so it folds each `agg` node once and every
// row shares the scalar. A group watch spans every node at every level, so the
// scope is a different row set per node. These pin that each caption carries
// ITS OWN fold — the property that makes a weighted average expressible on a
// group row, and the one a single view-level scalar would quietly destroy.

fn hub_w() -> Hub {
    Hub::new([Datasource {
        id: "positions".into(), schema_ref: "p".into(),
        columns: vec!["positionId".into(), "desk".into(), "region".into(),
                      "spread".into(), "dv01".into()],
        key_columns: vec!["positionId".into()], estimated_rows: 100,
        config: serde_json::json!({"conflation":{"defaultIntervalMs":0}}), ..Default::default()
    }], 1, "x")
}

fn feed_w(hub: &Hub, rows: &[(&str, &str, &str, f64, f64)]) {
    let c = hub.registry.cache_for("positions", &json!({"clientId":"t1"})).unwrap();
    let mut c = c.lock().unwrap();
    for (k, desk, region, spread, dv01) in rows {
        c.upsert(k, json!({"positionId":k,"desk":desk,"region":region,
                           "spread":spread,"dv01":dv01}).as_object().unwrap());
    }
}

/// `wprod = spread * dv01` (row-scoped), `wSpread = SUM(wprod) / SUM(dv01)`
/// (node-scoped). Two columns because an `agg` node names a COLUMN, so the
/// product must exist as one before it can be folded.
fn weighted() -> Json {
    json!([
        {"as":"wprod","expr":{"k":"bin","op":"mul",
            "l":{"k":"col","name":"spread"},"r":{"k":"col","name":"dv01"}}},
        {"as":"wSpread","expr":{"k":"bin","op":"div",
            "l":{"k":"agg","fn":"sum","col":"wprod"},
            "r":{"k":"agg","fn":"sum","col":"dv01"}}}
    ])
}

/// Two desks weighted in opposite directions.
///
/// Credit: 280bp on 10 dv01 and 20bp on 90 dv01 — mean 150, weighted 46.
/// Rates:   10bp on 10 dv01 and 400bp on 90 dv01 — mean 205, weighted 361.
/// Book:    40,700 / 200 = 203.5, which must appear on NO caption.
fn two_desks() -> [(&'static str, &'static str, &'static str, f64, f64); 4] {
    [("A", "Credit", "EMEA", 280.0, 10.0), ("B", "Credit", "EMEA", 20.0, 90.0),
     ("C", "Rates", "APAC", 10.0, 10.0), ("D", "Rates", "APAC", 400.0, 90.0)]
}

fn watch(ep: &mut Endpoint, hub: &mut Hub, group_by: Json, computed: Json) -> Vec<Json> {
    msgs(&ep.on_text(hub, &ev(json!({
        "id":"g","type":"watchGroups","ref":REF(),"groupBy":group_by,
        "aggregates":{"dv01":"sum"},"view":{"computed":computed}
    }))))
}

/// Look up one group's aggregates by path.
fn caption<'a>(delta: &'a Json, path: &[&str]) -> &'a Json {
    let want: Vec<String> = path.iter().map(|p| format!("s{p}")).collect();
    delta["groups"].as_array().unwrap().iter()
        .find(|g| g["path"] == json!(want))
        .unwrap_or_else(|| panic!("no group at {path:?}"))
        .get("aggregates").unwrap()
}

#[test]
fn each_caption_carries_its_own_weighted_average() {
    // The headline. A single view-level scalar would put 203.5 under both.
    let mut hub = hub_w();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    feed_w(&hub, &two_desks());

    let out = watch(&mut ep, &mut hub, json!(["desk"]), weighted());
    assert_eq!(out[0]["payload"]["watching"], true);
    let delta = out[1..].iter().find(|m| m["type"] == "groupDelta").expect("initial snapshot");

    assert_eq!(caption(delta, &["Credit"])["wSpread"], 46.0);
    assert_eq!(caption(delta, &["Rates"])["wSpread"], 361.0);
}

#[test]
fn the_books_own_weighted_average_appears_on_no_caption() {
    // The discriminating assertion: 203.5 is what a view-scoped fold would
    // produce, and it is wrong for every group in the book.
    let mut hub = hub_w();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    feed_w(&hub, &two_desks());

    let out = watch(&mut ep, &mut hub, json!(["desk"]), weighted());
    let delta = out[1..].iter().find(|m| m["type"] == "groupDelta").unwrap();
    for g in delta["groups"].as_array().unwrap() {
        assert_ne!(g["aggregates"]["wSpread"], 203.5, "group {} got the book's fold", g["path"]);
    }
}

#[test]
fn every_level_folds_over_its_own_rows() {
    // A deeper level is a smaller row set, so its scalar differs from its
    // parent's. Here each desk has one region, so depth 2 reproduces depth 1 —
    // what matters is that the deeper node folded rather than inheriting.
    let mut hub = hub_w();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    feed_w(&hub, &[("A", "Credit", "EMEA", 280.0, 10.0), ("B", "Credit", "APAC", 20.0, 90.0)]);

    let out = watch(&mut ep, &mut hub, json!(["desk", "region"]), weighted());
    let delta = out[1..].iter().find(|m| m["type"] == "groupDelta").unwrap();
    // Desk rolls both up: 4600/100 = 46. Each region holds one position, so
    // its weighted average is just that position's spread.
    assert_eq!(caption(delta, &["Credit"])["wSpread"], 46.0);
    assert_eq!(caption(delta, &["Credit", "EMEA"])["wSpread"], 280.0);
    assert_eq!(caption(delta, &["Credit", "APAC"])["wSpread"], 20.0);
}

#[test]
fn a_row_scoped_computed_column_can_be_aggregated() {
    // `wprod` has a value per row, so it has no caption value of its own — but
    // naming it in `aggregates` folds it like any stored column.
    let mut hub = hub_w();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    feed_w(&hub, &two_desks());

    let out = msgs(&ep.on_text(&mut hub, &ev(json!({
        "id":"g","type":"watchGroups","ref":REF(),"groupBy":["desk"],
        "aggregates":{"wprod":"sum","dv01":"sum"},"view":{"computed":weighted()}
    }))));
    let delta = out[1..].iter().find(|m| m["type"] == "groupDelta").unwrap();
    assert_eq!(caption(delta, &["Credit"])["wprod"], 4600.0);
    assert_eq!(caption(delta, &["Rates"])["wprod"], 36100.0);
}

#[test]
fn a_caption_value_moves_when_a_leaf_ticks() {
    // A weighted average is only useful if it tracks the feed.
    let mut hub = hub_w();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    feed_w(&hub, &two_desks());
    watch(&mut ep, &mut hub, json!(["desk"]), weighted());

    // Re-weight Credit: 280bp now carries 90 dv01 and 20bp carries 10.
    // 25,400 / 100 = 254.
    feed_w(&hub, &[("A", "Credit", "EMEA", 280.0, 90.0), ("B", "Credit", "EMEA", 20.0, 10.0)]);
    let t = msgs(&ep.tick(None));
    let delta = t.iter().find(|m| m["type"] == "groupDelta").expect("a tick pushes the moved group");
    assert_eq!(caption(delta, &["Credit"])["wSpread"], 254.0);
    // Rates did not move, so it is not in the push.
    assert!(delta["groups"].as_array().unwrap().iter().all(|g| g["path"] != json!(["sRates"])));
}

#[test]
fn a_grouping_level_can_be_a_computed_column() {
    // The grouping key resolves through the same table as everything else, so
    // a level can be an expression the cache never stored.
    let mut hub = hub_w();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    feed_w(&hub, &[("A", "Credit", "EMEA", 280.0, 10.0), ("B", "Credit", "EMEA", 20.0, 90.0)]);

    let wide = json!([{"as":"wide","expr":{"k":"bin","op":"gt",
        "l":{"k":"col","name":"spread"},"r":{"k":"lit","v":100}}}]);
    let out = msgs(&ep.on_text(&mut hub, &ev(json!({
        "id":"g","type":"watchGroups","ref":REF(),"groupBy":["wide"],
        "aggregates":{"dv01":"sum"},"view":{"computed":wide}
    }))));
    assert_eq!(out[0]["payload"]["groupCount"], 2, "split into wide and tight");
}

// ───────────────────────── refusals, not silent blanks ────────────────────
//
// These used to succeed and push nothing. `aggregate_over` resolves each spec
// through `cache.col_index` and `continue`s on `None`, so an aggregate over a
// column that does not exist produced no value and no complaint — a blank cell
// where a number belongs, indistinguishable from a real zero.

fn watch_err(ep: &mut Endpoint, hub: &mut Hub, msg: Json) -> Json {
    msgs(&ep.on_text(hub, &ev(msg))).remove(0)
}

fn ready() -> (Hub, Endpoint) {
    let mut hub = hub_w();
    let (mut ep, _) = Endpoint::new("s1");
    ep.on_text(&mut hub, "40");
    ep.on_text(&mut hub, &ev(json!({"id":"s","type":"subscribe","ref":REF()})));
    feed_w(&hub, &two_desks());
    (hub, ep)
}

#[test]
fn an_aggregate_over_an_unknown_column_is_refused() {
    let (mut hub, mut ep) = ready();
    let r = watch_err(&mut ep, &mut hub, json!({
        "id":"g","type":"watchGroups","ref":REF(),"groupBy":["desk"],
        "aggregates":{"notional":"sum"}
    }));
    assert_eq!(r["type"], "error");
    assert!(r["message"].as_str().unwrap().contains("notional"),
            "the message names the column: {r}");
}

#[test]
fn an_unknown_grouping_column_is_refused() {
    let (mut hub, mut ep) = ready();
    let r = watch_err(&mut ep, &mut hub, json!({
        "id":"g","type":"watchGroups","ref":REF(),"groupBy":["trader"],
        "aggregates":{"dv01":"sum"}
    }));
    assert_eq!(r["type"], "error");
    assert!(r["message"].as_str().unwrap().contains("trader"), "{r}");
}

#[test]
fn a_computed_column_that_does_not_parse_is_refused() {
    // Same rule as `open_view`: half a spec would aggregate something other
    // than what it reports.
    let (mut hub, mut ep) = ready();
    let r = watch_err(&mut ep, &mut hub, json!({
        "id":"g","type":"watchGroups","ref":REF(),"groupBy":["desk"],
        "aggregates":{"dv01":"sum"},
        "view":{"computed":[{"as":"bad","expr":{"k":"nonsense"}}]}
    }));
    assert_eq!(r["type"], "error");
    assert!(r["message"].as_str().unwrap().contains("bad"), "{r}");
}

#[test]
fn folding_a_column_that_is_itself_a_fold_is_refused() {
    // `SUM(wSpread)` is circular: wSpread's value is defined BY a fold, so
    // there is nothing per-row to sum.
    let (mut hub, mut ep) = ready();
    let circular = json!([
        {"as":"wprod","expr":{"k":"bin","op":"mul",
            "l":{"k":"col","name":"spread"},"r":{"k":"col","name":"dv01"}}},
        {"as":"wSpread","expr":{"k":"bin","op":"div",
            "l":{"k":"agg","fn":"sum","col":"wprod"},
            "r":{"k":"agg","fn":"sum","col":"dv01"}}},
        {"as":"nope","expr":{"k":"agg","fn":"sum","col":"wSpread"}}
    ]);
    let r = watch_err(&mut ep, &mut hub, json!({
        "id":"g","type":"watchGroups","ref":REF(),"groupBy":["desk"],
        "aggregates":{"dv01":"sum"},"view":{"computed":circular}
    }));
    assert_eq!(r["type"], "error");
    assert!(r["message"].as_str().unwrap().contains("wSpread"), "{r}");
}

#[test]
fn an_aggregate_over_a_computed_column_is_accepted() {
    // The guard must not reject the legitimate case it exists to protect.
    let (mut hub, mut ep) = ready();
    let r = watch_err(&mut ep, &mut hub, json!({
        "id":"g","type":"watchGroups","ref":REF(),"groupBy":["desk"],
        "aggregates":{"wprod":"sum"},"view":{"computed":weighted()}
    }));
    assert_eq!(r["type"], "result", "computed columns resolve like stored ones: {r}");
}

