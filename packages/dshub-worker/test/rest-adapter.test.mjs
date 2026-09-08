import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RestAdapter, pageUrl, extractRows } from '../src/adapters/rest.mjs';
import { STATE } from '../src/table_actor.mjs';

const res = (body, { ok = true, headers = {} } = {}) => ({
  ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'Error',
  headers: { get: (k) => headers[k] },
  json: async () => body,
});

function harness(over = {}) {
  const calls = [];
  const rows = [], states = [];
  const pages = over.pages ?? [[{ id: 1 }, { id: 2 }]];
  let i = 0;

  const updateAdapters = [];
  const a = new RestAdapter({
    connection: { id: 'c', kind: 'rest', url: 'https://api/positions', ...over.connection },
    datasource: {
      id: 'positions',
      snapshot: { mode: 'rest-then-subscribe', url: 'https://api/positions?desk={desk}',
                  timeoutMs: 5000, endOfSnapshot: { kind: 'stream-end' }, ...over.snapshot },
      updates: { destination: 'positions', bodyShape: 'record-array', ...over.updates },
    },
    params: { desk: 'Govies' },
    onRows: (r, phase) => rows.push([phase, r.length]),
    onState: (s, d) => states.push([s, d]),
    setTimer: () => ({}),
    clearTimer: () => {},
    fetchImpl: over.fetchImpl ?? (async (url) => {
      calls.push(url);
      const page = pages[i++] ?? [];
      return res(page, { headers: over.headers ?? {} });
    }),
    makeUpdateAdapter: over.noUpdates ? undefined : (conn, ds, opts) => {
      const ua = { conn, ds, opts, connected: false, connect() { ua.connected = true; }, close() { ua.closed = true; } };
      updateAdapters.push(ua);
      return ua;
    },
  });
  return { a, calls, rows, states, updateAdapters };
}

// ------------------------------------------------- the ordering rule

test('updates are subscribed BEFORE the snapshot fetch starts', async () => {
  // An HTTP page-through of 500k rows takes tens of seconds. Every update in
  // that window is lost if the subscription comes second — and the grid looks
  // complete while being stale in places.
  const { a, updateAdapters } = harness();
  a.connect();
  assert.equal(updateAdapters.length, 1, 'update transport built');
  assert.equal(updateAdapters[0].connected, true, 'and connected, before any page arrives');
});

test('updates arriving DURING the fetch are buffered and replayed', async () => {
  let resolvePage;
  const gate = new Promise((r) => { resolvePage = r; });
  const { a, rows, updateAdapters } = harness({
    fetchImpl: async () => { await gate; return res([{ id: 1 }]); },
  });
  a.connect();

  // A tick lands while the fetch is still in flight.
  updateAdapters[0].opts.onRows([{ id: 99 }]);
  assert.deepEqual(rows, [], 'not delivered yet — the snapshot has not landed');

  resolvePage();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(rows.some(([phase, n]) => phase === 'live' && n === 1), 'replayed after the snapshot');
  assert.equal(a.bufferedDuringSnapshot, 1);
});

test('updates after the snapshot go straight through', async () => {
  const { a, rows, updateAdapters } = harness();
  a.connect();
  await new Promise((r) => setTimeout(r, 0));
  rows.length = 0;
  updateAdapters[0].opts.onRows([{ id: 5 }]);
  assert.deepEqual(rows, [['live', 1]]);
});

test("the update transport's own `live` does not end our snapshot", async () => {
  // It reports live as soon as it is subscribed, long before the pages arrive.
  const { a, states, updateAdapters } = harness({ fetchImpl: async () => new Promise(() => {}) });
  a.connect();
  updateAdapters[0].opts.onState(STATE.LIVE, 'subscribed');
  assert.equal(states.at(-1)[0], STATE.SNAPSHOTTING);
});

