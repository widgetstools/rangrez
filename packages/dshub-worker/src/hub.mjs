/**
 * The hub: registry + adapters + table actors, shared across every connected
 * port.
 *
 * This is what makes "one stop shop" real. Two tabs asking for the same
 * (datasourceId, params) get ONE upstream subscription and ONE table between
 * them — the refcount in the registry is the mechanism, and the SharedWorker is
 * what lets them share at all.
 *
 * Host-agnostic: no SharedWorker or WebSocket references. `openSocket` and the
 * engine are injected, so the same class runs under Node in tests.
 */

import { Registry } from './registry.mjs';
import { TableActor, STATE } from './table_actor.mjs';
import { createNormalizer } from './normalize.mjs';
import { StompAdapter } from './adapters/stomp.mjs';
import { WsAdapter } from './adapters/ws.mjs';
import { SocketIoAdapter } from './adapters/socketio.mjs';
import { RestAdapter } from './adapters/rest.mjs';
import { DatasourceStats, rungFor } from './stats.mjs';
import { SubscriberFlow } from './flow.mjs';
import { ReconnectDiffer } from './reconnect.mjs';
import { GroupAggregateDiffer, groupDeltaMessage } from './groupwatch.mjs';
import { AlertWatcher, alertMessage } from './alerts.mjs';
import { parse } from '../../dshub-spec/src/dsl/parse.mjs';
import { compileFilterOps } from '../../dshub-spec/src/dsl/compile.mjs';

/**
 * Browser-reachable transports only.
 *
 * `amps` and `solace` are deliberately absent: neither speaks a protocol a
 * browser can open, so they wait for the Rust sidecar (architecture §2.2). A
 * datasource configured for one gets the explicit `transport-unavailable` below
 * rather than a confusing connection failure.
 */
const ADAPTERS = {
  stomp: StompAdapter,
  ws: WsAdapter,
  socketio: SocketIoAdapter,
  rest: RestAdapter,
};

/**
 * REST carries its snapshot over HTTP and its updates over another transport,
 * so it needs a way to build that second adapter without this module wiring
 * every combination by hand.
 */
const updateAdapterFactory = (openSocket) => (connection, datasource, opts) => {
  const kind = connection.updatesKind ?? 'ws';
  const Adapter = ADAPTERS[kind];
  if (!Adapter || Adapter === RestAdapter) {
    throw Object.assign(new Error(`"${kind}" cannot carry updates for a rest datasource`), { code: 'transport-unavailable' });
  }
  if (!connection.updatesUrl) {
    // The REST base is an http:// endpoint; opening a socket against it fails
    // in a way that looks like the server being down.
    throw Object.assign(
      new Error(`connection "${connection.id}" is rest-then-subscribe but has no updatesUrl`),
      { code: 'config-invalid' }
    );
  }
  return new Adapter({
    connection: { ...connection, kind, url: connection.updatesUrl },
    datasource: { ...datasource, snapshot: { mode: 'subscribe-only' } },
    ...opts,
    openSocket,
  });
};

const entryKeyOf = (ref) => `${ref.datasourceId}`;

export class Hub {
  /**
   * @param {object} o
   * @param {object} o.bundle        validated config bundle
   * @param {(name:string, opts:object)=>Promise<object>} o.createTable  engine seam
   * @param {(url:string)=>object} o.openSocket
   */
  constructor({ bundle, createTable, createView, watchTable, watchView, openSocket, processCeilingBytes, artifacts = {} }) {
    /** Optional: subscribe to engine deltas and forward them to subscribers. */
    this.watchTable = watchTable;
    /** Engine seam: watch ONE view's on_update. Optional; without it, no group deltas (§8e). */
    this.watchView = watchView;
    /** Engine seam for per-subscriber views. Optional; without it, no filtering. */
    this.createView = createView;
    this.bundle = bundle;
    /** datasourceId -> schema artifact. A table cannot be built without one. */
    this.artifacts = artifacts;
    this.createTable = createTable;
    this.openSocket = openSocket;
    this.registry = new Registry(processCeilingBytes ? { processCeilingBytes } : {});
    this.entries = new Map();   // cacheKey -> { adapter, actor, table, state, subscribers:Set }
    this.sessions = new Set();
    this.log = [];
    /**
     * Long-lived views, keyed by id.
     *
     * SSRM holds one per expanded node, so these are SESSION-SCOPED: a tab that
     * closes with twenty expanded groups must not leave twenty views behind.
     * That is the leak the parity study warns shows up two weeks into UAT.
     */
    this.views = new Map();
    this.viewSeq = 0;
  }

  configMeta() {
    return { bundleVersion: this.bundle?.bundleVersion ?? 0, bundleChecksum: this.bundle?.checksum };
  }
  configBundle() { return this.bundle; }

  connection(id) {
    const c = this.bundle.connections.find((x) => x.id === id);
    if (!c) throw Object.assign(new Error(`unknown connection "${id}"`), { code: 'config-invalid' });
    return c;
  }
  datasource(id) {
    const d = this.bundle.datasources.find((x) => x.id === id);
    if (!d) throw Object.assign(new Error(`unknown datasource "${id}"`), { code: 'unknown-datasource' });
    return d;
  }

