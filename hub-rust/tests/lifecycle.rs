//! Table lifecycle (engine plan T2): retention decoupled from subscribers,
//! delete / truncate / replace-snapshot primitives, and the superseded-removal
//! rule that makes a replace safe for keys that survive it.
//!
//! Exercised at registry + store level (compiled under every feature set);
//! the wasm entry points wrapping these are pinned end-to-end by stern-bak's
//! `SsrmWasmPlane.wasm.integration.test.ts` against the built pkg/.

use dshub::ingest::apply_message;
use dshub::registry::{Datasource, Registry};
use serde_json::json;

fn ds() -> Datasource {
    Datasource {
        id: "p".into(),
        schema_ref: "p@v1".into(),
        columns: vec!["id".into(), "n".into()],
        key_columns: vec!["id".into()],
        estimated_rows: 10,
        ..Default::default()
    }
}

fn rows(pairs: &[(&str, i64)]) -> serde_json::Value {
    json!(pairs.iter().map(|(id, n)| json!({"id": id, "n": n})).collect::<Vec<_>>())
}

#[test]
fn ingest_pins_the_table_so_it_survives_having_no_subscribers() {
    let mut reg = Registry::new([ds()]);
    let params = json!({});

    // Apply BEFORE any session exists — the old behaviour dropped this.
    let d = ds();
    let cache = reg.ensure_pinned("p", &params).expect("pinned");
    apply_message(&mut cache.lock().unwrap(), &d, &rows(&[("r1", 1), ("r2", 2)]));

    // A session comes, sees the data, and leaves — the table stays.
    let key = Registry::cache_key("p", &params);
    let acq = reg.acquire("p", &params, "s1").expect("acquire");
    assert_eq!(acq.cache.lock().unwrap().len(), 2);
    let freed = reg.release(&key, "s1");
    assert!(!freed, "pinned entry must survive its last viewer");
    assert_eq!(reg.cache_for("p", &params).unwrap().lock().unwrap().len(), 2);

    // Rows applied while zero sessions are subscribed are RETAINED.
    apply_message(&mut reg.cache_for("p", &params).unwrap().lock().unwrap(), &d, &rows(&[("r3", 3)]));
    assert_eq!(reg.cache_for("p", &params).unwrap().lock().unwrap().len(), 3);

    // Provider stop frees it.
    assert!(reg.unpin("p", &params), "unpin with no subscribers frees the cache");
    assert!(reg.cache_for("p", &params).is_none());
}

#[test]
fn unpin_with_live_subscribers_defers_to_the_last_release() {
    let mut reg = Registry::new([ds()]);
    let params = json!({});
    reg.ensure_pinned("p", &params).unwrap();
    let key = Registry::cache_key("p", &params);
    reg.acquire("p", &params, "s1").unwrap();

    assert!(!reg.unpin("p", &params), "a live subscriber holds the entry");
    assert!(reg.cache_for("p", &params).is_some());
    assert!(reg.release(&key, "s1"), "last release frees the unpinned entry");
    assert!(reg.cache_for("p", &params).is_none());
}

#[test]
fn truncate_removes_every_row_in_one_revision_and_logs_the_deletions() {
    let mut reg = Registry::new([ds()]);
    let d = ds();
    let cache = reg.ensure_pinned("p", &json!({})).unwrap();
    let mut c = cache.lock().unwrap();
    apply_message(&mut c, &d, &rows(&[("r1", 1), ("r2", 2), ("r3", 3)]));
    let before = c.revision();

    assert_eq!(c.truncate(), 3);
    assert_eq!(c.len(), 0);
    assert_eq!(c.revision(), before + 1, "one revision for the whole truncation");

    let (slots, removed, _) = c.changed_since(before);
    assert!(slots.is_empty());
    let mut removed = removed;
    removed.sort();
    assert_eq!(removed, vec!["r1", "r2", "r3"], "the delta stream sees the truncation");
}

#[test]
fn replace_shrinks_the_table_and_never_removes_a_surviving_key() {
    let mut reg = Registry::new([ds()]);
    let d = ds();
    let cache = reg.ensure_pinned("p", &json!({})).unwrap();
    let mut c = cache.lock().unwrap();
    apply_message(&mut c, &d, &rows(&[("r1", 1), ("r2", 2), ("r3", 3)]));
    let before = c.revision();

    // The restart snapshot lost r2 and r3, changed r1, added r4 — the
    // replace_snapshot wasm wrapper does exactly this under one batch.
    c.begin_batch();
    c.truncate();
    apply_message(&mut c, &d, &rows(&[("r1", 10), ("r4", 4)]));
    c.end_batch();

    assert_eq!(c.len(), 2, "exactly the new snapshot");
    let (slots, mut removed, _) = c.changed_since(before);
    removed.sort();
    // r1 survived the replace: it must ride the upserts, NEVER the removals —
    // client transactions apply update+remove together, and a stale removal
    // would delete the live row.
    assert_eq!(removed, vec!["r2", "r3"]);
    let upserted: Vec<String> = slots.iter()
        .filter_map(|&s| c.key_at(s).map(|k| k.to_string()))
        .collect();
    assert!(upserted.contains(&"r1".to_string()));
    assert!(upserted.contains(&"r4".to_string()));
}

#[test]
fn deleted_then_reinserted_key_is_an_upsert_not_a_removal() {
    let mut reg = Registry::new([ds()]);
    let d = ds();
    let cache = reg.ensure_pinned("p", &json!({})).unwrap();
    let mut c = cache.lock().unwrap();
    apply_message(&mut c, &d, &rows(&[("r1", 1)]));
    let before = c.revision();

    c.delete("r1");
    apply_message(&mut c, &d, &rows(&[("r1", 2)]));

    let (slots, removed, _) = c.changed_since(before);
    assert!(removed.is_empty(), "the re-insert supersedes the delete");
    assert_eq!(slots.len(), 1);
}
