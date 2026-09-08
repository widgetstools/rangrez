//! The registry — multi-tenancy made concrete.
//!
//! One `Entry` per (datasource, params) key, holding ONE shared cache behind an
//! `Arc<Mutex<..>>`. Every subscriber on the same key attaches to that same
//! cache; the data is stored once no matter how many blotters read it. This is
//! the "superset sharing" the JS hub does — one upstream, many subscribers — and
//! the reason the sidecar can serve a desk without N copies of a 500k-row book.

use crate::store::TableCache;
use serde_json::Value as Json;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// A datasource definition — the config the APP bootstraps the hub with. It
/// carries the schema (columns/keys) AND the opaque upstream `connection` spec
/// the ingest layer will use to actually connect. `checksum` is what two apps'
/// configs are reconciled on.
#[derive(Clone, Default)]
pub struct Datasource {
    pub id: String,
    pub schema_ref: String,
    pub columns: Vec<String>,
    pub key_columns: Vec<String>,
    pub estimated_rows: u64,
    /// Opaque upstream connection spec (transport, url, topics, snapshot mode…),
    /// stored at bootstrap for the ingest layer to consume.
    pub connection: Json,
    /// The full datasource config as pushed — the ingest layer reads `updates`,
    /// `snapshot`, `opField`, `bodyShape` etc. from here.
    pub config: Json,
    /// Reconcile key — identical configs share, different ones conflict.
    pub checksum: String,
}

/// The outcome of registering a datasource config at bootstrap.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RegisterStatus {
    /// New datasource — the hub now knows how to serve it.
    Registered,
    /// Already present with the SAME config — this app attaches to it.
    Shared,
    /// Already present with a DIFFERENT config — surfaced, NOT overwritten.
    Conflict,
}

impl RegisterStatus {
    pub fn as_str(&self) -> &'static str {
        match self { RegisterStatus::Registered => "registered", RegisterStatus::Shared => "shared", RegisterStatus::Conflict => "conflict" }
    }
}

/// A shared cache and its subscribers.
pub struct Entry {
    pub key: String,
    pub datasource_id: String,
    pub schema_ref: String,
    pub cache: Arc<Mutex<TableCache>>,
    pub subscribers: HashSet<String>,
    pub estimated_rows: u64,
    /// Set when the last subscriber leaves — the ingestor watches it to stop.
    pub shutdown: Arc<AtomicBool>,
}

/// What a subscribe hands back — a cloned handle to the shared cache, no borrow.
pub struct Acquired {
    pub table_name: String,
    pub schema_ref: String,
    pub estimated_rows: u64,
    pub cache: Arc<Mutex<TableCache>>,
    pub created: bool,
    pub shutdown: Arc<AtomicBool>,
}

pub struct Registry {
    datasources: HashMap<String, Datasource>,
    entries: HashMap<String, Entry>,
}

impl Registry {
    pub fn new(datasources: impl IntoIterator<Item = Datasource>) -> Registry {
        let datasources = datasources.into_iter().map(|d| (d.id.clone(), d)).collect();
        Registry { datasources, entries: HashMap::new() }
    }

    /// An empty registry — the hub starts knowing no datasources and is
    /// bootstrapped by the app that connects.
    pub fn empty() -> Registry { Registry { datasources: HashMap::new(), entries: HashMap::new() } }

    /// Register a datasource config pushed by an app at bootstrap.
    ///
    /// Reconciled on `checksum`: a brand-new id is `Registered`; the same id with
    /// the same config is `Shared` (the app just attaches to what is already
    /// there); the same id with a DIFFERENT config is a `Conflict` and the
    /// existing definition is kept — the hub never silently adopts one app's
    /// divergent config and serves it to everyone else on the table.
    pub fn register(&mut self, ds: Datasource) -> RegisterStatus {
        match self.datasources.get(&ds.id) {
            None => { self.datasources.insert(ds.id.clone(), ds); RegisterStatus::Registered }
            Some(existing) if existing.checksum == ds.checksum => RegisterStatus::Shared,
            Some(_) => RegisterStatus::Conflict,
        }
    }

    pub fn is_registered(&self, id: &str) -> bool { self.datasources.contains_key(id) }
    pub fn datasource_count(&self) -> usize { self.datasources.len() }