  /**
   * Acquire a subscription. The FIRST subscriber creates the upstream
   * connection; every later one joins the existing table.
   */
  /**
   * Resolve a datasource's schema artifact.
   *
   * By `schemaRef` FIRST, then by id. `schemaRef` is what lets several
   * datasources share one schema, which is exactly the multi-transport case:
   * `positions`, `positions-ws` and `positions-rest` are the same book arriving
   * three ways and must not need three copies of a 372-column artifact.
   *
   * Looking up by id alone meant any datasource whose id differed from its
   * schema name got no artifact, and failed with "cannot build a table schema
   * from an artifact with no columns" — which points at the artifact rather
   * than at the lookup.
   */
  artifactFor(ds) {
    if (!ds) return undefined;
    const ref = ds.schemaRef;
    return (ref && (this.artifacts[ref] ?? this.artifacts[String(ref).split('@')[0]]))
      ?? this.artifacts[ds.id];
  }

  /** Per-session flow state, created on first use. */
  flowFor(session) {
    if (!session.__flow) {
      session.__flow = new SubscriberFlow({
        session,
        limit: this.flowLimit ?? 500,
        conflateMs: this.conflateMs ?? 250,
      });
    }
    return session.__flow;
  }

  /**
   * Drop a subscriber that has stopped consuming.
   *
   * A typed error, not a silent removal: from the tab's side an unexplained
   * stop is indistinguishable from a dead feed, and it will sit showing stale
   * prices believing they are current.
   *
   * Only this session is touched. Everyone else on the table keeps its data —
   * that is the whole point of the ladder being per subscriber.
   */
  dropSlowSubscriber(key, session, flow) {
    const e = this.entries.get(key);
    session.send?.({
      id: `e-${key}`, type: 'error', code: 'backpressure-disconnect',
      message: `subscription dropped: ${flow.lag} deltas unapplied (limit ${flow.limit})`,
      ref: { datasourceId: key.split('#')[0] },
    });
    e?.subscribers.delete(session);
    session.subscriptions?.delete(key);
    this.slowDrops = (this.slowDrops ?? 0) + 1;
  }

  /**
   * Read the table as key -> row.
   *
   * Deliberately NOT a mirror kept alongside the table: at 500k rows that would
   * roughly double the memory this system spends most of its budget defending.
   * Paid once per reconnect, in the worker, to spare every open tab a full
   * repaint.
   */
  async readTableByKey(table) {
    if (!this.createView) return null;
    const view = await this.createView(table, {});
    try {
      const columns = await view.to_columns();
      const keys = columns.__key ?? [];
      const names = Object.keys(columns);
      const out = new Map();
      for (let i = 0; i < keys.length; i++) {
        const row = {};
        for (const n of names) row[n] = columns[n][i];
        out.set(keys[i], row);
      }
      return out;
    } finally {
      try { await view.delete?.(); } catch { /* already gone */ }
    }
  }

