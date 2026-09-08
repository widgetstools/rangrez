//! The DataSource Hub, native host.
//!
//! A cache-and-publish layer: cache data from upstream datasources, publish
//! updates to browser/OpenFin clients over socket.io. Multi-tenant — one shared
//! table cache per (datasource, params) key, many subscribers each with their
//! own view. Built for Rust 1.78 (no edition-2024 dependencies).

pub mod socketio;
pub mod store;
pub mod query;
pub mod registry;
pub mod session;
pub mod hub;
pub mod control;
pub mod server;
pub mod ingest;
pub mod dsl;
pub mod alerts;
pub mod view;
pub mod delta;
pub mod groupwatch;
pub mod flow;
// Native ingest transports (STOMP/socket.io/REST over real sockets) — the wasm
// build ingests via the JS worker's own WebSocket + apply_message instead.
#[cfg(feature = "native")]
pub mod transports;
// The in-browser wasm-bindgen surface — the whole hub as a Web Worker engine.
#[cfg(feature = "wasm")]
pub mod wasm;
