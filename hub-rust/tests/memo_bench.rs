//! What the view order memo is worth, measured at the shape that motivated it:
//! ten blotters over one 20k-row book, each with its OWN filter, sort and
//! grouping, under a live feed.
//!
//! The comparison is like-for-like in one process. The "re-derive" arm calls the
//! same primitives `View::read_window` used to call on every read
//! (`filtered_slots` then `sort_slots`); the "memo" arm goes through `View`,
//! which now rebuilds that order once per cache revision. Nothing else differs.
//!
//! Run it with output:
//!   cargo test --test memo_bench --release -- --nocapture

use dshub::query::{filtered_slots, sort_slots, Filter, SortKey};
use dshub::store::TableCache;
use dshub::view::{View, ViewSpec};
use serde_json::{json, Value as Json};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const ROWS: usize = 20_000;
const BLOTTERS: usize = 10;
const TICKS: usize = 20;
/// Rows changed per tick — 10k updates/sec conflated into a ~100ms window.
const CHANGED_PER_TICK: usize = 1_000;
/// Block reads each blotter issues per tick (scroll + refresh of loaded blocks).
const READS_PER_TICK: usize = 5;
const BLOCK: usize = 200;

const DESKS: [&str; 4] = ["govies", "credit", "swaps", "repo"];

fn seed() -> Arc<Mutex<TableCache>> {
    let mut c = TableCache::new(["id", "desk", "trader", "ccy", "mv", "qty"]);
    c.begin_batch();
    for i in 0..ROWS {
        c.upsert(
            &format!("P{i}"),
            json!({
                "id": format!("P{i}"),
                "desk": DESKS[i % 4],
                "trader": format!("t{}", i % 25),
                "ccy": if i % 3 == 0 { "USD" } else { "EUR" },
                "mv": (i as f64) * 1.5,
                "qty": (i % 977) as f64,
            })
            .as_object()
            .unwrap(),
        );
    }
    c.end_batch();
    Arc::new(Mutex::new(c))
}

/// Ten blotters, each looking at the book differently — which is the whole point:
/// no two specs coincide, so nothing can be shared between them.
fn specs() -> Vec<Json> {
    (0..BLOTTERS)
        .map(|i| {
            let mut spec = json!({
                "filter": [{ "column": "desk", "op": "equals", "value": DESKS[i % 4] }],
                "sort": [{ "column": if i % 2 == 0 { "mv" } else { "qty" },
                           "sort": if i % 3 == 0 { "desc" } else { "asc" } }],
            });
            // Three of the ten are grouped rather than flat.
            if i % 3 == 1 {
                spec["groupBy"] = json!(["trader"]);
                spec["aggregates"] = json!({ "mv": "sum", "qty": "sum" });
            }
            spec
        })
        .collect()
}

fn tick(cache: &Arc<Mutex<TableCache>>, t: usize) {
    let mut c = cache.lock().unwrap();
    c.begin_batch();
    for k in 0..CHANGED_PER_TICK {
        let i = (t * CHANGED_PER_TICK + k) % ROWS;
        c.upsert(
            &format!("P{i}"),
            json!({ "id": format!("P{i}"), "mv": (i + t) as f64 * 1.7 }).as_object().unwrap(),
        );
    }
    c.end_batch();
}

#[test]
fn memo_is_worth_it_at_ten_blotters() {
    // ---- arm A: re-derive the order on every read (the previous behaviour) ----
    let cache = seed();
    let parsed: Vec<(Filter, Vec<SortKey>)> = specs()
        .iter()
        .map(|s| {
            (
                Filter::from_json(s.get("filter").unwrap_or(&Json::Null)),
                SortKey::list_from_json(s.get("sort").unwrap_or(&Json::Null)),
            )
        })
        .collect();

    let t0 = Instant::now();
    let mut sink = 0usize;
    for t in 0..TICKS {
        tick(&cache, t);
        let c = cache.lock().unwrap();
        for (filter, sort) in &parsed {
            for r in 0..READS_PER_TICK {
                let mut slots = filtered_slots(&c, filter);
                sort_slots(&c, &mut slots, sort);
                let s = (r * BLOCK).min(slots.len());
                let e = (s + BLOCK).min(slots.len());
                sink += slots[s..e].iter().filter_map(|&sl| c.row_json(sl)).count();
            }
        }
    }
    let rederive = t0.elapsed();

    // ---- arm B: the same work through View, which memoizes per revision ----
    let cache = seed();
    let mut views: Vec<View> = specs()
        .iter()
        .map(|s| View::new(cache.clone(), ViewSpec::from_json(s), "s".into()))
        .collect();

    let t0 = Instant::now();
    let mut sink2 = 0usize;
    for t in 0..TICKS {
        tick(&cache, t);
        for v in views.iter_mut() {
            for r in 0..READS_PER_TICK {
                let (rows, _) = v.read_window(r * BLOCK, Some(r * BLOCK + BLOCK));
                sink2 += rows.len();
            }
        }
    }
    let memoized = t0.elapsed();

    let reads = TICKS * BLOTTERS * READS_PER_TICK;
    println!("\n  {ROWS} rows · {BLOTTERS} blotters (own filter/sort/grouping) · {TICKS} ticks");
    println!("  {CHANGED_PER_TICK} rows changed per tick · {READS_PER_TICK} block reads per blotter per tick");
    println!("  {reads} window reads total\n");
    println!("  re-derive per read : {rederive:>10.2?}   ({:>7.3} ms/read)",
             rederive.as_secs_f64() * 1000.0 / reads as f64);
    println!("  memo per revision  : {memoized:>10.2?}   ({:>7.3} ms/read)",
             memoized.as_secs_f64() * 1000.0 / reads as f64);
    println!("  speedup            : {:>10.1}x\n",
             rederive.as_secs_f64() / memoized.as_secs_f64());

    assert!(sink > 0 && sink2 > 0, "both arms must actually read rows");
    assert!(
        memoized < rederive,
        "the memo must not be slower than re-deriving: {memoized:?} vs {rederive:?}"
    );
}