  async subscribe(ref, session, opts = {}) {
    const ds = this.datasource(ref.datasourceId);

    // Admission needs real numbers. The datasource config carries neither a row
    // estimate nor a column count — both live in the schema artifact, which is
    // the point of the artifact. Without this the registry sizes every table at
    // zero bytes and the process ceiling silently never fires.
    const artifact = this.artifactFor(ds);
    const sized = {
      ...ds,
      estimatedRows: ds.estimatedRows ?? artifact?.estimatedRows ?? 0,
      columnCount: artifact ? artifact.columns.length : 1,
    };
    const entry = this.registry.acquire(sized, ref.params ?? {});

    if (!this.entries.has(entry.key)) {
      const table = await this.createTable(entry.key, {
        index: '__key',
        artifact: this.artifactFor(ds),
        softDeleteColumn: ds.softDelete?.column,
      });
      const normalizer = createNormalizer(ds, null);
      const dsStats = new DatasourceStats({ datasourceId: ds.id });
      const actor = new TableActor({
        table,
        batch: ds.batch ?? {},
        /**
         * The actor is NOT the state publisher.
         *
         * The adapter owns the externally visible lifecycle and emits every one
         * of connecting/snapshotting/live/stale/recovering/failed WITH detail
         * (the URL, the listen topic, the row count). The actor transitions
         * through the same states for its own bookkeeping, so forwarding those
         * too published every transition TWICE — once bare from the actor, then
         * again with detail from the adapter.
         *
         * FAILED is the exception and must still get out: the actor checks the
         * snapshot row count against what it was told to expect, which the
         * adapter cannot see.
         */
        onState: (s, d) => { if (s === STATE.FAILED) this.publishState(entry.key, s, d); },
      });

      const Adapter = ADAPTERS[this.connection(ds.connectionRef).kind];
      if (!Adapter) {
        throw Object.assign(
          new Error(`transport "${this.connection(ds.connectionRef).kind}" is not available in the worker host (architecture §2.2)`),
          { code: 'transport-unavailable' }
        );
      }

      // Transport params (clientId/rate/batchSize) come from config defaults;
      // a subscriber should not have to know them to ask for a slice of data.
      const defaults = Object.fromEntries(
        Object.entries(ds.params ?? {})
          .filter(([, spec]) => spec.default !== undefined)
          .map(([k, spec]) => [k, spec.default])
      );
      const adapter = new Adapter({
        connection: this.connection(ds.connectionRef),
        fetchImpl: this.fetchImpl,
        makeUpdateAdapter: updateAdapterFactory(this.openSocket),
        datasource: ds,
        params: { ...defaults, ...(ref.params ?? {}) },
        openSocket: this.openSocket,
        onRows: (rows) => {
          dsStats.onMessage(rows.length);
          const t0 = Date.now();
          /**
           * A malformed row is DROPPED and COUNTED, not fatal.
           *
           * `normalize` reads the payload with Object.entries, so a null or
           * undefined row throws — and because ingestion sits behind one catch
           * per transport, one bad record took the whole datasource down with a
           * message pointing at the normalizer rather than at the feed. A feed
           * that emits the occasional null (JSON.stringify turns a hole in an
           * array into one) should cost that row, not the book.
           */
          const normalized = [];
          for (const r of rows) {
            if (r === null || r === undefined || typeof r !== 'object') { dsStats.malformed = (dsStats.malformed ?? 0) + 1; continue; }
            try { normalized.push(normalizer.normalize(r).rows[0]); }
            catch (e) {
              dsStats.malformed = (dsStats.malformed ?? 0) + 1;
              dsStats.lastMalformed = String(e.message).slice(0, 160);
            }
          }
          // During a RE-snapshot the rows are held aside and diffed; on the
          // first snapshot there is nothing to diff against, so they go
          // straight in.
          if (differ.active) { differ.collect(normalized); return; }
          const ok = actor.push(normalized);
          if (!ok) dsStats.dropped += rows.length;
          dsStats.onFlush(rows.length, Date.now() - t0);
          dsStats.rung = rungFor(actor.queue.length, actor.queueLimit);
        },
        onState: (s, detail) => {
          // The adapter drives the actor's snapshot lifecycle: it is the only
          // thing that knows when the sentinel arrived.
          if (s === STATE.SNAPSHOTTING) {
            if (actor.state === STATE.IDLE) actor.transition(STATE.CONNECTING);
            // A snapshot that follows a live period is a RECONNECT, and is
            // diffed. The first one has nothing to compare against.
            if (actor.rowsOut > 0) differ.begin();
            actor.beginSnapshot(ds.updates?.updatesDuringSnapshot ?? 'buffer');
          } else if (s === STATE.LIVE && actor.state === STATE.SNAPSHOTTING) {
            if (differ.active) {
              // The diff is async (the baseline comes out of Perspective), so
              // `live` must wait for it — publishing live first would let a
              // client query a table the reconnect has not yet reconciled.
              differ.end().then(({ upserts, removals }) => {
                if (upserts.length || removals.length) actor.push([...upserts, ...removals]);
                dsStats.reconnectDiff = { ...differ.stats };
                actor.endSnapshot();
                dsStats.onState(s, detail);
                this.publishState(entry.key, s, detail);
              });
              return;
            }
            // endSnapshot may be async (Perspective's update is). Publish `live`
            // only once it settles, or subscribers read an empty table.
            const done = actor.endSnapshot();
            if (done && typeof done.then === 'function') {
              // Record the state on BOTH paths. An early return here left the
              // stats stuck at `snapshotting` for a datasource that was live —
              // diagnostics showing the wrong state is worse than no
              // diagnostics, because it sends someone hunting the wrong fault.
              done.then(() => {
                dsStats.onState(s, detail);
                this.publishState(entry.key, s, detail);
              });
              return;
            }
          }
          dsStats.onState(s, detail);
          this.publishState(entry.key, s, detail);
        },
      });

      /**
       * A re-snapshot after an outage is overwhelmingly the SAME data, so it is
       * diffed rather than trusted. Pushing it straight in makes Perspective
       * report every row as changed and CSRM repaint the whole grid — scroll
       * jump, selection disturbed — for a handful of real moves (§5.7).
       */
      const differ = new ReconnectDiffer({
        snapshotOfTable: () => this.readTableByKey(table),
        softDeleteColumn: ds.softDelete?.column,
      });

      this.entries.set(entry.key, { adapter, actor, table, differ, stats: dsStats, subscribers: new Set(), state: STATE.IDLE, params: ref.params ?? {} });

      // Forward engine deltas to every subscriber of this table.
      if (this.watchTable) {
        // `wantsColumns` lets the engine SKIP the per-update delta decode when
        // no subscriber actually needs the rows. SSRM/VRM subscribe with
        // delivery:'notify' and only want the "something changed" signal —
        // decoding each delta into a fresh Perspective table (at ~20 flushes/sec
        // on a wide book) saturates the single wasm thread and collapses the
        // feed to ~1 Hz. When only notify subscribers are attached the engine
        // passes `null` and this just fans out a lightweight signal.
        const wantsColumns = () =>
          [...(this.entries.get(entry.key)?.subscribers ?? [])].some((s) => s.delivery !== 'notify');

        const dispatch = (columns) => {
          const ref = { datasourceId: ds.id };
          const subs = [...(this.entries.get(entry.key)?.subscribers ?? [])];

          // Signal-only path: the engine skipped the decode (no row subscriber).
          if (columns === null) {
            if (!subs.length) return;
            const notify = { id: `d-${entry.key}`, type: 'rowDelta', ref };
            for (const s of subs) if (s.delivery === 'notify') s.send?.(notify);
            return;
          }

          const rows = columns?.__key?.length ?? Object.values(columns ?? {})[0]?.length ?? 0;
          if (!rows) return;
          let notify = null;
          const base = { id: `d-${entry.key}`, type: 'rowDelta', ref, columns, rows };

          for (const s of subs) {
            if (s.delivery === 'notify') {
              // Count only. A VRM client re-reads its own viewport, so the rows
              // would be decoded and dropped — at 2,000 rows/sec that is the
              // whole feed crossing the wire to be thrown away. There is nothing
              // to conflate and nothing to fall behind on.
              notify ??= { id: `d-${entry.key}`, type: 'rowDelta', ref, rows };
              s.send?.(notify);
              continue;
            }

            // Row subscribers go through the ladder (architecture §7.4).
            const flow = this.flowFor(s);
            const verdict = flow.offer(base);
            if (verdict.action === 'send' && verdict.message) s.send?.(verdict.message);
            else if (verdict.action === 'refresh') {
              s.send?.({ id: `r-${entry.key}`, type: 'refresh', ref, reason: 'backpressure',
                         detail: `${flow.lag} deltas behind; re-read the view` });
            } else if (verdict.action === 'drop') {
              this.dropSlowSubscriber(entry.key, s, flow);
            }
          }
        };

        const stop = await this.watchTable(table, dispatch, wantsColumns);
        this.entries.get(entry.key).stopWatch = stop;
      }

      adapter.connect();
    }

    const e = this.entries.get(entry.key);
    // Per-session, not per-entry: one tab may hold a CSRM grid and a VRM tree
    // against the same table and each wants a different delta shape.
    session.delivery = opts.delivery ?? 'rows';
    e.subscribers.add(session);
    (session.subscriptions ??= new Set()).add(entry.key);

    /**
     * Superset sharing: ONE table, a DEDICATED VIEW per subscriber.
     *
     * The params the superset wildcards are exactly the ones that become the
     * subscriber's filter. Ten desks on one book cost one upstream subscription
     * and one table — ten tables would be ten snapshots of the same data.
     *
     * NOTE: the view is a convenience, not a security boundary. Entitlement is
     * enforced separately (architecture §6.1) and is deferred in v1.
     */
    let viewFilter = null;
    if (entry.supersetParams) {
      viewFilter = Object.entries(ref.params ?? {})
        .filter(([k]) => entry.supersetParams[k] === '*')
        .map(([k, v]) => [k, '==', v]);
    }

    let view = null;
    if (viewFilter?.length && this.createView) {
      view = await this.createView(e.table, { filter: viewFilter });
      (e.views ??= new Map()).set(session, view);
    }

    /**
     * Replay the CURRENT state to the joining session.
     *
     * `state` messages are transitions, so a subscriber that arrives after the
     * table is already live hears nothing and waits for an event that has
     * already happened. That is the second tab onto a shared datasource — the
     * exact case the SharedWorker exists for — so the first tab worked and
     * every one after it hung.
     *
     * Sent AFTER the view exists: a client may query the moment it reads
     * `live`, and a view that is not yet open would fail that first query.
     */
    if (e.state && e.state !== STATE.IDLE) {
      session.send?.({
        id: `evt-join-${entry.key}`, type: 'state',
        ref: { datasourceId: ds.id }, state: e.state, detail: { replay: true },
      });
    }

    return {
      tableName: entry.key,
      schemaRef: ds.schemaRef,
      mode: sized.estimatedRows > 200_000 ? 'ssrm' : 'csrm',
      estimatedRows: sized.estimatedRows,
      shared: e.subscribers.size > 1,
      viewFilter,
      views: e.views?.size ?? 0,
    };
  }

