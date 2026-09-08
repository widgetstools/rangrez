/**
 * Config store — IndexedDB, with migrations from day one (architecture §3.5).
 *
 * There is no config server in v1, so this IS the config. That raises the stakes
 * on two things that are easy to defer and expensive to retrofit:
 *
 *   1. MIGRATIONS. The first version that ships without a migration path makes
 *      every later schema change a choice between losing users' config and
 *      writing the migration retroactively against data you can no longer see.
 *      So the list exists from version 1 even though it is nearly empty.
 *
 *   2. VALIDATION ON EVERY WRITE. A malformed datasource in IndexedDB is not a
 *      caught exception, it is a blotter that fails to start tomorrow morning
 *      with an error pointing at the worker. The schema is the only thing
 *      standing between a typo and that.
 *
 * ── The IndexedDB trap this file is written around ────────────────────────────
 *
 * An IDB transaction commits automatically as soon as the microtask queue drains
 * with no pending request against it. So `await` on ANYTHING that is not an IDB
 * request — a fetch, a timer, a hash, `await null` — silently ends the
 * transaction, and the next write throws `TransactionInactiveError`.
 *
 * Every method here therefore awaits only IDB requests, and validation is
 * deliberately SYNCHRONOUS so it can run inside a transaction without killing
 * it. `validateForWrite` is sync; keep it that way.
 */

import { validateForWrite, validateBundleRefs } from '../../dshub-spec/src/validate.mjs';

export const DB_NAME = 'dshub-config';

/**
 * Object stores. `artifacts` is keyed `id@vN` because schema artifacts are
 * versioned and a datasource pins one (§4.4) — overwriting v1 when v2 is
 * inferred would silently re-point every blotter still on v1.
 */
export const STORES = ['connections', 'datasources', 'artifacts', 'rules', 'layouts', 'meta'];

/**
 * Ordered migrations. Index + 1 is the DB version they upgrade TO.
 *
 * Each runs inside `onupgradeneeded`, so it may only use synchronous IDB calls
 * — no awaits, no promises. A migration that needs to read data uses a cursor
 * and completes within the same upgrade transaction.
 */
export const MIGRATIONS = [
  /** v1 — the stores themselves. */
  (db) => {
    for (const name of STORES) {
      if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    }
  },
];

export const CURRENT_VERSION = MIGRATIONS.length;

/** Promise wrapper for one IDB request. Awaiting this keeps the tx alive. */
const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

/**
 * Validate one item against its collection's schema.
 *
 * Sync, and it must stay sync — see the transaction note at the top.
 * `validateForWrite` also rejects password-shaped fields, which is the write
 * half of the rule that config carries a `credentialRef` and never a secret
 * (§3.9); the export and import halves live in bundle.mjs.
 */
export function validateItem(collection, item, schema) {
  const defs = { connections: 'connection', datasources: 'datasource' };
  const name = defs[collection];
  if (!name || !schema?.$defs?.[name]) return [];   // no schema for this store
  return validateForWrite(item, { $defs: schema.$defs, $ref: `#/$defs/${name}` });
}

class WriteError extends Error {
  constructor(collection, id, errors) {
    super(`${collection}/${id} is invalid: ${errors[0]?.path ?? '?'} ${errors[0]?.message ?? ''}`);
    this.code = 'config-invalid';
    this.errors = errors;
  }
}

/**
 * The store interface both backends implement, and which `bundle.mjs` writes
 * through: `all`, `meta`, `transaction`.
 */
class BaseConfigStore {
  constructor({ schema } = {}) { this.schema = schema; }

  assertValid(collection, id, item) {
    const errors = validateItem(collection, item, this.schema);
    if (errors.length) throw new WriteError(collection, id, errors);
  }

  /**
   * Referential integrity across collections.
   *
   * A datasource naming a connection that does not exist validates perfectly
   * on its own and fails at subscribe time with "unknown connection", three
   * layers from the edit that caused it.
   */
  async assertRefs() {
    const errors = validateBundleRefs({
      connections: await this.all('connections'),
      datasources: await this.all('datasources'),
    });
    if (errors.length) {
      throw Object.assign(new Error(`dangling reference: ${errors[0].message}`), { code: 'config-invalid', errors });
    }
  }
}

/** In-memory backend — tests, and any host without IndexedDB. */
export class MemoryConfigStore extends BaseConfigStore {
  constructor(opts = {}) {
    super(opts);
    this.data = new Map(STORES.map((s) => [s, new Map()]));
    for (const [k, rows] of Object.entries(opts.seed ?? {})) {
      for (const item of rows) this.data.get(k)?.set(item.id, item);
    }
    this.version = CURRENT_VERSION;
  }

