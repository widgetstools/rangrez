import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validate, validateForWrite, validateBundleRefs, assertNoSecrets } from '../src/validate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(join(HERE, '..', p), 'utf8'));

const configSchema = load('datasource-config.schema.json');
const artifactSchema = load('schema-artifact.schema.json');
const controlSchema = load('control-protocol.schema.json');
const example = load('examples/cmbs-positions.config.json');

const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- exit criteria

test('a real ViewServer datasource config validates', () => {
  assert.deepEqual(validate(example, configSchema), []);
  assert.deepEqual(validateBundleRefs(example), []);
  // Through the WRITE path too — structure alone passing is not the criterion,
  // since validateForWrite is what the admin UI actually calls.
  assert.deepEqual(validateForWrite(example, configSchema), []);
});

test('a password-shaped NAME on a non-scalar is not a secret', () => {
  // `auth: { mode: 'token-from-app' }` is legitimate config. A guard that
  // rejects valid input is a guard someone switches off.
  assert.deepEqual(assertNoSecrets({ auth: { mode: 'token-from-app' } }), []);
  assert.equal(assertNoSecrets({ auth: 'Bearer abc123' }).length, 1);
});

test('config carrying a password-shaped field is rejected', () => {
  for (const field of ['password', 'secret', 'apiKey', 'api_key', 'privateKey', 'passphrase']) {
    const bad = clone(example);
    bad.connections[0][field] = 'hunter2';
    const errs = validateForWrite(bad, configSchema);
    assert.ok(
      errs.some((e) => e.message.includes('password-shaped')),
      `expected "${field}" to be rejected as password-shaped`
    );
  }
});

test('a secret hiding under an innocent key name is still rejected', () => {
  const bad = clone(example);
  bad.connections[0].url = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
  assert.ok(assertNoSecrets(bad).some((e) => e.message.includes('embedded secret')));
});

test('credentialRef is the sanctioned escape hatch and stays legal', () => {
  assert.deepEqual(assertNoSecrets({ credentialRef: 'vault://desk/viewserver' }), []);
});

// ---------------------------------------------------------------- structure

test('unknown properties are refused, so a typo cannot pass silently', () => {
  const bad = clone(example);
  bad.datasources[0].keyColums = ['positionId']; // transposed letters
  const errs = validate(bad, configSchema);
  assert.ok(errs.some((e) => e.path.endsWith('.keyColums') && e.message === 'unknown property'));
});

test("'.' is refused as a flatten separator", () => {
  // AG-Grid resolves a dotted ColDef field as a deep property path (arch §5.2).
  const bad = clone(example);
  bad.datasources[0].flatten.separator = '.';
  assert.ok(validate(bad, configSchema).some((e) => e.path.endsWith('.separator')));
});

test('a snapshot without end-of-snapshot detection is refused', () => {
  // Going live on a silently truncated book is the worst failure in the system.
  const bad = clone(example);
  delete bad.datasources[0].snapshot.endOfSnapshot;
  const errs = validate(bad, configSchema);
  assert.ok(errs.some((e) => e.path.includes('endOfSnapshot') && e.message === 'required'));
});

test('discriminated snapshot union reports against the named variant', () => {
  const bad = clone(example);
  bad.datasources[0].snapshot = { mode: 'file-seed' }; // missing `path`
  const errs = validate(bad, configSchema);
  assert.ok(
    errs.some((e) => e.path.endsWith('.path') && e.message === 'required'),
    'expected the file-seed branch error, not a generic "matched no variant"'
  );
});

test('a dangling connectionRef is caught', () => {
  const bad = clone(example);
  bad.datasources[0].connectionRef = 'viewserver-prod';
  const errs = validateBundleRefs(bad);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /viewserver-prod/);
});

// ---------------------------------------------------------------- other schemas

test('a schema artifact with a 32nds companion column validates', () => {
  const artifact = {
    id: 'cmbs-positions',
    version: 7,
    keyColumns: ['positionId'],
    reviewedBy: 'anand',
    estimatedRows: 500000,
    columns: [
      {
        id: 'counterparty', path: 'counterparty.name', column: 'counterparty_name',
        type: 'string', nullable: true, cardinality: 340, filter: 'set', cascadingValues: true,
        colDef: { headerName: 'Counterparty', width: 180, enableRowGroup: true },
      },
      {
        id: 'price32', path: 'price', column: 'price32', type: 'string',
        companion: { column: 'price32_num', type: 'float', coercion: 'ticks-to-decimal' },
        colDef: { headerName: 'Price', type: 'rightAligned', sortColumn: 'price32_num' },
      },
    ],
    volatileSortColumns: ['price32_num'],
    setFilterColumns: ['counterparty'],
  };
  assert.deepEqual(validate(artifact, artifactSchema), []);
});

test('hello without a bundle checksum still validates, but the pair is what reconcile needs', () => {
  // checksum is optional on the wire (a first-run app has no bundle at all),
  // but reconcile must compare (version, checksum) — architecture §3.6.
  const hello = { id: '1', type: 'hello', protocolVersion: 1, appId: 'blotter' };
  assert.deepEqual(validate(hello, controlSchema), []);

  const withBundle = { ...hello, bundleVersion: 12, bundleChecksum: 'sha256:abc' };
  assert.deepEqual(validate(withBundle, controlSchema), []);
});

test('control messages validate across the union', () => {
  const messages = [
    { id: '2', type: 'subscribe', ref: { datasourceId: 'cmbs-positions', params: { book: 'CMBS' } } },
    { id: '3', type: 'distinctValues', ref: { datasourceId: 'cmbs-positions' }, colId: 'counterparty', limit: 500 },
    { id: '4', type: 'command', ref: { datasourceId: 'cmbs-positions' }, verb: 'annotate', idempotencyKey: 'k-1' },
    { id: '5', type: 'configAck', status: 'conflict', bundleVersion: 12, bundleChecksum: 'sha256:def' },
    { id: '6', type: 'state', ref: { datasourceId: 'cmbs-positions' }, state: 'stale' },
    { id: '7', type: 'error', code: 'snapshot-truncated', message: 'expected 500000 rows, got 412331' },
  ];
  for (const m of messages) {
    assert.deepEqual(validate(m, controlSchema), [], `${m.type} should validate`);
  }
});

test('a command without an idempotency key is refused', () => {
  // A network retry must never double-apply (arch §8.6).
  const bad = { id: '8', type: 'command', ref: { datasourceId: 'cmbs-positions' }, verb: 'annotate' };
  assert.ok(validate(bad, controlSchema).some((e) => e.path.endsWith('.idempotencyKey')));
});

test('an unknown error code is refused, so the UI can exhaustively switch', () => {
  const bad = { id: '9', type: 'error', code: 'kaboom', message: 'x' };
  assert.ok(validate(bad, controlSchema).length > 0);
});

test('a key present with value undefined counts as absent', () => {
  // Structured clone preserves `undefined` keys where JSON.stringify drops
  // them, so the same message arrives differently over a MessagePort than over
  // a WebSocket. Both transports must accept it.
  const hello = { id: '1', type: 'hello', protocolVersion: 1, appId: 'blotter',
                  bundleVersion: undefined, bundleChecksum: undefined };
  assert.deepEqual(validate(hello, controlSchema), []);
});

test('an undefined value does not satisfy a REQUIRED field', () => {
  // Absent is absent — including for the required check, which must still fail.
  const bad = { id: '1', type: 'subscribe', ref: undefined };
  assert.ok(validate(bad, controlSchema).some((e) => e.path.endsWith('.ref')));
});