  /**
   * Release. The upstream connection is torn down only when the LAST subscriber
   * leaves — and even then on the idle timer, so closing and reopening a
   * blotter does not force a re-snapshot.
   */
  async unsubscribe(ref, session) {
    const ds = this.datasource(ref.datasourceId);
    const entry = this.registry.find(ds.id, ref.params ?? {});
    if (!entry) return;
    const e = this.entries.get(entry.key);
    e?.subscribers.delete(session);
    session.subscriptions?.delete(entry.key);
    // A view left open per departed subscriber is exactly the leak that shows
    // up as worker memory growth two weeks into UAT.
    const v = e?.views?.get(session);
    if (v) { try { await v.delete?.(); } catch {} e.views.delete(session); }

    this.registry.release(ds.id, ref.params ?? {}, () => {
      this.teardown(entry.key);
    });
  }

  /** Drop everything a disconnecting port held. */
  async releaseSession(session) {
    // Views first: a tab that closed with twenty expanded groups must not leave
    // twenty views behind.
    await this.disposeSessionViews(session);
    for (const key of session.subscriptions ?? []) {
      const e = this.entries.get(key);
      e?.subscribers.delete(session);
      const [datasourceId] = key.split('#');
      const entry = [...this.registry.entries.values()].find((x) => x.key === key);
      if (entry) {
        this.registry.release(datasourceId, entry.params, () => {
          this.teardown(key);
        });
      }
    }
    this.sessions.delete(session);
  }