  async all(collection) { return [...(this.data.get(collection)?.values() ?? [])]; }
  async get(collection, id) { return this.data.get(collection)?.get(id); }
  async meta() { return this.data.get('meta')?.get('bundle') ?? null; }

  async put(collection, id, item) {
    this.assertValid(collection, id, item);
    this.data.get(collection).set(id, item);
  }

  async delete(collection, id) { this.data.get(collection)?.delete(id); }
  async clear(collection) { this.data.get(collection)?.clear(); }

  async transaction(fn) {
    // Snapshot for rollback: a half-applied import is worse than a failed one.
    const backup = new Map([...this.data].map(([k, v]) => [k, new Map(v)]));
    try {
      return await fn({
        put: (c, id, item) => this.put(c, id, item),
        has: async (c, id) => this.data.get(c)?.has(id) ?? false,
        clear: (c) => this.clear(c),
        putMeta: async (m) => { this.data.get('meta').set('bundle', m); },
      });
    } catch (e) {
      this.data = backup;
      throw e;
    }
  }

  async close() {}
}

/** IndexedDB backend. */
export class IdbConfigStore extends BaseConfigStore {
  constructor({ name = DB_NAME, schema, indexedDB: idb } = {}) {
    super({ schema });
    this.name = name;
    this.idb = idb ?? globalThis.indexedDB;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const r = this.idb.open(this.name, CURRENT_VERSION);
      r.onupgradeneeded = (ev) => {
        /**
         * Run only the migrations this database has not seen.
         *
         * `ev.oldVersion` is 0 for a fresh database, so a new install runs all
         * of them in order and arrives at the same shape as an upgraded one —
         * which is the property that makes the migration list trustworthy
         * rather than decorative.
         */
        for (let v = ev.oldVersion; v < CURRENT_VERSION; v++) {
          MIGRATIONS[v](r.result, r.transaction, ev.oldVersion);
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(Object.assign(
        new Error('another tab is holding an older version of the config database open'),
        { code: 'config-conflict' },
      ));
    });
    return this.db;
  }

  async #tx(collections, mode, fn) {
    const db = await this.open();
    const tx = db.transaction(collections, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
    let out;
    try { out = await fn(tx); }
    catch (e) { try { tx.abort(); } catch { /* already gone */ } throw e; }
    await done;
    return out;
  }

  async all(collection) {
    return this.#tx([collection], 'readonly', (tx) => req(tx.objectStore(collection).getAll()));
  }

  async get(collection, id) {
    return this.#tx([collection], 'readonly', (tx) => req(tx.objectStore(collection).get(id)));
  }

  async meta() {
    return (await this.#tx(['meta'], 'readonly', (tx) => req(tx.objectStore('meta').get('bundle')))) ?? null;
  }

  async put(collection, id, item) {
    this.assertValid(collection, id, item);
    return this.#tx([collection], 'readwrite', (tx) => req(tx.objectStore(collection).put(item, id)));
  }

  async delete(collection, id) {
    return this.#tx([collection], 'readwrite', (tx) => req(tx.objectStore(collection).delete(id)));
  }

  async clear(collection) {
    return this.#tx([collection], 'readwrite', (tx) => req(tx.objectStore(collection).clear()));
  }

  /**
   * ONE transaction across every store.
   *
   * An import that fails halfway must leave the previous config intact rather
   * than half-replaced (§3.7). IndexedDB gives that for free — but only if
   * nothing inside awaits something that is not an IDB request, which is why
   * validation is synchronous.
   */
  async transaction(fn) {
    return this.#tx(STORES, 'readwrite', async (tx) => fn({
      put: (c, id, item) => { this.assertValid(c, id, item); return req(tx.objectStore(c).put(item, id)); },
      has: async (c, id) => (await req(tx.objectStore(c).getKey(id))) !== undefined,
      clear: (c) => req(tx.objectStore(c).clear()),
      putMeta: (m) => req(tx.objectStore('meta').put(m, 'bundle')),
    }));
  }

  async close() { this.db?.close(); this.db = null; }
}

/** Whichever backend this host can support. */
export function openConfigStore(opts = {}) {
  const idb = opts.indexedDB ?? globalThis.indexedDB;
  return idb ? new IdbConfigStore({ ...opts, indexedDB: idb }) : new MemoryConfigStore(opts);
}
