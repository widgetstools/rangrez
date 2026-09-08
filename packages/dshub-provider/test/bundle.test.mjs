import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize, checksum, exportBundle, verifyBundle, diffBundle, importBundle, BUNDLE_KIND,
} from '../src/bundle.mjs';

/** In-memory stand-in for the IndexedDB store. */
function makeStore(seed = {}) {
  const data = {
    connections: new Map(), datasources: new Map(), artifacts: new Map(),
    rules: new Map(), layouts: new Map(),
  };
  for (const [k, items] of Object.entries(seed)) {
    for (const it of items) data[k].set(it.id + (k === 'artifacts' ? `@v${it.version}` : ''), it);
  }
  let meta = { bundleVersion: 0 };
  const tx = {
    clear: async (k) => data[k].clear(),
    has: async (k, id) => data[k].has(id),
    put: async (k, id, v) => data[k].set(id, v),
    putMeta: async (m) => { meta = m; },
  };
  return {
    data,
    all: async (k) => [...data[k].values()],
    meta: async () => meta,
    transaction: async (fn) => fn(tx),
    failNextTransaction: false,
  };
}

// Getters, not shared objects: a test that mutates its fixture must not be
// able to reach into another one.
const mkConn = () => ({ id: 'c1', kind: 'stomp', url: 'ws://localhost:8081' });
const mkDs = () => ({ id: 'positions', connectionRef: 'c1' });

// ------------------------------------------------- canonical form

test('canonical form is key-order independent', () => {
  // The checksum is compared across machines. If key order leaked in, two
  // byte-identical configs would hash differently and reconcile would report
  // conflicts that do not exist.
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
});

test('canonical form still distinguishes real differences', () => {
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
  assert.notEqual(canonicalize({ a: [1, 2] }), canonicalize({ a: [2, 1] }), 'array order is meaningful');
});

test('an absent key and an explicit undefined hash the same', () => {
  // Structured clone preserves `undefined` where JSON drops it, so the same
  // config reaches the worker with the key present. It must not change the hash.
  assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }));
});

// ------------------------------------------------- export

test('export carries a checksum over the CONTENT, not the envelope', async () => {
  const store = makeStore({ connections: [mkConn()], datasources: [mkDs()] });
  const b1 = await exportBundle(store, { exportedBy: 'ann' });
  await new Promise((r) => setTimeout(r, 2));
  const b2 = await exportBundle(store, { exportedBy: 'bob' });
  assert.equal(b1.checksum, b2.checksum, 'same config, same checksum, whoever exported it and whenever');
  assert.equal(b1.kind, BUNDLE_KIND);
});

test('layouts are excluded unless asked for', async () => {
  // Personal window arrangements should not ride along on a shared config.
  const store = makeStore({ connections: [mkConn()], layouts: [{ id: 'l1', grid: {} }] });
  assert.equal((await exportBundle(store)).layouts, undefined);
  assert.equal((await exportBundle(store, { includeLayouts: true })).layouts.length, 1);
});

test('export REFUSES to emit a secret', async () => {
  const store = makeStore({ connections: [{ ...mkConn(), password: 'hunter2' }] });
  await assert.rejects(() => exportBundle(store), /refusing to export/);
});

// ------------------------------------------------- verify

test('a tampered bundle fails its checksum', async () => {
  const store = makeStore({ connections: [mkConn()], datasources: [mkDs()] });
  const b = await exportBundle(store);
  b.connections[0].url = 'ws://evil:9999';
  const v = await verifyBundle(b);
  assert.equal(v.ok, false);
  assert.match(v.errors[0].message, /checksum/);
});

test('a bundle with no checksum is refused', async () => {
  const store = makeStore({ connections: [mkConn()] });
  const b = await exportBundle(store);
  delete b.checksum;
  assert.equal((await verifyBundle(b)).ok, false);
});

test('a newer specVersion is refused with an actionable message', async () => {
  const store = makeStore({ connections: [mkConn()] });
  const b = { ...(await exportBundle(store)), specVersion: '9.0' };
  const v = await verifyBundle(b);
  assert.equal(v.ok, false);
  assert.match(v.errors[0].message, /Upgrade the app/);
});

test('something that is not a bundle at all is rejected first', async () => {
  const v = await verifyBundle({ hello: 'world' });
  assert.equal(v.ok, false);
  assert.equal(v.errors.length, 1, 'one clear error, not a cascade of checksum noise');
});

test('import refuses a bundle carrying a secret', async () => {
  // Belt and braces: export strips them, but the file may not have come from us.
  const store = makeStore();
  const payload = { connections: [{ ...mkConn(), password: 'hunter2' }], datasources: [], artifacts: [], rules: [] };
  const b = { kind: BUNDLE_KIND, specVersion: '1.0', ...payload, checksum: await checksum(payload) };
  const r = await importBundle(store, b, { mode: 'replace-all' });
  assert.equal(r.applied, false);
  assert.match(r.errors[0].message, /import rejected/);
  assert.equal(store.data.connections.size, 0, 'and nothing was written');
});

// ------------------------------------------------- diff

