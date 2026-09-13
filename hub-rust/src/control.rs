//! Control-protocol dispatch — the Rust twin of `dshub-worker/src/control.mjs`.
//!
//! Same message envelope (`{id, type, …}`), same reply shapes, same error codes.
//! A message arriving here has already been lifted out of its socket.io frame by
//! server.rs; the reply this returns is framed back the same way. Keeping the
//! shapes identical is what lets the existing browser `ControlClient` talk to
//! the Rust hub with no change.

use crate::hub::{parse_agg_specs_checked, Hub};
use crate::session::Session;
use crate::store::Value;
use serde_json::{json, Value as Json};

pub const PROTOCOL_VERSION: i64 = 1;

fn err(id: &str, code: &str, message: String) -> Json {
    json!({ "id": id, "type": "error", "code": code, "message": message, "retryable": false })
}
fn result(id: &str, payload: Json) -> Json {
    json!({ "id": id, "type": "result", "payload": payload })
}

/// Extract `(datasourceId, params)` from a message's `ref`.
fn parse_ref(msg: &Json) -> Option<(String, Json)> {
    let r = msg.get("ref")?;
    let ds = r.get("datasourceId").and_then(Json::as_str)?.to_string();
    let params = r.get("params").cloned().unwrap_or(json!({}));
    Some((ds, params))
}

fn value_to_json(v: &Value) -> Json { v.to_json() }

/// The delivery conflation interval for a datasource (config
/// conflation.defaultIntervalMs), defaulting to 100ms.
fn conflate_ms_for(hub: &Hub, ds_id: &str) -> u64 {
    hub.registry.datasource(ds_id)
        .and_then(|d| d.config.get("conflation"))
        .and_then(|c| c.get("defaultIntervalMs"))
        .and_then(Json::as_u64)
        .unwrap_or(100)
}

