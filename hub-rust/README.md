# hub-rust

The DataSource Hub engine: a keyed columnar cache plus a query engine over it,
built once and hosted two ways — a native sidecar (`dshub-sidecar-rs`, sockets and
threads via tungstenite) and an in-browser SharedWorker (wasm, driven over a
MessagePort). Parity with the JS/Perspective path in `packages/dshub-worker` is
held by the conformance corpus, not by inspection.

## Building

### Native (tests, sidecar)

```sh
cargo test          # 51 lib tests + the integration suites
cargo build --release
```

`rust-toolchain.toml` pins **1.78.0**, and that pin is load-bearing: several
dependencies are held at pre-edition-2024 versions (`indexmap =2.2.6`,
`hashbrown =0.14.5`) so the graph stays buildable on it. See `Cargo.toml` for
why there is no `perspective-server` in here.

### wasm

```sh
cargo build --release --target wasm32-unknown-unknown --no-default-features --features wasm
wasm-bindgen target/wasm32-unknown-unknown/release/dshub.wasm --target web --out-dir pkg
```

**Install the CLI with stable, not the pinned toolchain:**

```sh
cargo +stable install wasm-bindgen-cli --version 0.2.100
```

`cargo install wasm-bindgen-cli` run from inside this directory picks up the
1.78 pin and fails — the CLI's own dependency graph now requires edition 2024
(Cargo ≥ 1.85). This is not a conflict: the CLI only post-processes the emitted
`.wasm`, so it has to match the **`wasm-bindgen` crate version** (`=0.2.100` in
`Cargo.toml`) and not the compiler that produced the module. Building the CLI
with a newer toolchain is therefore correct, and bumping the crate version means
reinstalling the CLI at the matching version in the same change.

`pkg/` is **committed**. It is the artefact consumers load, and a wasm binary
with no traceable source revision is not something to ship.

## Tests

| Suite | Covers |
|---|---|
| `conformance`, `parity`, `dsl_parity` | Rust output == the TS reference in `dshub-worker` |
| `features` | SSRM view/group/expand, deltas, the write path, distinct/search/rank |
| `groupdelta` | group-aggregate diffing (`watchGroups`) |
| `backpressure` | seq-stamped ticks and ack-based slow-consumer handling |
| `ingest_robust`, `ingest_transports` | frame splitting, body shapes, malformed input |
| `memo_bench` | what the view memos are worth at ten blotters over 20k rows |

**Known issue:** `tests/ingest_live.rs` hangs after its first test — it blocks
waiting on its own mock feed. Pre-existing. Run the suites individually, or
`cargo test --tests -- --skip ingest_live`, until it is fixed; a full
`cargo test` will not terminate.

## Performance notes

Two invariants the query path depends on, both easy to break by accident:

- **A revision is per ingest batch, not per row** (`TableCache::begin_batch`).
  While `rev` advanced per row, anything stamped with it — a memo, a
  materialized order — was stale before it could be read twice.
- **A `View` memoizes its slot order per revision, and its flattened group tree
  per (revision, expansion)**. Expansion changes which rows are *visible*, never
  which pass the filter, so expanding rebuilds the tree and not the order.

`cargo test --test memo_bench --release -- --nocapture` prints the current
numbers at 20k rows × 10 blotters.