  /**
   * Release everything one table entry holds, in REVERSE DEPENDENCY ORDER.
   *
   * Perspective's docs are explicit: delete Views before the Table they depend
   * on, or `delete()` throws. And a Table that is never deleted is simply a
   * leak — the engine has no GC for it, so an idle-torn-down datasource would
   * keep its full memory until the worker died.
   */
  /**
   * Hot reload (architecture §3.8). Apply a new config to the RUNNING hub.
   *
   * The point is that not every edit costs the same. A conflation interval must
   * take effect on the next tick without dropping a single row; changing key
   * columns invalidates every row identity and needs the table rebuilt and its
   * clients re-initialised. The reload PLAN — computed from the schema's
   * `x-reloadClass` annotations, not hand-listed here — decides which.
   *
   * The plan is computed by `this.reloadPlanner`, injected so the schema-loading
   * lives at the edge and the hub core stays testable without it. Computed, not
   * passed in: a caller that could hand the hub a weaker class than the edit
   * really is would turn a rebuild into a silent live-poke and leave the grid
   * addressing rows that no longer exist.
   *
   * @returns {Promise<{plan: object, applied: object[]}>}
   */
  async applyConfig(nextBundle) {
    const prev = this.bundle;
    const { plans } = this.reloadPlanner
      ? this.reloadPlanner(prev, nextBundle)
      : { plans: [] };

    // New config is authoritative for FUTURE subscribers immediately, whatever
    // happens to the running entries below.
    this.bundle = nextBundle;
    this.bundleVersion = nextBundle.bundleVersion ?? this.bundleVersion;

    const applied = [];
    for (const p of plans) {
      if (p.collection !== 'datasources' && p.collection !== 'connections') continue;
      // A connection change reloads the datasource(s) that reference it.
      const dsIds = p.collection === 'datasources'
        ? [p.id]
        : (nextBundle.datasources ?? []).filter((d) => d.connectionRef === p.id).map((d) => d.id);

      for (const dsId of dsIds) {
        /**
         * A live entry's key is `datasourceId#<superset params>`, not the bare
         * id — superset sharing folds several param sets onto one table. So the
         * running entries for a datasource are every key that starts with its
         * id, and a change touches all of them.
         */
        const running = [...this.entries.entries()].filter(([k]) => k === dsId || k.startsWith(`${dsId}#`));
        if (!running.length) { applied.push({ id: dsId, reload: p.reload, action: 'not-running' }); continue; }

        for (const [key, entry] of running) {
          if (p.reload === 'live') {
            this.applyLive(entry, this.datasource(dsId));
            applied.push({ id: dsId, reload: 'live', action: 'in-place' });
          } else {
            // resubscribe | rebuild | restart: re-establish upstream. Subscribers
            // are told to re-init BEFORE the table goes away, because after a
            // key-column change their cached rows key on identities that no
            // longer exist — silently applying deltas corrupts the grid.
            await this.reestablish(key, entry, p.reload);
            applied.push({ id: dsId, reload: p.reload, action: 're-established' });
          }
        }
      }
    }
    return { plan: { plans }, applied };
  }

  /**
   * Live change: mutate the running actor and every subscriber flow in place.
   *
   * `batch` is read into plain fields on the actor at construction and
   * `conflateMs` is read fresh on every offer, so overwriting them is enough —
   * no reconnect, no re-snapshot, not one row lost.
   */
  applyLive(entry, ds) {
    if (ds.batch) {
      if (ds.batch.maxMs !== undefined) entry.actor.maxMs = ds.batch.maxMs;
      if (ds.batch.maxRows !== undefined) entry.actor.maxRows = ds.batch.maxRows;
      if (ds.batch.dedupeByKey !== undefined) entry.actor.dedupe = ds.batch.dedupeByKey !== false;
    }
    const ms = ds.conflation?.defaultIntervalMs;
    if (ms !== undefined) {
      this.conflateMs = ms;                        // future flows
      for (const sub of entry.subscribers) if (sub.__flow) sub.__flow.conflateMs = ms;
    }
  }

  /**
   * Re-establish a running datasource after a structural change.
   *
   * Its subscribers are KEPT — a config edit must not silently drop a trader's
   * blotter — but told to re-initialise, then the table is rebuilt fresh and the
   * upstream reconnected. The subscribers' next read sees the new schema.
   */
  async reestablish(key, entry, reason) {
    const datasourceId = key.split('#')[0];
    const survivors = [...entry.subscribers];

    for (const sub of survivors) {
      sub.__flow = undefined;                      // stale sequence state for a table about to vanish
      sub.send?.({ id: `r-${key}`, type: 'refresh', ref: { datasourceId }, reason: 'reconnect',
                   detail: `config changed (${reason}); re-reading` });
    }

    await this.teardown(key);

    // Rebuild by re-running the same acquisition path the first subscriber took.
    // registry.acquire is idempotent on params, so the table is recreated once
    // and every survivor re-attaches to it.
    for (const sub of survivors) {
      try { await this.subscribe({ datasourceId, params: entry.params ?? {} }, sub, { delivery: sub.delivery }); }
      catch (e) {
        sub.send?.({ id: `e-${key}`, type: 'error', code: 'config-invalid',
                     message: `re-subscribe after config change failed: ${e.message}`,
                     ref: { datasourceId } });
      }
    }
  }

  /**
   * Watch a grouped view and push GROUP-AGGREGATE deltas to one session (§8e).
   *
   * SSRM shows grouped data; every leaf tick moves the aggregate of its group
   * and that group's ancestors. Re-reading every loaded block once a second is
   * correct but laggy and heavy. Here the engine does the work: a grouped view's
   * `on_update` reports exactly which groups changed, a differ filters that to
   * the ones whose aggregate actually moved, and the client refreshes only those
   * routes — immediately.
   *
   * Per SESSION and per grouping. A tab grouping by desk and another by trader
   * each get their own watched view; re-calling with a new grouping replaces the
   * old one so a regroup does not leak a view.
   */
  async watchGroups(ref, { groupBy, aggregates }, session) {
    if (!this.createView || !this.watchView) return { watching: false };
    const e = this.entryFor(ref);
    session.__groupWatch ??= new Map();

    const sig = JSON.stringify({ groupBy, aggregates });
    const existing = session.__groupWatch.get(entryKeyOf(ref));
    if (existing?.sig === sig) return { watching: true };     // already on it
    if (existing) { try { await existing.stop(); } catch { /* gone */ } session.__groupWatch.delete(entryKeyOf(ref)); }

    const aggCols = Object.keys(aggregates ?? {});
    const differ = new GroupAggregateDiffer({ aggregateColumns: aggCols });
    const view = await this.createView(e.table, { groupBy, aggregates, depth: groupBy.length });

    const stop = await this.watchView(view, (rows) => {
      const changed = differ.feed(rows);
      if (!changed.length) return;
      session.send?.(groupDeltaMessage(entryKeyOf(ref), ref.datasourceId, groupBy, changed));
    });

    session.__groupWatch.set(entryKeyOf(ref), {
      sig,
      stop: async () => { try { await stop?.(); } finally { try { await view.delete?.(); } catch { /* gone */ } } },
    });
    return { watching: true };
  }

