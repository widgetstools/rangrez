import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fieldsFor, widgetFor, labelFor, discriminatorOf, activeBranch, writePath, readPath,
} from '../src/schemaForm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(HERE, '../../dshub-spec/datasource-config.schema.json'), 'utf8'));
const paths = (fields) => fields.map((f) => f.path.join('.'));

// ------------------------------------------------- why this is generated

test('every schema field is reachable in the form', () => {
  // A hand-written form is a SECOND definition of what a connection is: add a
  // field to the schema and the form silently cannot set it.
  const f = paths(fieldsFor('connection', { kind: 'stomp' }, schema));
  for (const expected of ['id', 'kind', 'url', 'credentialRef', 'reconnect.initialMs', 'updatesUrl']) {
    assert.ok(f.includes(expected), `${expected} is not editable`);
  }
});

test('enum options come from the schema, so the form cannot offer an invalid one', () => {
  const kind = fieldsFor('connection', {}, schema).find((f) => f.key === 'kind');
  assert.deepEqual(kind.enum, ['stomp', 'ws', 'socketio', 'rest', 'amps', 'solace']);
});

test('each field carries its reload class, so the editor can warn before saving', () => {
  const f = fieldsFor('datasource', { snapshot: { mode: 'subscribe-only' } }, schema);
  assert.equal(f.find((x) => x.key === 'keyColumns').reload, 'rebuild');
  assert.equal(f.find((x) => x.path.join('.') === 'conflation.defaultIntervalMs').reload, 'live');
});

// ------------------------------------------------- discriminated unions

test('only the ACTIVE branch of a union is offered', () => {
  // Showing every branch at once offers `triggerDestination` alongside `url`
  // and lets someone build a config that validates as neither.
  const trigger = paths(fieldsFor('datasource', { snapshot: { mode: 'trigger-reply' } }, schema));
  assert.ok(trigger.includes('snapshot.triggerDestination'));
  assert.ok(!trigger.includes('snapshot.url'), 'a REST-only field leaked in');

  const rest = paths(fieldsFor('datasource', { snapshot: { mode: 'rest-then-subscribe' } }, schema));
  assert.ok(rest.includes('snapshot.url'));
  assert.ok(!rest.includes('snapshot.triggerDestination'));
});

test('the discriminator itself is editable — it is how you switch branch', () => {
  const mode = fieldsFor('datasource', { snapshot: { mode: 'subscribe-only' } }, schema)
    .find((f) => f.path.join('.') === 'snapshot.mode');
  assert.ok(mode);
  assert.ok(mode.enum.includes('trigger-reply'));
  assert.ok(mode.enum.includes('file-seed'));
});

test('the discriminator is found by `const`, not by guessing which branch validates', () => {
  // Guessing picks the wrong branch whenever branches overlap, and the editor
  // then rewrites fields the user never touched.
  assert.equal(discriminatorOf(schema.$defs.snapshot, schema), 'mode');
});

test('an unset discriminator yields no branch fields rather than a wrong guess', () => {
  const f = paths(fieldsFor('datasource', { snapshot: {} }, schema));
  assert.ok(f.includes('snapshot.mode'));
  assert.ok(!f.includes('snapshot.triggerDestination'));
});

test('activeBranch returns null when nothing matches', () => {
  assert.equal(activeBranch(schema.$defs.snapshot, { mode: 'nonsense' }, schema), null);
});

// ------------------------------------------------- widgets and labels

test('widgets are derived from type and format', () => {
  assert.equal(widgetFor({ type: 'boolean' }), 'checkbox');
  assert.equal(widgetFor({ type: 'integer' }), 'number');
  assert.equal(widgetFor({ type: 'array' }), 'list');
  assert.equal(widgetFor({ type: 'string', format: 'uri' }), 'url');
  assert.equal(widgetFor({ enum: ['a', 'b'] }), 'radio', 'few options: radio');
  assert.equal(widgetFor({ enum: ['a', 'b', 'c', 'd', 'e'] }), 'select', 'many: select');
});

test('a nullable type does not become a text box', () => {
  assert.equal(widgetFor({ type: ['integer', 'null'] }), 'number');
});

test('labels are readable without a translation table', () => {
  assert.equal(labelFor('triggerDestination'), 'Trigger Destination');
  assert.equal(labelFor('maxMs'), 'Max Ms');
  assert.equal(labelFor('client_id'), 'Client id');
});

// ------------------------------------------------- binding

test('writePath creates missing intermediate objects', () => {
  assert.deepEqual(writePath({}, ['reconnect', 'initialMs'], 500), { reconnect: { initialMs: 500 } });
});