test('diff classifies added, changed, removed and unchanged', () => {
  const cur = { connections: [mkConn()], datasources: [mkDs()] };
  const inc = {
    connections: [{ ...mkConn(), url: 'ws://other:8081' }],
    datasources: [mkDs(), { id: 'trades', connectionRef: 'c1' }],
  };
  const d = diffBundle(inc, cur);
  assert.deepEqual(d.connections.changed, ['c1']);
  assert.deepEqual(d.datasources.added, ['trades']);
  assert.deepEqual(d.datasources.unchanged, ['positions']);
});

test('diff reports what an import would REMOVE', () => {
  // The destructive half of replace-all, visible before it is chosen.
  const d = diffBundle({ datasources: [] }, { datasources: [mkDs()] });
  assert.deepEqual(d.datasources.removed, ['positions']);
});

test('artifacts diff by id AND version', () => {
  // Two versions of one artifact coexist; keying on id alone would show an
  // added version as a change and silently lose the old one.
  const d = diffBundle(
    { artifacts: [{ id: 'a', version: 2 }] },
    { artifacts: [{ id: 'a', version: 1 }] },
  );
  assert.deepEqual(d.artifacts.added, ['a@v2']);
  assert.deepEqual(d.artifacts.removed, ['a@v1']);
});

// ------------------------------------------------- import modes

async function bundleOf(seed) {
  return exportBundle(makeStore(seed), { exportedBy: 'ann' });
}

test('dry-run is the DEFAULT and writes nothing', async () => {
  // A destructive default is how a desk loses its config to a stray click.
  const store = makeStore({ datasources: [mkDs()] });
  const r = await importBundle(store, await bundleOf({ datasources: [{ id: 'trades' }] }));
  assert.equal(r.applied, false);
  assert.deepEqual(r.diff.datasources.added, ['trades']);
  assert.equal(store.data.datasources.size, 1, 'still just the original');
});

test('merge-incoming overwrites on conflict', async () => {
  const store = makeStore({ connections: [mkConn()] });
  const b = await bundleOf({ connections: [{ ...mkConn(), url: 'ws://new:1' }] });
  await importBundle(store, b, { mode: 'merge-incoming' });
  assert.equal(store.data.connections.get('c1').url, 'ws://new:1');
});

test('merge-local keeps what is already here', async () => {
  const store = makeStore({ connections: [mkConn()] });
  const b = await bundleOf({ connections: [{ ...mkConn(), url: 'ws://new:1' }, { id: 'c2', kind: 'rest' }] });
  await importBundle(store, b, { mode: 'merge-local' });
  assert.equal(store.data.connections.get('c1').url, 'ws://localhost:8081', 'local wins');
  assert.ok(store.data.connections.has('c2'), 'but genuinely new items still arrive');
});

test('replace-all clears first', async () => {
  const store = makeStore({ datasources: [mkDs(), { id: 'gone' }] });
  await importBundle(store, await bundleOf({ datasources: [{ id: 'trades' }] }), { mode: 'replace-all' });
  assert.deepEqual([...store.data.datasources.keys()], ['trades']);
});

test('an unknown mode throws rather than falling back to a destructive one', async () => {
  await assert.rejects(
    () => importBundle(makeStore(), { kind: BUNDLE_KIND }, { mode: 'merge' }),
    /unknown import mode/,
  );
});

test('every applied import bumps bundleVersion past both sides', async () => {
  // §3.6 reconcile compares versions; going backwards would make a stale
  // bundle look newer than what it overwrote.
  const store = makeStore();
  const b = await bundleOf({ datasources: [mkDs()] });
  b.bundleVersion = 7;
  const r = await importBundle(store, b, { mode: 'replace-all', now: () => 1000 });
  assert.equal(r.bundleVersion, 8);
  assert.equal((await store.meta()).bundleVersion, 8);
});

test('a rejected bundle still returns the diff, so the user can see why', async () => {
  const store = makeStore({ datasources: [mkDs()] });
  const b = await bundleOf({ datasources: [{ id: 'trades' }] });
  b.checksum = 'sha256:wrong';
  const r = await importBundle(store, b, { mode: 'replace-all' });
  assert.equal(r.applied, false);
  assert.ok(r.errors.length);
  assert.deepEqual(r.diff.datasources.added, ['trades'], 'the diff is still computed');
  assert.equal(store.data.datasources.size, 1, 'and nothing was written');
});

test('a round trip through export and import is a no-op', async () => {
  const store = makeStore({ connections: [mkConn()], datasources: [mkDs()] });
  const b = await exportBundle(store);
  const r = await importBundle(store, b);
  for (const k of ['connections', 'datasources']) {
    assert.deepEqual(r.diff[k].changed, [], `${k} changed on a round trip`);
    assert.deepEqual(r.diff[k].removed, [], `${k} removed on a round trip`);
    assert.deepEqual(r.diff[k].added, [], `${k} added on a round trip`);
  }
});

test('an exported bundle is DETACHED from the store', async () => {
  // Editing an export must not reach back into the live config. IndexedDB
  // deserializes on read and hides this; an in-memory backend does not.
  const store = makeStore({ connections: [mkConn()] });
  const b = await exportBundle(store);
  b.connections[0].url = 'ws://evil:9999';
  assert.equal((await store.all('connections'))[0].url, 'ws://localhost:8081');
});