  /** Tear down every group watch a session left open — called on disconnect. */
  async stopSessionGroupWatches(session) {
    for (const w of session.__groupWatch?.values() ?? []) { try { await w.stop(); } catch { /* gone */ } }
    session.__groupWatch?.clear();
  }

  /**
   * Register a hub-side alert (§9.1). The predicate runs over the WHOLE table,
   * not any client window.
   *
   * The DSL predicate is compiled to a Perspective boolean expression and made
   * the filter of a view: that view contains exactly the rows currently over the
   * line — the full book, every scroll position and every client filter ignored.
   * An `AlertWatcher` diffs its membership and fires on the TRANSITION in, so a
   * position parked over the threshold alerts once, not once per tick.
   *
   * Compiled HUB-SIDE, from the safe DSL grammar — the client never hands the
   * engine a raw expression, and a predicate that cannot compile (a client-only
   * construct) is refused here with the reason, rather than silently watching
   * nothing.
   */
  async subscribeAlert(ref, { ruleId, predicate }, session) {
    if (!this.createView || !this.watchView) {
      throw Object.assign(new Error('this host has no view engine; alerts need one'), { code: 'internal' });
    }
    const e = this.entryFor(ref);

    let filter, expressions;
    try {
      // Compile to a NATIVE filter, not a boolean expression column: this
      // engine build's expression comparisons do not produce correct per-row
      // booleans (findings §23), but native filters do — the parity harness
      // proved it. Arithmetic sub-expressions ARE lifted into expression
      // columns, since those evaluate correctly.
      ({ filter, expressions } = compileFilterOps(parse(predicate)));
    } catch (err) {
      // A client-only construct (e.g. contains()) cannot be an engine alert:
      // an alert that only sees the window is not an alert (§9.1).
      throw Object.assign(new Error(`alert predicate cannot run in the engine: ${err.message}`),
        { code: err.code ?? 'unsupported-expression' });
    }

    session.__alerts ??= new Map();
    const existing = session.__alerts.get(ruleId);
    if (existing) { try { await existing.stop(); } catch { /* gone */ } }

    const watcher = new AlertWatcher();
    // The view holds exactly the rows over the line — the full book, filtered
    // by the predicate, no client window involved.
    const view = await this.createView(e.table, { filter, expressions });

    const stop = await this.watchView(view, (rows) => {
      const { fired } = watcher.feed(rows);
      for (const row of fired) session.send?.(alertMessage(ruleId, this.stripInternal(row), this.now?.()));
    });

    session.__alerts.set(ruleId, {
      watcher,
      stop: async () => { try { await stop?.(); } finally { try { await view.delete?.(); } catch { /* gone */ } } },
    });
    return { ruleId, watching: true };
  }

  /** Drop the alert view's own computed column before it goes on the wire. */
  stripInternal(row) {
    const out = {};
    for (const k of Object.keys(row)) if (k !== '__ROW_PATH__' && !k.startsWith('__expr_') && k !== '__alert') out[k] = row[k];
    return out;
  }

  async unsubscribeAlert(ruleId, session) {
    const a = session.__alerts?.get(ruleId);
    if (a) { try { await a.stop(); } catch { /* gone */ } session.__alerts.delete(ruleId); }
  }

  /** Tear down every alert a session left open — called on disconnect. */
  async stopSessionAlerts(session) {
    for (const a of session.__alerts?.values() ?? []) { try { await a.stop(); } catch { /* gone */ } }
    session.__alerts?.clear();
  }

  /**
   * The write path (§8.6). v1 scope: ANNOTATIONS.
   *
   * Perspective is a read model, so a write does not go "into" it as an edit —
   * it is applied as a normal row update on that key, which then echoes back to
   * every subscriber through the feed. That echo is what the client reconciles
   * its optimistic apply against, so the round trip is real: the value the
   * client sees confirmed is the value the hub actually stored, not the value it
   * hopefully sent.
   *
   * DEDUPED by idempotencyKey. A network retry of the same logical write must
   * never double-apply — the client cannot tell an ambiguous timeout from a
   * lost command, so it retries, and the key is what makes that safe.
   *
   * @returns {{idempotencyKey, outcome:'applied'|'duplicate'|'rejected', detail?}}
   */
  async command(msg) {
    const { idempotencyKey, verb, payload, ref } = msg;
    this.seenCommands ??= new Map();
    if (this.seenCommands.has(idempotencyKey)) {
      return { idempotencyKey, outcome: 'duplicate' };
    }

    let entry;
    try { entry = this.entryFor(ref); }
    catch (e) { return { idempotencyKey, outcome: 'rejected', detail: e.message }; }

    const { key, field, value } = payload ?? {};
    if (key == null || !field) return { idempotencyKey, outcome: 'rejected', detail: 'a write needs key and field' };

    // Record BEFORE applying: if the apply throws mid-way, a retry must still
    // be recognised as a duplicate rather than applied twice.
    this.seenCommands.set(idempotencyKey, this.now?.() ?? 0);
    try {
      // Apply as a partial row update keyed by __key — merges onto the existing
      // row, echoes via watchTable, disturbs no other field.
      const ok = entry.actor.push([{ __key: key, [field]: value }]);
      if (!ok) return { idempotencyKey, outcome: 'rejected', detail: 'table is not accepting writes' };
      this.writes = (this.writes ?? 0) + 1;
      return { idempotencyKey, outcome: 'applied' };
    } catch (e) {
      return { idempotencyKey, outcome: 'rejected', detail: String(e.message ?? e) };
    }
  }