test('an emptied field is REMOVED, not set to an empty string', () => {
  // `{selector: ''}` and `{}` mean different things to a subscription, and the
  // schema treats a present-but-empty required field as satisfied.
  assert.deepEqual(writePath({ a: 'x' }, ['a'], ''), {});
  assert.deepEqual(writePath({ a: 'x' }, ['a'], undefined), {});
});

test('writePath does not mutate the original', () => {
  const before = { reconnect: { initialMs: 500 } };
  const after = writePath(before, ['reconnect', 'initialMs'], 1000);
  assert.equal(before.reconnect.initialMs, 500);
  assert.equal(after.reconnect.initialMs, 1000);
});

test('readPath survives a missing branch', () => {
  assert.equal(readPath({}, ['a', 'b', 'c']), undefined);
});

// ------------------------------------------------- progressive disclosure

import { sectionsFor } from '../src/schemaForm.mjs';

test('a NEW connection shows three inputs, not seventeen', () => {
  // The verbosity complaint in one number: required-or-set is what renders.
  const sections = sectionsFor('connection', { kind: 'stomp' }, schema);
  const visible = sections.flatMap((s) => s.visible);
  assert.deepEqual(visible.map((f) => f.path.join('.')).sort(), ['id', 'kind', 'url']);
});

test('everything else is still reachable, folded per card', () => {
  const sections = sectionsFor('connection', { kind: 'stomp' }, schema);
  const total = sections.reduce((n, s) => n + s.visible.length + s.hidden.length, 0);
  assert.equal(total, 17, 'nothing was lost, only folded');
});

test('an optional field stays FOLDED even when set — with a visible count', () => {
  // The editing surface is the ~10 decisions a human makes. The seed config
  // sets many optional fields, so "set" is no signal of what belongs on
  // screen; the fold label carries "· N set" so nothing is hidden silently.
  const sections = sectionsFor('connection', { kind: 'stomp', vhost: 'prod' }, schema);
  const basics = sections.find((s) => s.key === '_basics');
  assert.ok(!basics.visible.some((f) => f.key === 'vhost'), 'set but optional: folded');
  assert.ok(basics.hidden.find((f) => f.key === 'vhost').isSet);
  assert.equal(basics.hiddenSet >= 1, true, 'and counted in the fold label');
});

test('a POPULATED datasource shows the same lean surface as a new one', () => {
  // The complaint, as a number: this was ~32 visible inputs.
  const populated = {
    id: 'positions', connectionRef: 'c', schemaRef: 'p@v1', keyColumns: ['id'],
    snapshot: { mode: 'trigger-reply', triggerDestination: '/t', replyDestination: '/r',
                timeoutMs: 120000, quietPeriodMs: 200,
                endOfSnapshot: { kind: 'sentinel-header', header: 'h', value: 'v' } },
    updates: { destination: '/r', bodyShape: 'record-array', subscribeBeforeSnapshot: true, updatesDuringSnapshot: 'buffer' },
    batch: { maxMs: 50, maxRows: 500 }, conflation: { defaultIntervalMs: 100 },
  };
  const visible = sectionsFor('datasource', populated, schema).flatMap((s) => s.visible);
  assert.ok(visible.length <= 12, `still ${visible.length} inputs on screen`);
});

test('fields group into cards by top-level key', () => {
  const sections = sectionsFor('datasource', { snapshot: { mode: 'trigger-reply' } }, schema);
  const snap = sections.find((s) => s.key === 'snapshot');
  assert.ok(snap, 'snapshot is its own card');
  assert.ok(snap.fields.every((f) => f.path[0] === 'snapshot'));
});

test('labels are relative to the card, not dotted paths', () => {
  const sections = sectionsFor('datasource', { snapshot: { mode: 'trigger-reply' } }, schema);
  const snap = sections.find((s) => s.key === 'snapshot');
  const kind = snap.fields.find((f) => f.path.join('.') === 'snapshot.endOfSnapshot.kind');
  assert.equal(kind.label, 'End Of Snapshot › Kind');
});

test('a card carries the strongest reload consequence inside it', () => {
  const sections = sectionsFor('datasource', { snapshot: { mode: 'subscribe-only' } }, schema);
  assert.equal(sections.find((s) => s.key === 'snapshot').reload, 'resubscribe');
});

test('an untouched optional card starts collapsed', () => {
  const sections = sectionsFor('connection', { kind: 'stomp' }, schema);
  const reconnect = sections.find((s) => s.key === 'reconnect');
  assert.equal(reconnect.collapsed, true);
  assert.ok(reconnect.hidden.length > 0);
});
