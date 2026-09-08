//! The hub: registry + config, and the query operations the control layer calls.
//! Host-agnostic — it knows nothing about socket.io or WebSockets. The transport
//! (server.rs) drives it, exactly as the JS Hub is driven by either a
//! MessagePort or a socket.

use crate::query::{aggregate_over, filtered_slots, group_slots, sort_slots, AggSpec, Agg, Filter, SortKey};
use crate::registry::{Acquired, Datasource, Registry};
use crate::store::Value;
use indexmap::IndexMap;
use serde_json::Value as Json;

pub struct Hub {
    pub registry: Registry,
    pub bundle_version: u64,
    pub bundle_checksum: String,
    /// When set, a subscribe that creates a NEW shared cache sends an
    /// `IngestRequest` here so the transport layer starts feeding it. `None` in
    /// tests that populate caches directly.
    pub ingest_tx: Option<std::sync::mpsc::Sender<crate::ingest::IngestRequest>>,
    /// Open server-side views (SSRM/VRM handles), keyed by viewId.
    pub views: std::collections::HashMap<String, crate::view::View>,
    view_seq: u64,
    /// Idempotency ledger for the write path — a retried command applies once.
    seen_commands: std::collections::HashSet<String>,
    pub writes: u64,
}

impl Hub {
    pub fn new(datasources: impl IntoIterator<Item = Datasource>, bundle_version: u64, bundle_checksum: impl Into<String>) -> Hub {
        Hub::from_registry(Registry::new(datasources), bundle_version, bundle_checksum)
    }

    /// Build a hub around an existing registry (empty or pre-populated). The only
    /// way to construct one from another module, since some fields are private.
    pub fn from_registry(registry: Registry, bundle_version: u64, bundle_checksum: impl Into<String>) -> Hub {
        Hub {
            registry, bundle_version, bundle_checksum: bundle_checksum.into(),
            ingest_tx: None, views: std::collections::HashMap::new(), view_seq: 0,
            seen_commands: std::collections::HashSet::new(), writes: 0,
        }
    }

    // ---------------------------------------------------------------- views

    /// Open a server-side view over a subscribed table. Returns its viewId.
    pub fn open_view(&mut self, datasource_id: &str, params: &Json, spec: &Json) -> Result<String, String> {
        let cache = self.registry.cache_for(datasource_id, params)
            .ok_or_else(|| format!("no subscription for \"{datasource_id}\""))?;
        self.view_seq += 1;
        let view_id = format!("v{}", self.view_seq);
        let view = crate::view::View::new(cache, crate::view::ViewSpec::from_json(spec), String::new());
        self.views.insert(view_id.clone(), view);
        Ok(view_id)
    }

    pub fn read_window(&self, view_id: &str, start: usize, end: Option<usize>) -> Result<(Vec<Json>, usize), String> {
        let v = self.views.get(view_id).ok_or_else(|| format!("view \"{view_id}\" is not open"))?;
        Ok(v.read_window(start, end))
    }

    pub fn expand_row(&mut self, view_id: &str, index: usize, collapse: bool) -> Result<usize, String> {
        let v = self.views.get_mut(view_id).ok_or_else(|| format!("view \"{view_id}\" is not open"))?;
        v.set_expanded(index, collapse)
    }

    pub fn dispose_view(&mut self, view_id: &str) -> bool { self.views.remove(view_id).is_some() }

    // ------------------------------------------------------------ write path

    /// Apply a keyed partial write, deduped by idempotency key.
    pub fn command(&mut self, idempotency_key: &str, datasource_id: &str, params: &Json, key: &str, field: &str, value: &Json) -> (&'static str, Option<String>) {
        if self.seen_commands.contains(idempotency_key) { return ("duplicate", None); }
        let Some(cache) = self.registry.cache_for(datasource_id, params) else {
            return ("rejected", Some(format!("no subscription for \"{datasource_id}\"")));
        };
        if key.is_empty() || field.is_empty() { return ("rejected", Some("a write needs key and field".into())); }
        self.seen_commands.insert(idempotency_key.to_string()); // record BEFORE applying
        let mut fields = serde_json::Map::new();
        fields.insert(field.to_string(), value.clone());
        cache.lock().unwrap().upsert(key, &fields);
        self.writes += 1;
        ("applied", None)
    }

    /// Register a datasource config the app bootstrapped the hub with.
    pub fn register_datasource(&mut self, ds: crate::registry::Datasource) -> crate::registry::RegisterStatus {
        self.registry.register(ds)
    }

