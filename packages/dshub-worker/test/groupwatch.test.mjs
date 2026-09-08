import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GroupAggregateDiffer, routesToRefresh, groupDeltaMessage } from '../src/groupwatch.mjs';

const grouped = (...specs) => [
  { __ROW_PATH__: [], dv01: 999 },                       // root — always skipped
  ...specs.map(([path, dv01, mv]) => ({ __ROW_PATH__: path, dv01, marketValue: mv })),
];

// ------------------------------------------------- the diff

test('the first feed reports every group as new', () => {
  const d = new GroupAggregateDiffer({ aggregateColumns: ['dv01'] });
  const changed = d.feed(grouped([['Govies'], 100], [['EM Debt'], 200]));
  assert.deepEqual(changed.map((c) => c.path), [['Govies'], ['EM Debt']]);
  assert.ok(changed.every((c) => c.reason === 'new'));
});

test('the ROOT total is never reported as a group', () => {
  const d = new GroupAggregateDiffer({ aggregateColumns: ['dv01'] });
  const changed = d.feed(grouped([['Govies'], 100]));
  assert.ok(!changed.some((c) => c.path.length === 0), 'the grand total is not an AG-Grid node');
});

test('only the groups whose aggregate MOVED are reported on a later feed', () => {
  const d = new GroupAggregateDiffer({ aggregateColumns: ['dv01', 'marketValue'] });
  d.feed(grouped([['Govies'], 100, 10], [['EM Debt'], 200, 20]));
  const changed = d.feed(grouped([['Govies'], 137, 10], [['EM Debt'], 200, 20]));
  assert.deepEqual(changed.map((c) => c.path), [['Govies']], 'EM Debt did not move');
  assert.equal(changed[0].values.dv01, 137);
});

test('a float wobble under epsilon is not a change', () => {
  const d = new GroupAggregateDiffer({ aggregateColumns: ['dv01'], epsilon: 1e-6 });
  d.feed(grouped([['Govies'], 100]));
  assert.equal(d.feed(grouped([['Govies'], 100 + 1e-9])).length, 0);
  assert.equal(d.feed(grouped([['Govies'], 100.5])).length, 1);
});

test('a group that vanished is reported as removed, not left stale', () => {
  // The last leaf left the group; the client must drop the node.
  const d = new GroupAggregateDiffer({ aggregateColumns: ['dv01'] });
  d.feed(grouped([['Govies'], 100], [['EM Debt'], 200]));
  const changed = d.feed(grouped([['Govies'], 100]));
  assert.deepEqual(changed, [{ path: ['EM Debt'], values: null, reason: 'removed' }]);
});

test('a re-appearing group after removal is new again', () => {
  const d = new GroupAggregateDiffer({ aggregateColumns: ['dv01'] });
  d.feed(grouped([['Govies'], 100]));
  d.feed(grouped());                                       // Govies gone
  assert.equal(d.feed(grouped([['Govies'], 100])).map((c) => c.reason)[0], 'new');
});

test('nested paths are tracked independently of their parents', () => {
  const d = new GroupAggregateDiffer({ aggregateColumns: ['dv01'] });
  d.feed([{ __ROW_PATH__: [] }, { __ROW_PATH__: ['Govies'], dv01: 100 }, { __ROW_PATH__: ['Govies', 'Jane'], dv01: 60 }]);
  const changed = d.feed([{ __ROW_PATH__: [] }, { __ROW_PATH__: ['Govies'], dv01: 100 }, { __ROW_PATH__: ['Govies', 'Jane'], dv01: 75 }]);
  assert.deepEqual(changed.map((c) => c.path), [['Govies', 'Jane']], 'only the child moved');
});

// ------------------------------------------------- routes

test('sibling changes collapse to one refresh of their shared parent', () => {
  // Refreshing route [] once re-fetches every top-level group aggregate, so ten
  // desks changing is ONE refresh, not ten.
  const routes = routesToRefresh([['Govies'], ['EM Debt'], ['HY Credit']]);
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0], []);
});

test('a deep change refreshes its parent route, not the whole tree', () => {
  const routes = routesToRefresh([['Govies', 'Jane']]);
  assert.deepEqual(routes, [['Govies']]);
});

test('changes at different depths produce distinct routes', () => {
  const routes = routesToRefresh([['Govies'], ['EM Debt', 'John']]);
  const keys = routes.map((r) => r.join('/')).sort();
  assert.deepEqual(keys, ['', 'EM Debt']);
});

// ------------------------------------------------- the message

test('the wire message carries paths, values and reasons', () => {
  const m = groupDeltaMessage('positions', 'positions', ['desk'],
    [{ path: ['Govies'], values: { dv01: 137 }, reason: 'changed' }]);
  assert.equal(m.type, 'groupDelta');
  assert.deepEqual(m.ref, { datasourceId: 'positions' });
  assert.deepEqual(m.groupBy, ['desk']);
  assert.equal(m.changed[0].values.dv01, 137);
});