/// Handle one control message. Returns the reply, or `None` for fire-and-forget.
pub fn handle_control(hub: &mut Hub, session: &mut Session, msg: &Json) -> Option<Json> {
    let id = msg.get("id").and_then(Json::as_str).unwrap_or("unknown").to_string();
    let mtype = msg.get("type").and_then(Json::as_str).unwrap_or("");

    match mtype {
        "hello" => {
            let pv = msg.get("protocolVersion").and_then(Json::as_i64);
            if pv != Some(PROTOCOL_VERSION) {
                return Some(err(&id, "protocol-version-mismatch",
                    format!("provider speaks protocol {}; this hub speaks {PROTOCOL_VERSION}",
                        pv.map(|v| v.to_string()).unwrap_or_else(|| "?".into()))));
            }
            session.app_id = msg.get("appId").and_then(Json::as_str).map(str::to_string);
            session.protocol_version = pv;
            // Config reconcile (architecture §3.6): compare (version, checksum).
            let status = reconcile(
                msg.get("bundleVersion").and_then(Json::as_u64).unwrap_or(0),
                msg.get("bundleChecksum").and_then(Json::as_str),
                hub.bundle_version,
                Some(&hub.bundle_checksum),
            );
            Some(json!({
                "id": id, "type": "configAck", "status": status,
                "bundleVersion": hub.bundle_version, "bundleChecksum": hub.bundle_checksum,
            }))
        }

        "bootstrap" => {
            // The app connects, then pushes ALL the upstream datasource config
            // so the hub can serve it. Idempotent per config: re-bootstrapping
            // the same datasource just attaches; a divergent one is surfaced.
            let configs = msg.get("datasources").and_then(Json::as_array).cloned().unwrap_or_default();
            if configs.is_empty() {
                return Some(err(&id, "invalid-params", "malformed bootstrap: no datasources".into()));
            }
            let mut out = Vec::new();
            for cfg in &configs {
                match parse_datasource(cfg) {
                    Some(ds) => {
                        let id = ds.id.clone();
                        let status = hub.register_datasource(ds);
                        out.push(json!({ "id": id, "status": status.as_str() }));
                    }
                    None => out.push(json!({ "id": cfg.get("id").cloned().unwrap_or(Json::Null), "status": "invalid" })),
                }
            }
            Some(result(&id, json!({ "datasources": out })))
        }

        "subscribe" => {
            let Some((ds, params)) = parse_ref(msg) else {
                return Some(err(&id, "invalid-params", "malformed subscribe: missing ref".into()));
            };
            match hub.subscribe(&ds, &params, &session.id) {
                Ok(a) => {
                    session.subscriptions.insert(crate::registry::Registry::cache_key(&ds, &params));
                    // CSRM streaming: register a live row-delta stream. Start from
                    // the CURRENT revision so it streams live changes, not a
                    // re-dump of the snapshot the client already read via getRows.
                    if msg.get("delivery").and_then(Json::as_str) == Some("rows") {
                        let from = a.cache.lock().map(|c| c.revision()).unwrap_or(0);
                        session.deltas.push(crate::delta::DeltaSub {
                            datasource_id: ds.clone(), cache: a.cache.clone(), last_rev: from,
                            conflate_ms: conflate_ms_for(hub, &ds), last_flush: None,
                        });
                    }
                    Some(json!({
                        "id": id, "type": "subscribed",
                        "tableName": a.table_name, "schemaRef": a.schema_ref,
                        "mode": "shared", "estimatedRows": a.estimated_rows,
                    }))
                }
                Err(e) => Some(err(&id, "unknown-datasource", e)),
            }
        }

        "alertSubscribe" => {
            // A predicate over the FULL table. Compile it, evaluate the initial
            // matches (which fire immediately), and register it to re-fire on
            // transitions as the cache changes.
            let Some((ds, params)) = parse_ref(msg) else {
                return Some(err(&id, "invalid-params", "malformed alertSubscribe: missing ref".into()));
            };
            // An unnamed rule used to default to "rule", so two of them shared
            // one identity: unsubscribing either killed both, and with the
            // stacking below they fired twice each.
            let rule_id = match msg.get("ruleId").and_then(Json::as_str) {
                Some(r) if !r.is_empty() => r.to_string(),
                _ => return Some(err(&id, "invalid-params", "alertSubscribe needs a ruleId".into())),
            };
            let predicate = msg.get("predicate").and_then(Json::as_str).unwrap_or("");
            let ast = match crate::dsl::parse(predicate) {
                Ok(a) => a,
                Err(e) => return Some(err(&id, "invalid-predicate", format!("alert predicate: {e}"))),
            };
            let Some(cache) = hub.registry.cache_for(&ds, &params) else {
                return Some(err(&id, "no-subscription", format!("no subscription for \"{ds}\"")));
            };
            let mut sub = crate::alerts::AlertSub { rule_id: rule_id.clone(), ast, cache, watcher: crate::alerts::AlertWatcher::new() };
            // Initial fire for rows already over the line — delivered via outbox.
            for m in sub.poll(None) { session.push(m); }
            let active = sub.watcher.active_count();
            // REPLACE this session's subscription for this rule, do not stack a
            // second one beside it — the same bug `watchGroups` had. A client
            // re-registers whenever its rule is edited, and every stacked copy
            // scans the whole table on every tick and fires its own duplicate
            // alert. `alertUnsubscribe` exists, but relying on a client to call
            // it is relying on the one thing that goes wrong.
            session.alerts.retain(|a| a.rule_id != rule_id);
            session.alerts.push(sub);
            Some(json!({ "id": id, "type": "result", "payload": { "ruleId": rule_id, "watching": true, "activeCount": active } }))
        }

        "alertUnsubscribe" => {
            let rule_id = msg.get("ruleId").and_then(Json::as_str).unwrap_or("").to_string();
            session.remove_alert(&rule_id);
            Some(json!({ "id": id, "type": "result", "payload": { "ruleId": rule_id, "watching": false } }))
        }

        "watchGroups" => {
            // Push group-aggregate deltas: only the group rows whose aggregate moved.
            let Some((ds, params)) = parse_ref(msg) else {
                return Some(err(&id, "invalid-params", "malformed watchGroups: missing ref".into()));
            };
            let group_by: Vec<String> = msg.get("groupBy").and_then(Json::as_array)
                .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect()).unwrap_or_default();
            if group_by.is_empty() {
                return Some(err(&id, "invalid-params", "watchGroups needs a groupBy".into()));
            }
            let aggs = crate::groupwatch::parse_aggs(msg.get("aggregates").unwrap_or(&json!({})));
            let view = msg.get("view");
            let filter = crate::query::Filter::from_json(view.and_then(|v| v.get("filter")).unwrap_or(&Json::Null));
            // Computed columns ride the watch the same way they ride a view —
            // same wire form, same parser. What differs is that each `agg` node
            // inside one is folded PER GROUP NODE rather than once per view, so
            // a caption can carry `SUM(spread x dv01) / SUM(dv01)`.
            let (computed, computed_errors) = crate::view::parse_computed(view.and_then(|v| v.get("computed")));
            if !computed_errors.is_empty() {
                // Same rule as `open_view`: a half-parsed spec would aggregate
                // something other than what it reports. Reject, never degrade.
                return Some(err(&id, "invalid-params",
                    format!("invalid computed columns: {}", computed_errors.join("; "))));
            }
            let Some(cache) = hub.registry.cache_for(&ds, &params) else {
                return Some(err(&id, "no-subscription", format!("no subscription for \"{ds}\"")));
            };
            // Refuse a watch naming columns that do not resolve, rather than
            // silently dropping them and pushing blank aggregates forever.
            {
                let c = cache.lock().unwrap();
                let mut refs: Vec<(&str, String)> = Vec::new();
                for g in &group_by { refs.push(("group column", g.clone())); }
                for a in &aggs { refs.push(("aggregate", a.column.clone())); }
                if let Err(e) = crate::view::validate_columns_and_filter(&c, &computed, &refs, Some(&filter)) {
                    return Some(err(&id, "invalid-params", format!("watchGroups {e}")));
                }
            }
            let cms = conflate_ms_for(hub, &ds);
            let mut w = crate::groupwatch::GroupWatch::new(ds.clone(), cache, filter, group_by, aggs, computed, cms);
            if let Some(m) = w.poll() { session.push(m); } // initial group snapshot
            let count = w.group_count();
            // REPLACE this session's watch on this datasource, do not stack a
            // second one beside it.
            //
            // A grid re-watches whenever its grouping changes, and each watch
            // scans the whole table per level on every tick. Appending meant a
            // session that had grouped four different ways paid four scans a
            // tick forever, and a consumer folding the pushes got the four
            // trees mixed together — depth-4 paths arriving for a one-level
            // grouping. There is no `unwatchGroups` verb to undo it with, so
            // the only way out was to drop the whole session.
            //
            // One watch per (session, datasource) is what a viewer can
            // actually mean: a session has one grouping at a time.
            session.group_watches.retain(|existing| existing.datasource_id != ds);
            session.group_watches.push(w);
            Some(json!({ "id": id, "type": "result", "payload": { "watching": true, "groupCount": count } }))
        }

        "openView" => {
            let Some((ds, params)) = parse_ref(msg) else {
                return Some(err(&id, "invalid-params", "malformed openView: missing ref".into()));
            };
            let spec = msg.get("view").cloned().unwrap_or(json!({}));
            match hub.open_view(&ds, &params, &spec) {
                Ok(view_id) => { session.open_views.insert(view_id.clone()); Some(result(&id, json!({ "viewId": view_id }))) }
                Err(e) => Some(err(&id, "no-subscription", e)),
            }
        }

        "readWindow" => {
            let view_id = msg.get("viewId").and_then(Json::as_str).unwrap_or("");
            let start = msg.get("startRow").and_then(Json::as_u64).unwrap_or(0) as usize;
            let end = msg.get("endRow").and_then(Json::as_u64).map(|e| e as usize);
            match hub.read_window(view_id, start, end) {
                Ok((rows, total)) => Some(result(&id, json!({ "rows": rows, "rowCount": total }))),
                Err(e) => Some(err(&id, "invalid-params", e)),
            }
        }

        "expandRow" => {
            let view_id = msg.get("viewId").and_then(Json::as_str).unwrap_or("");
            let index = msg.get("index").and_then(Json::as_u64).unwrap_or(0) as usize;
            let collapse = msg.get("collapse").and_then(Json::as_bool).unwrap_or(false);
            match hub.expand_row(view_id, index, collapse) {
                Ok(count) => Some(result(&id, json!({ "rowCount": count }))),
                Err(e) => Some(err(&id, "invalid-params", e)),
            }
        }

        "disposeView" => {
            let view_id = msg.get("viewId").and_then(Json::as_str).unwrap_or("");
            let disposed = hub.dispose_view(view_id);
            session.open_views.remove(view_id);
            Some(result(&id, json!({ "disposed": disposed })))
        }

        "command" => {
            let idem = msg.get("idempotencyKey").and_then(Json::as_str).unwrap_or("");
            let verb = msg.get("verb").and_then(Json::as_str).unwrap_or("edit");
            let (ds, params) = parse_ref(msg).unwrap_or_default();
            let payload = msg.get("payload");
            let key = payload.and_then(|p| p.get("key")).and_then(Json::as_str).unwrap_or("");
            let field = payload.and_then(|p| p.get("field")).and_then(Json::as_str).unwrap_or("");
            let value = payload.and_then(|p| p.get("value")).cloned().unwrap_or(Json::Null);
            let (outcome, detail) = hub.command(idem, &ds, &params, key, field, &value);
            let mut m = serde_json::Map::new();
            m.insert("id".into(), json!(id));
            m.insert("type".into(), json!("commandResult"));
            m.insert("idempotencyKey".into(), json!(idem));
            m.insert("verb".into(), json!(verb));
            m.insert("outcome".into(), json!(outcome));
            if let Some(d) = detail { m.insert("detail".into(), json!(d)); }
            Some(Json::Object(m))
        }

        "distinctValues" => {
            let Some((ds, params)) = parse_ref(msg) else { return Some(err(&id, "invalid-params", "malformed distinctValues: missing ref".into())); };
            let col = msg.get("colId").and_then(Json::as_str).unwrap_or("");
            let ctx = msg.get("contextFilter").cloned().unwrap_or(json!([]));
            let limit = msg.get("limit").and_then(Json::as_u64).unwrap_or(10_000) as usize;
            match hub.distinct_values(&ds, &params, col, &ctx, limit) {
                Ok(vals) => Some(result(&id, json!(vals))),
                Err(e) => Some(err(&id, "no-subscription", e)),
            }
        }

        "searchValues" => {
            let Some((ds, params)) = parse_ref(msg) else { return Some(err(&id, "invalid-params", "malformed searchValues: missing ref".into())); };
            let col = msg.get("colId").and_then(Json::as_str).unwrap_or("");
            let prefix = msg.get("prefix").and_then(Json::as_str).unwrap_or("");
            let limit = msg.get("limit").and_then(Json::as_u64).unwrap_or(100) as usize;
            match hub.search_values(&ds, &params, col, prefix, limit) {
                Ok(vals) => Some(result(&id, json!(vals))),
                Err(e) => Some(err(&id, "no-subscription", e)),
            }
        }

        "rank" => {
            let Some((ds, params)) = parse_ref(msg) else { return Some(err(&id, "invalid-params", "malformed rank: missing ref".into())); };
            let key = msg.get("key").and_then(Json::as_str).unwrap_or("");
            let view = msg.get("view").cloned().unwrap_or(json!({}));
            match hub.rank(&ds, &params, key, &view) {
                Ok(r) => Some(result(&id, r.map(|i| json!(i)).unwrap_or(Json::Null))),
                Err(e) => Some(err(&id, "no-subscription", e)),
            }
        }

        "pushConfig" => {
            // Hot reload: apply a new config to the RUNNING hub and report the
            // reload class each datasource change implies (architecture §3.8).
            let bundle = msg.get("bundle");
            let mut out = Vec::new();
            if let Some(dss) = bundle.and_then(|b| b.get("datasources")).and_then(Json::as_array) {
                for cfg in dss {
                    match parse_datasource(cfg) {
                        Some(ds) => {
                            let dsid = ds.id.clone();
                            let reload = hub.registry.replace_datasource(ds);
                            out.push(json!({ "id": dsid, "reload": reload }));
                        }
                        // Silently dropping this was the worst version: a hot
                        // reload whose config had a typo left the OLD datasource
                        // running and reported success, so the fix a desk was
                        // waiting on simply never arrived. `bootstrap` already
                        // reports `invalid`; this is the same contract.
                        None => out.push(json!({
                            "id": cfg.get("id").cloned().unwrap_or(Json::Null),
                            "status": "invalid",
                        })),
                    }
                }
            }
            let new_version = bundle.and_then(|b| b.get("bundleVersion")).and_then(Json::as_u64)
                .unwrap_or(hub.bundle_version + 1);
            hub.bundle_version = new_version;
            if let Some(sum) = bundle.and_then(|b| b.get("checksum")).and_then(Json::as_str) {
                hub.bundle_checksum = sum.to_string();
            }
            Some(json!({ "id": id, "type": "configApplied", "bundleVersion": new_version, "datasources": out }))
        }

        "ack" => {
            // Flow-control signal, fire-and-forget: advance the acked sequence.
            if let Some(seq) = msg.get("seq").and_then(Json::as_u64) { session.flow.on_ack(seq); }
            None
        }

        "stats" => Some(result(&id, hub.stats())),

        "unsubscribe" => {
            if let Some((ds, params)) = parse_ref(msg) {
                let key = crate::registry::Registry::cache_key(&ds, &params);
                hub.registry.release(&key, &session.id);
                session.subscriptions.remove(&key);
            }
            None
        }

        "rowCount" => {
            let Some((ds, params)) = parse_ref(msg) else {
                return Some(err(&id, "invalid-params", "malformed rowCount: missing ref".into()));
            };
            let filter = msg.get("view").and_then(|v| v.get("filter")).cloned().unwrap_or(json!([]));
            match hub.row_count(&ds, &params, &filter) {
                Ok(n) => Some(result(&id, json!(n))),
                Err(e) => Some(err(&id, "no-subscription", e)),
            }
        }

        "aggregates" => {
            let Some((ds, params)) = parse_ref(msg) else {
                return Some(err(&id, "invalid-params", "malformed aggregates: missing ref".into()));
            };
            let (specs, bad) = parse_agg_specs_checked(msg.get("specs").unwrap_or(&json!([])));
            if !bad.is_empty() {
                return Some(err(&id, "invalid-params",
                    format!("aggregates: {}", bad.join("; "))));
            }
            let filter = msg.get("view").and_then(|v| v.get("filter")).cloned().unwrap_or(json!([]));
            match hub.aggregates(&ds, &params, &specs, &filter) {
                Ok(map) => {
                    let mut obj = serde_json::Map::new();
                    for (k, v) in map { obj.insert(k, value_to_json(&v)); }
                    Some(result(&id, Json::Object(obj)))
                }
                Err(e) => Some(err(&id, "no-subscription", e)),
            }
        }

        "" => Some(err(&id, "invalid-params", "malformed message: missing type".into())),
        other => Some(err(&id, "internal", format!("unhandled message type \"{other}\""))),
    }
}

