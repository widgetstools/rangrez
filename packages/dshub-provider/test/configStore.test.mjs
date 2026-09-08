import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MemoryConfigStore, validateItem, MIGRATIONS, CURRENT_VERSION, STORES,
} from '../src/configStore.mjs';
import { exportBundle, importBundle } from '../src/bundle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(HERE, '../../dshub-spec/datasource-config.schema.json'), 'utf8'));

const conn = () => ({ id: 'c1', kind: 'stomp', url: 'ws://localhost:8081' });
const store = (seed) => new MemoryConfigStore({ schema, seed });

// ------------------------------------------------- validate on every write

test('a malformed connection is REFUSED, not stored', async () => {
  // A malformed datasource in IndexedDB is not a caught exception, it is a
  // blotter that fails to start tomorrow morning with an error pointing at the
  // worker rather than at the typo.
  const s = store();
  await assert.rejects(
    () => s.put('connections', 'c1', { id: 'c1', kind: 'carrier-pigeon', url: 'ws://x' }),
    (e) => e.code === 'config-invalid' && /kind/.test(e.message),
  );
  assert.deepEqual(await s.all('connections'), [], 'nothing was written');
});

test('a valid connection is stored', async () => {
  const s = store();
  await s.put('connections', 'c1', conn());
  assert.deepEqual(await s.get('connections', 'c1'), conn());
});

test('a password-shaped field is refused on WRITE, not only on export', async () => {
  // The write half of "config carries a credentialRef and never a secret".
  const s = store();
  await assert.rejects(
    () => s.put('connections', 'c1', { ...conn(), password: 'hunter2' }),
    (e) => e.code === 'config-invalid',
  );
});

test('validation is SYNCHRONOUS, so it can run inside a transaction', () => {
  // An IDB transaction commits as soon as the microtask queue drains with no
  // pending request, so an async validator would silently end it and the next
  // write would throw TransactionInactiveError.
  const out = validateItem('connections', conn(), schema);
  assert.ok(Array.isArray(out), 'returned a value, not a promise');
  assert.equal(typeof out.then, 'undefined');
});

test('a store with no schema for it accepts anything', async () => {
  // `layouts` and `rules` have no schema yet; refusing everything would make
  // them unusable rather than safe.
  const s = store();
  await s.put('layouts', 'l1', { id: 'l1', anything: true });
  assert.equal((await s.all('layouts')).length, 1);
});

// ------------------------------------------------- referential integrity

test('a datasource naming a missing connection is caught', async () => {
  // It validates perfectly on its own and fails at subscribe time with
  // "unknown connection", three layers from the edit that caused it.
  const s = store();
  await s.put('datasources', 'd1', {
    id: 'd1', connectionRef: 'nope', schemaRef: 'x@v1', keyColumns: ['id'],
    snapshot: { mode: 'subscribe-only' },
  });
  await assert.rejects(() => s.assertRefs(), (e) => e.code === 'config-invalid');
});

test('refs pass once the connection exists', async () => {
  const s = store();
  await s.put('connections', 'c1', conn());
  await s.put('datasources', 'd1', {
    id: 'd1', connectionRef: 'c1', schemaRef: 'x@v1', keyColumns: ['id'],
    snapshot: { mode: 'subscribe-only' },
  });
  await s.assertRefs();
});

// ------------------------------------------------- transactions

test('a failed transaction leaves the previous config INTACT', async () => {
  // A half-applied import is worse than a failed one.
  const s = store({ connections: [conn()] });
  await assert.rejects(() => s.transaction(async (tx) => {
    await tx.put('connections', 'c2', { id: 'c2', kind: 'ws', url: 'ws://b' });
    throw new Error('boom');
  }));
  assert.deepEqual((await s.all('connections')).map((c) => c.id), ['c1'], 'rolled back');
});

test('a transaction that writes an invalid item rolls the whole thing back', async () => {
  const s = store({ connections: [conn()] });
  await assert.rejects(() => s.transaction(async (tx) => {
    await tx.put('connections', 'c2', { id: 'c2', kind: 'ws', url: 'ws://b' });
    await tx.put('connections', 'c3', { id: 'c3', kind: 'nope', url: 'ws://c' });
  }));
  assert.deepEqual((await s.all('connections')).map((c) => c.id), ['c1']);
});

// ------------------------------------------------- migrations

test('migrations exist from version 1', () => {
  // The first version that ships without a migration path makes every later
  // schema change a choice between losing config and writing the migration
  // retroactively against data you can no longer see.
  assert.ok(MIGRATIONS.length >= 1);
  assert.equal(CURRENT_VERSION, MIGRATIONS.length);
});

test('a fresh database runs EVERY migration and lands on the current shape', () => {
  // oldVersion 0 must reach the same shape as an upgraded store, or the
  // migration list is decorative rather than trustworthy.
  const created = new Set();
  const db = {
    objectStoreNames: { contains: (n) => created.has(n) },
    createObjectStore: (n) => { created.add(n); },
  };
  for (let v = 0; v < CURRENT_VERSION; v++) MIGRATIONS[v](db, null, 0);
  assert.deepEqual([...created].sort(), [...STORES].sort());
});

test('re-running a migration over an existing store is a no-op', () => {
  // An upgrade path that throws on a store it already created cannot be run
  // twice, and a partially-failed upgrade would then be unrecoverable.
  const created = new Set(STORES);
  let attempted = 0;
  const db = {
    objectStoreNames: { contains: (n) => created.has(n) },
    createObjectStore: () => { attempted++; },
  };
  MIGRATIONS[0](db, null, 1);
  assert.equal(attempted, 0);
});

// ------------------------------------------------- round trip

test('export -> wipe -> import reproduces byte-identical config', async () => {
  // The Phase 7 exit criterion, and the only sync path there is until the
  // sidecar exists.
  const source = store({ connections: [conn()] });
  await source.put('datasources', 'd1', {
    id: 'd1', connectionRef: 'c1', schemaRef: 'x@v1', keyColumns: ['id'],
    snapshot: { mode: 'subscribe-only' },
  });
  const bundle = await exportBundle(source);

  const fresh = store();
  const result = await importBundle(fresh, bundle, { mode: 'merge-incoming' });
  assert.equal(result.applied, true, JSON.stringify(result.errors));

  const reexported = await exportBundle(fresh);
  assert.equal(reexported.checksum, bundle.checksum, 'byte-identical content');
});

test('a dry run writes NOTHING', async () => {
  const source = store({ connections: [conn()] });
  const bundle = await exportBundle(source);
  const fresh = store();
  const r = await importBundle(fresh, bundle);          // dry-run is the default
  assert.equal(r.applied, false);
  assert.deepEqual(await fresh.all('connections'), []);
  assert.deepEqual(r.diff.connections.added, ['c1'], 'but it still reports what WOULD change');
});

test('an import carrying an invalid item does not partially apply', async () => {
  const fresh = store();
  const bundle = {
    kind: 'dshub-config-bundle', specVersion: '1.0', bundleVersion: 1,
    connections: [conn(), { id: 'bad', kind: 'nope', url: 'ws://x' }],
    datasources: [], artifacts: [], rules: [],
  };
  bundle.checksum = (await exportBundle(store({ connections: bundle.connections.slice(0, 1) }))).checksum;
  await assert.rejects(
    () => importBundle(fresh, bundle, { mode: 'merge-incoming' }).then((r) => {
      if (!r.applied) throw Object.assign(new Error(r.errors[0]?.message ?? 'refused'), { code: 'config-invalid' });
    }),
  );
  assert.deepEqual(await fresh.all('connections'), [], 'nothing landed');
});