test('a failing update transport fails the datasource', async () => {
  const { a, states, updateAdapters } = harness({ fetchImpl: async () => new Promise(() => {}) });
  a.connect();
  updateAdapters[0].opts.onState(STATE.FAILED, 'auth rejected');
  assert.equal(states.at(-1)[0], STATE.FAILED);
  assert.match(states.at(-1)[1], /auth rejected/);
});

// ------------------------------------------------- pagination

test('offset pagination walks until a short page', async () => {
  const { a, calls, rows } = harness({
    snapshot: { pagination: { style: 'offset', pageSize: 2 } },
    pages: [[{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }], [{ id: 5 }]],
  });
  a.connect();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 3, 'stopped on the short page');
  assert.equal(rows.filter(([p]) => p === 'snapshot').reduce((n, [, c]) => n + c, 0), 5);
});

test('cursor pagination follows the cursor and stops when it is absent', async () => {
  let n = 0;
  const { a, calls } = harness({
    snapshot: { pagination: { style: 'cursor', cursorPath: 'next' } },
    fetchImpl: async (url) => {
      calls.push?.(url);
      n += 1;
      return res(n < 3 ? { rows: [{ id: n }], next: `c${n}` } : { rows: [{ id: n }] });
    },
  });
  a.connect();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(n, 3, 'walked three pages then stopped');
});

test('an empty page ends the walk regardless of style', async () => {
  // What stops a misconfigured cursor looping forever.
  const { a, calls } = harness({
    snapshot: { pagination: { style: 'offset', pageSize: 2 } },
    pages: [[{ id: 1 }, { id: 2 }], []],
  });
  a.connect();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 2);
});

test('params are substituted into the snapshot URL', async () => {
  const { a, calls } = harness();
  a.connect();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(calls[0], /desk=Govies/);
});

// ------------------------------------------------- failures

test('a non-2xx response fails with the status, not a silent empty table', async () => {
  const { a, states } = harness({ fetchImpl: async () => res(null, { ok: false }) });
  a.connect();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(states.at(-1)[0], STATE.FAILED);
  assert.match(states.at(-1)[1], /500/);
});

test('a declared count mismatch fails rather than going live', async () => {
  const { a, states } = harness({
    snapshot: { expectedCountHeader: 'X-Total-Count' },
    headers: { 'X-Total-Count': '99' },
  });
  a.connect();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(states.at(-1)[0], STATE.FAILED);
  assert.match(states.at(-1)[1], /expected 99 rows, received 2/);
});

test('close aborts an in-flight page walk', async () => {
  let pages = 0;
  const { a, updateAdapters } = harness({
    snapshot: { pagination: { style: 'offset', pageSize: 1 } },
    fetchImpl: async () => { pages += 1; return res([{ id: pages }]); },
  });
  a.connect();
  a.close();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(pages <= 2, `walk kept going after close: ${pages} pages`);
  assert.equal(updateAdapters[0].closed, true, 'and the update transport was closed too');
});

// ------------------------------------------------- helpers

test('pageUrl appends correctly whether or not the base has a query', () => {
  assert.equal(pageUrl('https://a/b', { style: 'offset' }, { offset: 0, size: 10 }), 'https://a/b?offset=0&limit=10');
  assert.equal(pageUrl('https://a/b?x=1', { style: 'offset' }, { offset: 0, size: 10 }), 'https://a/b?x=1&offset=0&limit=10');
  assert.equal(pageUrl('https://a/b', { style: 'none' }, {}), 'https://a/b');
});

test('rows are found in a bare array or under a common envelope key', () => {
  // Guessing wrong yields a single row containing the envelope.
  assert.deepEqual(extractRows([{ a: 1 }], null), [{ a: 1 }]);
  assert.deepEqual(extractRows({ rows: [{ a: 1 }] }, null), [{ a: 1 }]);
  assert.deepEqual(extractRows({ data: [{ a: 1 }] }, null), [{ a: 1 }]);
  assert.deepEqual(extractRows({ payload: { items: [{ a: 1 }] } }, { rowsPath: 'payload.items' }), [{ a: 1 }]);
});