/// Parse one datasource config from a bootstrap payload. Accepts `columns` as
/// either `["a","b"]` or `[{"name":"a"},{"column":"b"}]`. The checksum is the
/// app's if it supplied one, else the canonical JSON of the config — so two apps
/// pushing byte-equivalent config reconcile as `Shared`.
fn parse_datasource(cfg: &Json) -> Option<crate::registry::Datasource> {
    let o = cfg.as_object()?;
    let id = o.get("id").and_then(Json::as_str)?.to_string();
    let schema_ref = o.get("schemaRef").and_then(Json::as_str).unwrap_or(&id).to_string();
    let columns = parse_columns(o.get("columns").unwrap_or(&Json::Null));
    if columns.is_empty() { return None; } // no schema, nothing to cache
    let key_columns: Vec<String> = o.get("keyColumns").and_then(Json::as_array)
        .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
        .unwrap_or_else(|| vec![columns[0].clone()]);
    let estimated_rows = o.get("estimatedRows").and_then(Json::as_u64).unwrap_or(0);
    let connection = o.get("connection").cloned().unwrap_or(Json::Null);
    let checksum = o.get("checksum").and_then(Json::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| canonical_string(cfg));
    Some(crate::registry::Datasource { id, schema_ref, columns, key_columns, estimated_rows, connection, config: cfg.clone(), checksum })
}

