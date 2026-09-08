import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reloadPlan, reloadPlanForBundle, reloadClassAt, changedPaths, strongest } from '../src/reload.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = JSON.parse(readFileSync(join(HERE, '../../dshub-spec/datasource-config.schema.json'), 'utf8'));
const dsSchema = { $defs: root.$defs, $ref: '#/$defs/datasource' };
const connSchema = { $defs: root.$defs, $ref: '#/$defs/connection' };

const ds = (over = {}) => ({
  id: 'positions', connectionRef: 'c1', schemaRef: 'positions@v1',
  keyColumns: ['positionId'],
  snapshot: { mode: 'subscribe-only' },
  conflation: { defaultIntervalMs: 100 },
  batch: { maxMs: 50, maxRows: 500 },
  ...over,
});
const plan = (a, b, s = dsSchema) => reloadPlan(a, b, s, root);

// ------------------------------------------------- the exit criteria

test('changing a conflation interval applies LIVE', () => {
  // Phase 7 exit criterion, and the reason this is schema-driven: it must not
  // cause a re-snapshot of a 500k-row book because someone nudged a timer.
  const p = plan(ds(), ds({ conflation: { defaultIntervalMs: 250 } }));
  assert.equal(p.reload, 'live');
});

test('changing key columns triggers a REBUILD', () => {
  // It invalidates every row identity in the table; applying it live would
  // leave the grid addressing rows that no longer exist under those ids.
  const p = plan(ds(), ds({ keyColumns: ['positionId', 'book'] }));
  assert.equal(p.reload, 'rebuild');
});

// ------------------------------------------------- resolution rules

test('the STRONGEST class in a diff wins', () => {
  const p = plan(ds(), ds({ conflation: { defaultIntervalMs: 250 }, keyColumns: ['a'] }));
  assert.equal(p.reload, 'rebuild');
  assert.deepEqual(p.changes.map((c) => c.reload).sort(), ['live', 'rebuild']);
});

test('a field with no annotation inherits its nearest annotated ANCESTOR', () => {
  // `snapshot` is annotated `resubscribe` as a whole. Defaulting an unannotated
  // leaf to `live` instead would apply a structural change without the restart
  // it needs.
  assert.equal(reloadClassAt(['snapshot', 'timeoutMs'], dsSchema, root), 'resubscribe');
});

test('a field inside a discriminated union resolves through its branch', () => {
  // `snapshot` is a oneOf; the field lives in one branch only.
  assert.equal(reloadClassAt(['snapshot', 'triggerDestination'], dsSchema, root), 'resubscribe');
});

test('an entirely unknown field still inherits, rather than defaulting weak', () => {
  assert.equal(reloadClassAt(['snapshot', 'somethingNew'], dsSchema, root), 'resubscribe');
});

test('connection kind is a RESTART', () => {
  const a = { id: 'c1', kind: 'stomp', url: 'ws://a' };
  assert.equal(plan(a, { ...a, kind: 'ws' }, connSchema).reload, 'restart');
});

test('a connection URL is a resubscribe, not a restart', () => {
  const a = { id: 'c1', kind: 'stomp', url: 'ws://a' };
  assert.equal(plan(a, { ...a, url: 'ws://b' }, connSchema).reload, 'resubscribe');
});

test('no change means no reload', () => {
  assert.equal(plan(ds(), ds()).reload, 'none');
});

// ------------------------------------------------- the diff itself

test('nested objects are compared field by field, not wholesale', () => {
  // Comparing `conflation` as a unit would report the whole object changed and
  // lose which field it was — and with it the reload class.
  const paths = changedPaths(
    { conflation: { defaultIntervalMs: 100, maxIntervalMs: 500 } },
    { conflation: { defaultIntervalMs: 250, maxIntervalMs: 500 } },
  );
  assert.deepEqual(paths, [['conflation', 'defaultIntervalMs']]);
});

test('arrays are compared as values, since order is meaningful', () => {
  assert.deepEqual(changedPaths({ k: ['a', 'b'] }, { k: ['b', 'a'] }), [['k']]);
  assert.deepEqual(changedPaths({ k: ['a'] }, { k: ['a'] }), []);
});

test('strongest orders the ladder correctly', () => {
  assert.equal(strongest('live', 'restart'), 'restart');
  assert.equal(strongest('rebuild', 'resubscribe'), 'rebuild');
  assert.equal(strongest('none', 'live'), 'live');
});

// ------------------------------------------------- whole bundles

test('an added datasource is a restart, not a live tweak', () => {
  const r = reloadPlanForBundle(
    { connections: [], datasources: [] },
    { connections: [], datasources: [ds()] },
    root,
  );
  assert.equal(r.reload, 'restart');
});

test('a removed datasource is a restart — it can only be torn down', () => {
  const r = reloadPlanForBundle(
    { connections: [], datasources: [ds()] },
    { connections: [], datasources: [] },
    root,
  );
  assert.equal(r.plans[0].reload, 'restart');
});

test('an untouched datasource contributes no plan at all', () => {
  const r = reloadPlanForBundle(
    { connections: [], datasources: [ds()] },
    { connections: [], datasources: [ds()] },
    root,
  );
  assert.deepEqual(r.plans, []);
  assert.equal(r.reload, 'none');
});

test('one live tweak among untouched datasources stays live', () => {
  const other = ds({ id: 'other' });
  const r = reloadPlanForBundle(
    { connections: [], datasources: [ds(), other] },
    { connections: [], datasources: [ds({ conflation: { defaultIntervalMs: 250 } }), other] },
    root,
  );
  assert.equal(r.reload, 'live');
  assert.equal(r.plans.length, 1, 'only the datasource that changed');
  assert.equal(r.plans[0].id, 'positions');
});

test('an annotation BESIDE a $ref is not lost to the deref', () => {
  // `{"$ref": "#/$defs/id", "x-reloadClass": "restart"}` — dereferencing first
  // and reading the annotation off the TARGET drops it. `connection.id`
  // reported `none` and would have been applied as a live edit, when changing
  // a connection's id invalidates every datasource pointing at it.
  assert.equal(reloadClassAt(['id'], connSchema, root), 'restart');
});

test('the local annotation wins over the target it references', () => {
  const schema = {
    $defs: {
      thing: { type: 'object', 'x-reloadClass': 'live', properties: { a: { type: 'string' } } },
      holder: { type: 'object', properties: { t: { $ref: '#/$defs/thing', 'x-reloadClass': 'restart' } } },
    },
  };
  const s = { $defs: schema.$defs, $ref: '#/$defs/holder' };
  assert.equal(reloadClassAt(['t'], s, schema), 'restart', 'the more specific annotation');
});