  async teardown(key) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);

    // Stop the upstream FIRST, synchronously. Everything below is async, and
    // data arriving mid-teardown would be written to a table being deleted.
    e.adapter.close();
    e.actor.dispose();

    try { await e.stopWatch?.(); } catch { /* already gone */ }

    for (const v of e.views?.values() ?? []) {
      try { await v.delete?.(); } catch { /* already gone */ }
    }
    e.views?.clear();
    try { await e.table?.delete?.(); } catch { /* already gone */ }
  }

  // ------------------------------------------------------------ managed views

  async openView(ref, spec, session) {
    const e = this.entryFor(ref);
    if (!this.createView) throw Object.assign(new Error('no engine view support in this host'), { code: 'internal' });
    const view = await this.createView(e.table, spec ?? {});
    const viewId = `v${++this.viewSeq}`;
    this.views.set(viewId, { view, session, key: entryKeyOf(ref), openedAt: Date.now() });
    (session.views ??= new Set()).add(viewId);
    return { viewId };
  }

  async readWindow(viewId, { startRow = 0, endRow } = {}) {
    const held = this.views.get(viewId);
    if (!held) throw Object.assign(new Error(`view "${viewId}" is not open`), { code: 'invalid-params' });
    const rowCount = await held.view.num_rows();
    const columns = endRow === undefined
      ? await held.view.to_columns()
      : await held.view.to_columns({ start_row: startRow, end_row: Math.min(endRow, rowCount) });
    return { columns, rowCount };
  }

  /**
   * Expand or collapse a tree node BY ROW INDEX.
   *
   * This is the whole VRM mechanism: one view for the entire tree, mutated in
   * place, where SSRM opens a fresh grouped view per expanded node. Returns the
   * new row count because expanding changes the length of the flat list the
   * viewport is indexing into.
   */
  async expandRow(viewId, index, collapse = false) {
    const held = this.views.get(viewId);
    if (!held) throw Object.assign(new Error(`view "${viewId}" is not open`), { code: 'invalid-params' });
    const fn = collapse ? held.view.collapse : held.view.expand;
    if (typeof fn !== 'function') {
      throw Object.assign(new Error('this view is not a tree; expand/collapse need a group_by'), { code: 'invalid-params' });
    }
    await fn.call(held.view, index);
    return { rowCount: await held.view.num_rows() };
  }

  async disposeView(viewId) {
    const held = this.views.get(viewId);
    if (!held) return false;
    this.views.delete(viewId);
    held.session?.views?.delete(viewId);
    try { await held.view.delete?.(); } catch { /* already gone */ }
    return true;
  }

  /** Every view a session left open. Called on disconnect. */
  async disposeSessionViews(session) {
    for (const viewId of [...(session.views ?? [])]) await this.disposeView(viewId);
    await this.stopSessionGroupWatches(session);
    await this.stopSessionAlerts(session);
  }

  get openViewCount() { return this.views.size; }

  // ---------------------------------------------------------------- queries
  //
  // Plan Phase 8a. Every one of these opens a TRANSIENT view and disposes it in
  // a `finally` — "a distinct-values view left open per column per grid is
  // exactly the leak that will show up as worker memory growth two weeks into
  // UAT" (parity study §1.2).

  entryFor(ref) {
    const ds = this.datasource(ref.datasourceId);
    const entry = this.registry.find(ds.id, ref.params ?? {});
    const e = entry && this.entries.get(entry.key);
    if (!e) throw Object.assign(new Error(`not subscribed to "${ref.datasourceId}"`), { code: 'unknown-datasource' });
    return e;
  }

  /** Open a view, use it, dispose it — even if the caller throws. */
  async withView(ref, spec, fn) {
    const e = this.entryFor(ref);
    if (!this.createView) throw Object.assign(new Error('no engine view support in this host'), { code: 'internal' });
    const view = await this.createView(e.table, spec);
    try { return await fn(view, e); }
    finally { try { await view.delete?.(); } catch { /* already gone */ } }
  }

  async rowCount(ref, view) {
    return this.withView(ref, { filter: view?.filter ?? [], expressions: view?.expressions }, (v) => v.num_rows());
  }

  /**
   * Distinct values via a grouped view — the engine already maintains group
   * keys, so this is close to free (parity study §1.2). `__ROW_PATH__[0]` is the
   * root and is skipped.
   */
  async distinctValues(ref, colId, contextFilter, limit = 10_000) {
    return this.withView(ref, { groupBy: [colId], filter: contextFilter ?? [] }, async (v) => {
      const block = await v.to_columns({ start_row: 0, end_row: limit + 1 });
      const paths = block.__ROW_PATH__ ?? [];
      return paths.filter((p) => p.length > 0).map((p) => p[0]);
    });
  }

  async searchValues(ref, colId, prefix, limit = 100) {
    const all = await this.distinctValues(ref, colId, [], 20_000);
    const p = String(prefix ?? '').toLowerCase();
    return all.filter((v) => v !== null && String(v).toLowerCase().startsWith(p)).slice(0, limit);
  }

  /**
   * Stream the whole result set in batches — the SSRM replacement for
   * `forEachNode`, and how a page without its own engine gets row data.
   *
   * A production blotter attaches a Perspective client to the same port and
   * reads over the BINARY channel instead, which is the entire point of the
   * two-channel design (§7.1). This path copies through structured clone and
   * is therefore the slower option, deliberately.
   */
  /**
   * Index of a row under the current sort and filter — what `ensureIndexVisible`
   * needs, and the one thing SSRM genuinely cannot answer locally (parity §3).
   *
   * Scans in batches rather than materialising the whole view: a rank lookup on
   * a 500k-row table should not allocate 500k rows to find one index.
   */
  async rank(ref, key, view, { batchRows = 5000 } = {}) {
    return this.withView(ref, { filter: view?.filter ?? [], sort: view?.sort ?? [], expressions: view?.expressions }, async (v) => {
      const total = await v.num_rows();
      for (let start = 0; start < total; start += batchRows) {
        const end = Math.min(start + batchRows, total);
        const block = await v.to_columns({ start_row: start, end_row: end });
        const keys = block.__key ?? block[this.keyColumnOf(ref)] ?? [];
        const i = keys.findIndex((k) => String(k) === String(key));
        if (i >= 0) return start + i;
      }
      return null;   // not in this view — a real answer, not an error
    });
  }

  keyColumnOf(ref) {
    try { return this.datasource(ref.datasourceId).keyColumns?.[0] ?? '__key'; }
    catch { return '__key'; }
  }

  async scan(ref, view, onBatch, { batchRows = 2000, limit = Infinity } = {}) {
    return this.withView(ref, { filter: view?.filter ?? [], sort: view?.sort ?? [], expressions: view?.expressions }, async (v) => {
      const total = Math.min(await v.num_rows(), limit);
      let sent = 0;
      for (let start = 0; start < total; start += batchRows) {
        const end = Math.min(start + batchRows, total);
        onBatch(await v.to_columns({ start_row: start, end_row: end }), start, total);
        sent += end - start;
      }
      return sent;
    });
  }

  async aggregates(ref, specs = [], view) {
    const aggregates = {};
    for (const s of specs) aggregates[s.column] = s.fn;
    return this.withView(ref, { aggregates, filter: view?.filter ?? [], expressions: view?.expressions }, async (v) => {
      const block = await v.to_columns({ start_row: 0, end_row: 1 });
      const out = {};
      for (const s of specs) out[s.as ?? `${s.fn}(${s.column})`] = block[s.column]?.[0] ?? null;
      return out;
    });
  }

  /**
   * Periodic push, so a diagnostics screen does not have to poll and every
   * session sees the same numbers at the same moment.
   */
  startStatsTicker(intervalMs = 1000, setTimer = (fn, ms) => setInterval(fn, ms)) {
    this.stopStatsTicker();
    this._ticker = setTimer(async () => {
      if (this.sessions.size === 0) return;
      const payload = await this.stats();
      const msg = { id: 'tick', type: 'statsTick', ...payload };
      for (const s of this.sessions) s.send?.(msg);
    }, intervalMs);
    if (this._ticker && typeof this._ticker.unref === 'function') this._ticker.unref();
    return this._ticker;
  }

  stopStatsTicker(clear = (t) => clearInterval(t)) {
    if (this._ticker) { clear(this._ticker); this._ticker = null; }
  }

  publishState(key, state, detail) {
    const e = this.entries.get(key);
    if (e) e.state = state;
    const msg = { id: `evt-${this.log.length}`, type: 'state', ref: { datasourceId: key.split('#')[0] }, state, ...(detail ? { detail } : {}) };
    this.log.push(msg);
    for (const s of e?.subscribers ?? []) s.send?.(msg);
  }

  /** Injected by the host; the engine is the only thing that knows real usage. */
  setMemoryProbe(fn) { this.memoryProbe = fn; }

  async stats() {
    const r = this.registry.stats();
    // Estimated vs actual, side by side. The Phase 0 memo could not trust its
    // per-table numbers; reporting both is what makes the estimate falsifiable
    // rather than merely plausible.
    let engine = null;
    try { engine = await this.memoryProbe?.(); } catch { engine = null; }
    return {
      ...r,
      engine,
      estimateAccuracy: engine?.used_size && r.usedBytes
        ? Number((engine.used_size / r.usedBytes).toFixed(2))
        : null,
      sessions: this.sessions.size,
      openViews: this.views.size,
      datasources: [...this.entries.entries()].map(([key, e]) => e.stats
        ? e.stats.snapshot({
            subscribers: e.subscribers.size,
            cacheRows: e.actor.rowsOut,
            openViews: e.views?.size ?? 0,
            queueDepth: e.actor.queue.length,
            queueLimit: e.actor.queueLimit,
            // Dropping a malformed row silently would trade one invisible
            // failure for another: a feed emitting nulls should be observable.
            malformed: e.stats.malformed ?? 0,
            lastMalformed: e.stats.lastMalformed ?? null,
            // §7.4: "Publish which rung a subscriber is on, in stats." A
            // subscriber quietly degraded to periodic refresh is otherwise
            // indistinguishable from a slow feed.
            subscriberRungs: [...e.subscribers].map((sub) => sub.__flow?.stats?.().rung ?? 'none'),
            slowDrops: this.slowDrops ?? 0,
          })
        : { datasourceId: key.split('#')[0], state: e.state, subscribers: e.subscribers.size }),
    };
  }
}