    /// Force-apply a config (hot reload / pushConfig): replaces an existing
    /// definition instead of surfacing a conflict. Returns the reload class the
    /// change implies — a schema change is a `rebuild`, an unchanged config is
    /// `none`, a new datasource is `added`.
    pub fn replace_datasource(&mut self, ds: Datasource) -> &'static str {
        match self.datasources.get(&ds.id) {
            None => { self.datasources.insert(ds.id.clone(), ds); "added" }
            Some(existing) if existing.checksum == ds.checksum => "none",
            Some(existing) => {
                let schema_changed = existing.columns != ds.columns || existing.key_columns != ds.key_columns;
                self.datasources.insert(ds.id.clone(), ds);
                if schema_changed { "rebuild" } else { "resubscribe" }
            }
        }
    }

    /// Canonical params: sorted keys, so `{a:1,b:2}` and `{b:2,a:1}` share a key.
    pub fn canonical_params(params: &Json) -> String {
        match params.as_object() {
            Some(obj) => {
                let sorted: BTreeMap<_, _> = obj.iter().collect();
                serde_json::to_string(&sorted).unwrap_or_default()
            }
            None => params.to_string(),
        }
    }

    pub fn cache_key(datasource_id: &str, params: &Json) -> String {
        format!("{datasource_id}#{}", Self::canonical_params(params))
    }

    /// Number of shared caches currently held (one per active key).
    pub fn entry_count(&self) -> usize { self.entries.len() }

    pub fn datasource(&self, id: &str) -> Option<&Datasource> { self.datasources.get(id) }

    /// Subscribe a session to a (datasource, params). Creates the shared cache on
    /// first subscriber, then adds this session to the subscriber set.
    pub fn acquire(&mut self, datasource_id: &str, params: &Json, session_id: &str) -> Result<Acquired, String> {
        let ds = self.datasources.get(datasource_id)
            .ok_or_else(|| format!("unknown datasource \"{datasource_id}\""))?
            .clone();
        let key = Self::cache_key(datasource_id, params);

        let created = !self.entries.contains_key(&key);
        let entry = self.entries.entry(key.clone()).or_insert_with(|| Entry {
            key: key.clone(),
            datasource_id: ds.id.clone(),
            schema_ref: ds.schema_ref.clone(),
            cache: Arc::new(Mutex::new(TableCache::new(ds.columns.iter()))),
            subscribers: HashSet::new(),
            estimated_rows: ds.estimated_rows,
            shutdown: Arc::new(AtomicBool::new(false)),
        });
        entry.subscribers.insert(session_id.to_string());
        Ok(Acquired {
            table_name: key,
            schema_ref: entry.schema_ref.clone(),
            estimated_rows: entry.estimated_rows,
            cache: entry.cache.clone(),
            created,
            shutdown: entry.shutdown.clone(),
        })
    }

    /// Drop a session from a key. When the last subscriber leaves, the shared
    /// cache is released — its memory returns to the process.
    pub fn release(&mut self, key: &str, session_id: &str) -> bool {
        let Some(entry) = self.entries.get_mut(key) else { return false; };
        entry.subscribers.remove(session_id);
        if entry.subscribers.is_empty() {
            entry.shutdown.store(true, Ordering::Relaxed); // stop the ingestor
            self.entries.remove(key);
            true // the cache was freed
        } else {
            false
        }
    }

    pub fn entry(&self, key: &str) -> Option<&Entry> { self.entries.get(key) }

    /// Per-datasource diagnostics: subscribers and current cached row count.
    pub fn entry_stats(&self) -> Vec<Json> {
        self.entries.values().map(|e| {
            let rows = e.cache.lock().map(|c| c.len()).unwrap_or(0);
            serde_json::json!({
                "datasourceId": e.datasource_id,
                "schemaRef": e.schema_ref,
                "subscribers": e.subscribers.len(),
                "cacheRows": rows,
            })
        }).collect()
    }

    /// The shared cache for a (datasource, params), if any session holds it.
    pub fn cache_for(&self, datasource_id: &str, params: &Json) -> Option<Arc<Mutex<TableCache>>> {
        self.entries.get(&Self::cache_key(datasource_id, params)).map(|e| e.cache.clone())
    }
}
