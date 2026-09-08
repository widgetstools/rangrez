import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeEntity, splitEntity, connectionIdFor, newDraft, fieldIndex, resolveTabPaths,
  CONNECTION_TAB, inferFields, columnsFromSelection, buildArtifact, headerFor,
  exportEntity, importEntity,
} from '../src/singleForm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(HERE, '../../dshub-spec/datasource-config.schema.json'), 'utf8'));

// ------------------------------------------------- one entity, two records

test('split writes the connection/datasource pair; merge reads it back', () => {
  const draft = { ...newDraft('stomp'), id: 'positions' };
  draft.connection.url = 'ws://localhost:8081';
  const { connection, datasource } = splitEntity(draft);

  assert.equal(connection.id, connectionIdFor('positions'), 'deterministic, so re-saves overwrite');
  assert.equal(datasource.connectionRef, connection.id, 'refs stay consistent by construction');
  assert.equal(datasource.connection, undefined, 'the merged blob never reaches storage');

  const back = mergeEntity(connection, datasource);
  assert.equal(back.connection.url, 'ws://localhost:8081');
  assert.equal(back.connectionRef, undefined, 'and the ref never reaches the UI');
});

test('round trip is lossless for both halves', () => {
  const draft = { ...newDraft('ws'), id: 'x' };
  draft.connection.reconnect = { initialMs: 750 };
  draft.batch = { maxMs: 40 };
  const again = mergeEntity(splitEntity(draft).connection, splitEntity(draft).datasource);
  assert.deepEqual(again.connection.reconnect, { initialMs: 750 });
  assert.deepEqual(again.batch, { maxMs: 40 });
});

// ------------------------------------------------- curated tabs stay honest

test('the curated STOMP tab is ~6 inputs and every one exists in the schema', () => {
  const draft = newDraft('stomp');
  const idx = fieldIndex(draft, schema);
  const paths = resolveTabPaths(CONNECTION_TAB.stomp, idx);
  assert.ok(paths.length >= 6 && paths.length <= 9, `${paths.length} inputs`);
  for (const p of paths) assert.ok(idx.has(p), `${p} is curated but not in the schema walk`);
});

test('endOfSnapshot.* expands to the ACTIVE sentinel branch only', () => {
  const draft = newDraft('stomp');            // sentinel-header
  const idx = fieldIndex(draft, schema);
  const paths = resolveTabPaths(['snapshot.endOfSnapshot.*'], idx);
  assert.ok(paths.includes('snapshot.endOfSnapshot.header'));
  assert.ok(!paths.includes('snapshot.endOfSnapshot.path'), 'sentinel-body field leaked in');
});

test('a curated path that does not validate simply cannot render', () => {
  const idx = fieldIndex(newDraft('stomp'), schema);
  assert.deepEqual(resolveTabPaths(['snapshot.noSuchThing'], idx), []);
});

// ------------------------------------------------- inference

const SAMPLE = [
  { positionId: 'P1', px: 101.5, active: true, asOf: '2026-09-01T10:00', nested: { greeks: { delta: 0.4 } } },
  { positionId: 'P2', px: 99.25, active: false, asOf: '2026-09-02T10:00', nested: { greeks: { delta: 0.5 } } },
];

test('inference runs the REAL flattener, so field names match the table', () => {
  const fields = inferFields(SAMPLE, newDraft('stomp'));
  const names = fields.map((f) => f.field);
  assert.ok(names.includes('nested_greeks_delta'), 'flattened with the configured separator');
  assert.ok(!names.includes('nested'), 'no unflattened object leaks through');
});

test('types are detected per field, dates included', () => {
  const byName = Object.fromEntries(inferFields(SAMPLE, newDraft('stomp')).map((f) => [f.field, f.type]));
  assert.equal(byName.px, 'number');
  assert.equal(byName.active, 'boolean');
  assert.equal(byName.asOf, 'date');
  assert.equal(byName.positionId, 'string');
});

test('a field that is sometimes null keeps its real type', () => {
  const fields = inferFields([{ a: 1 }, { a: null }], newDraft('stomp'));
  assert.equal(fields.find((f) => f.field === 'a').type, 'number');
});

// ------------------------------------------------- selection -> columns

test('newly selected fields append; existing column edits survive', () => {
  // stern's union-by-field: re-running Fields must not clobber a renamed header.
  const inferred = inferFields(SAMPLE, newDraft('stomp'));
  const existing = [{ field: 'px', header: 'Price (clean)', type: 'number' }];
  const out = columnsFromSelection(inferred, new Set(['px', 'positionId']), existing);
  assert.equal(out.find((c) => c.field === 'px').header, 'Price (clean)', 'edit preserved');
  assert.ok(out.find((c) => c.field === 'positionId'), 'new selection appended');
  assert.equal(out.length, 2, 'nothing else added or removed');
});

test('headers read like headers', () => {
  assert.equal(headerFor('positionId'), 'Position Id');
  assert.equal(headerFor('nested_greeks_delta'), 'Nested Greeks Delta');
});

// ------------------------------------------------- the artifact

test('saving columns produces the artifact the hub resolves via schemaRef', () => {
  const a = buildArtifact('positions', [
    { field: 'positionId', header: 'Position Id', type: 'string' },
    { field: 'px', header: 'Price', type: 'number' },
    { field: 'asOf', header: 'As Of', type: 'date' },
  ], ['positionId'], { estimatedRows: 20000 });

  assert.equal(a.id, 'positions');
  assert.equal(a.version, 1);
  assert.deepEqual(a.keyColumns, ['positionId']);
  assert.equal(a.columns.find((c) => c.column === 'px').type, 'float', "Perspective's type, not the UI's");
  assert.equal(a.columns.find((c) => c.column === 'asOf').type, 'datetime');
  assert.equal(a.columns[0].colDef.headerName, 'Position Id');
});

// ------------------------------------------------- portability

test('export/import round-trips one entity, artifact included', () => {
  const draft = { ...newDraft('stomp'), id: 'p' };
  const artifact = buildArtifact('p', [{ field: 'a', header: 'A', type: 'string' }], ['a']);
  const back = importEntity(exportEntity(draft, artifact));
  assert.equal(back.draft.id, 'p');
  assert.equal(back.artifact.columns.length, 1);
});

test('importing something else is refused by name', () => {
  assert.throws(() => importEntity({ kind: 'random-json' }), /not a dshub-datasource/);
});

test('replyDestination defaults from the listener topic', () => {
  // stern's editor has ONE field for both; demanding the same value twice is
  // exactly the verbosity this editor exists to remove.
  const draft = { ...newDraft('stomp'), id: 'x' };
  draft.updates.destination = '/snapshot/positions/trd9';
  const { datasource } = splitEntity(draft);
  assert.equal(datasource.snapshot.replyDestination, '/snapshot/positions/trd9');
});

test('an explicit replyDestination is never overwritten', () => {
  const draft = { ...newDraft('stomp'), id: 'x' };
  draft.updates.destination = '/listen';
  draft.snapshot.replyDestination = '/reply';
  assert.equal(splitEntity(draft).datasource.snapshot.replyDestination, '/reply');
});