fn parse_columns(j: &Json) -> Vec<String> {
    j.as_array().map(|a| a.iter().filter_map(|c| {
        c.as_str().map(str::to_string).or_else(||
            c.get("name").or_else(|| c.get("column")).and_then(Json::as_str).map(str::to_string))
    }).collect()).unwrap_or_default()
}

/// Canonical JSON: object keys sorted recursively, so equivalent configs with
/// different key order produce the same checksum.
fn canonical_string(j: &Json) -> String {
    fn canon(j: &Json) -> Json {
        match j {
            Json::Object(m) => {
                let mut b: std::collections::BTreeMap<String, Json> = std::collections::BTreeMap::new();
                for (k, v) in m { if k != "checksum" { b.insert(k.clone(), canon(v)); } }
                Json::Object(b.into_iter().collect())
            }
            Json::Array(a) => Json::Array(a.iter().map(canon).collect()),
            other => other.clone(),
        }
    }
    serde_json::to_string(&canon(j)).unwrap_or_default()
}

/// (version, checksum) reconcile — mirrors `reconcileConfig` in control.mjs.
fn reconcile(app_v: u64, app_sum: Option<&str>, hub_v: u64, hub_sum: Option<&str>) -> &'static str {
    if app_v == hub_v {
        match (app_sum, hub_sum) {
            (Some(a), Some(h)) if a != h => "conflict",
            _ => "current",
        }
    } else if app_v > hub_v {
        "app-newer"
    } else {
        "hub-newer"
    }
}
