import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeDatasource, defaultParams } from '../src/probe.mjs';

const ds = (over = {}) => ({
  id: 'p', keyColumns: ['id'],
  snapshot: { mode: 'trigger-reply', triggerBody: { req: 'snap' }, timeoutMs: 5000,
              endOfSnapshot: { kind: 'sentinel-body', path: 'type', value: 'end' } },
  updates: { destination: 'rows', bodyShape: 'record-array' },
  params: { clientId: { type: 'string', default: 'trd1' } },
  ...over,
});

function fakeSocketFactory() {
  const sockets = [];
  const openSocket = (url) => {
    const s = {
      url, sent: [],
      send: (d) => s.sent.push(d),
      close: () => { s.closed = true; s.onclose?.({}); },
    };
    sockets.push(s);
    setTimeout(() => s.onopen?.(), 0);
    return s;
  };
  return { openSocket, sockets };
}

test('a successful probe reports rows, count, sentinel and timing', async () => {
  const { openSocket, sockets } = fakeSocketFactory();
  const p = probeDatasource({
    connection: { id: 'c', kind: 'ws', url: 'ws://x' }, datasource: ds(),
    openSocket, timeoutMs: 3000,
  });
  await new Promise((r) => setTimeout(r, 10));
  const s = sockets[0];
  s.onmessage?.({ data: JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]) });
  s.onmessage?.({ data: JSON.stringify({ type: 'end' }) });

  const out = await p;
  assert.equal(out.success, true);
  assert.equal(out.sentinelSeen, true);
  assert.equal(out.rowCount, 3);
  assert.ok(out.states.some((x) => x.state === 'live'));
});

test('the capture is capped at maxRows while the count keeps counting', async () => {
  // First-N is a preview, not an export; the COUNT is what validates the feed.
  const { openSocket, sockets } = fakeSocketFactory();
  const p = probeDatasource({
    connection: { id: 'c', kind: 'ws', url: 'ws://x' }, datasource: ds(),
    openSocket, maxRows: 2, timeoutMs: 3000,
  });
  await new Promise((r) => setTimeout(r, 10));
  sockets[0].onmessage?.({ data: JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i }))) });
  sockets[0].onmessage?.({ data: JSON.stringify({ type: 'end' }) });
  const out = await p;
  assert.equal(out.rows.length, 2);
  assert.equal(out.rowCount, 50);
});

test('the probe is READ-ONLY and tears its socket down on completion', async () => {
  // Leaving it open holds a snapshot subscription against the real server.
  const { openSocket, sockets } = fakeSocketFactory();
  const p = probeDatasource({
    connection: { id: 'c', kind: 'ws', url: 'ws://x' }, datasource: ds(),
    openSocket, timeoutMs: 3000,
  });
  await new Promise((r) => setTimeout(r, 10));
  sockets[0].onmessage?.({ data: JSON.stringify({ type: 'end' }) });
  await p;
  assert.equal(sockets[0].closed, true);
});

test('a timeout says how many rows arrived before it gave up', async () => {
  // "0 rows in 10s" and "5,270 rows then silence" are different diagnoses.
  const { openSocket, sockets } = fakeSocketFactory();
  const p = probeDatasource({
    connection: { id: 'c', kind: 'ws', url: 'ws://x' }, datasource: ds(),
    openSocket, timeoutMs: 60,
  });
  await new Promise((r) => setTimeout(r, 10));
  sockets[0].onmessage?.({ data: JSON.stringify([{ id: 1 }]) });
  const out = await p;
  assert.equal(out.success, false);
  assert.match(out.error, /1 rows seen/);
  assert.equal(sockets[0].closed, true, 'and still tears down');
});

test('a failed state carries the adapter detail verbatim', async () => {
  const { openSocket, sockets } = fakeSocketFactory();
  const p = probeDatasource({
    connection: { id: 'c', kind: 'ws', url: 'ws://x' },
    datasource: ds({ snapshot: { mode: 'trigger-reply', timeoutMs: 5000, expectedCountHeader: 'total',
                                 endOfSnapshot: { kind: 'sentinel-body', path: 'type', value: 'end' } } }),
    openSocket, timeoutMs: 3000,
  });
  await new Promise((r) => setTimeout(r, 10));
  sockets[0].onmessage?.({ data: JSON.stringify([{ id: 1 }]) });
  sockets[0].onmessage?.({ data: JSON.stringify({ type: 'end', total: 99 }) });
  const out = await p;
  assert.equal(out.success, false);
  assert.match(out.error, /expected 99 rows/);
});

test('a sidecar-only transport is named, not a cryptic connect error', async () => {
  const out = await probeDatasource({ connection: { id: 'c', kind: 'amps', url: 'x' }, datasource: ds() });
  assert.match(out.error, /Phase 10, sidecar/);
});

test('an abort settles the probe and closes the socket', async () => {
  const { openSocket, sockets } = fakeSocketFactory();
  const ctl = new AbortController();
  const p = probeDatasource({
    connection: { id: 'c', kind: 'ws', url: 'ws://x' }, datasource: ds(),
    openSocket, timeoutMs: 5000, signal: ctl.signal,
  });
  await new Promise((r) => setTimeout(r, 10));
  ctl.abort();
  const out = await p;
  assert.equal(out.error, 'aborted');
  assert.equal(sockets[0].closed, true);
});

test('params come from the declared defaults', () => {
  assert.deepEqual(defaultParams(ds()), { clientId: 'trd1' });
  assert.deepEqual(defaultParams({}), {});
});