    pub fn subscribe(&mut self, datasource_id: &str, params: &Json, session_id: &str) -> Result<Acquired, String> {
        let acq = self.registry.acquire(datasource_id, params, session_id)?;
        // First subscriber on this (datasource, params) → open the upstream feed.
        if acq.created {
            if let (Some(tx), Some(ds)) = (&self.ingest_tx, self.registry.datasource(datasource_id).cloned()) {
                let _ = tx.send(crate::ingest::IngestRequest {
                    datasource: ds, params: params.clone(), cache: acq.cache.clone(),
                    shutdown: acq.shutdown.clone(),
                });
            }
        }
        Ok(acq)
    }

    /// Filtered row count over a subscribed table.
    pub fn row_count(&self, datasource_id: &str, params: &Json, filter: &Json) -> Result<usize, String> {
        let cache = self.registry.cache_for(datasource_id, params)
            .ok_or_else(|| format!("no subscription for \"{datasource_id}\""))?;
        let cache = cache.lock().unwrap();
        let f = Filter::from_json(filter);
        Ok(filtered_slots(&cache, &f).len())
    }

    /// Status-bar aggregates over a filtered table.
    pub fn aggregates(&self, datasource_id: &str, params: &Json, specs: &[AggSpec], filter: &Json) -> Result<IndexMap<String, Value>, String> {
        let cache = self.registry.cache_for(datasource_id, params)
            .ok_or_else(|| format!("no subscription for \"{datasource_id}\""))?;
        let cache = cache.lock().unwrap();
        let f = Filter::from_json(filter);
        let slots = filtered_slots(&cache, &f);
        Ok(aggregate_over(&cache, &slots, specs))
    }
}

impl Hub {
    /// Distinct values of a column (over an optional context filter) — set filters.
    pub fn distinct_values(&self, datasource_id: &str, params: &Json, col: &str, ctx: &Json, limit: usize) -> Result<Vec<Json>, String> {
        let cache = self.registry.cache_for(datasource_id, params).ok_or_else(|| format!("no subscription for \"{datasource_id}\""))?;
        let c = cache.lock().unwrap();
        let slots = filtered_slots(&c, &Filter::from_json(ctx));
        Ok(group_slots(&c, &slots, col).into_iter().take(limit).map(|(v, _)| v.to_json()).collect())
    }

    /// Prefix search over a column's distinct values (typeahead).
    pub fn search_values(&self, datasource_id: &str, params: &Json, col: &str, prefix: &str, limit: usize) -> Result<Vec<Json>, String> {
        let all = self.distinct_values(datasource_id, params, col, &serde_json::json!([]), 20_000)?;
        let p = prefix.to_lowercase();
        Ok(all.into_iter()
            .filter(|v| !v.is_null() && json_str(v).to_lowercase().starts_with(&p))
            .take(limit).collect())
    }

    /// Index of a row under a view's filter+sort — what `ensureIndexVisible` needs.
    pub fn rank(&self, datasource_id: &str, params: &Json, key: &str, view: &Json) -> Result<Option<usize>, String> {
        let cache = self.registry.cache_for(datasource_id, params).ok_or_else(|| format!("no subscription for \"{datasource_id}\""))?;
        let c = cache.lock().unwrap();
        let mut slots = filtered_slots(&c, &Filter::from_json(view.get("filter").unwrap_or(&Json::Null)));
        sort_slots(&c, &mut slots, &SortKey::list_from_json(view.get("sort").unwrap_or(&Json::Null)));
        Ok(slots.iter().position(|&s| c.key_at(s).map(|k| k.as_ref()) == Some(key)))
    }

    /// Diagnostics snapshot (architecture §10).
    pub fn stats(&self) -> Json {
        serde_json::json!({
            "datasourceCount": self.registry.datasource_count(),
            "openViews": self.views.len(),
            "writes": self.writes,
            "bundleVersion": self.bundle_version,
            "datasources": self.registry.entry_stats(),
        })
    }
}

fn json_str(v: &Json) -> String {
    match v { Json::String(s) => s.clone(), other => other.to_string() }
}

/// Parse `msg.specs` (`[{column, fn, as?}]`) into aggregate specs.
pub fn parse_agg_specs(specs: &Json) -> Vec<AggSpec> {
    specs.as_array().map(|a| a.iter().filter_map(|s| {
        let o = s.as_object()?;
        let column = o.get("column").and_then(Json::as_str)?.to_string();
        let f = o.get("fn").and_then(Json::as_str)?;
        let agg = Agg::parse(f)?;
        let out = o.get("as").and_then(Json::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{f}({column})"));
        Some(AggSpec { column, agg, out })
    }).collect()).unwrap_or_default()
}
