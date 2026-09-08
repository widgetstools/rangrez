/**
 * The ONE-ENTITY editor model (user decision, 2026-09-03).
 *
 * The storage model keeps `connection` and `datasource` separate — the hub,
 * bundle codec and refs all depend on that split. But no two datasources share
 * a connection in practice, so the split is not a USER concept, and making
 * someone create a connection before a datasource is pure ceremony.
 *
 * The editor therefore presents one merged draft. `split` writes the pair
 * (connection id derived from the datasource id), `merge` reads it back, and
 * the storage layer never knows the UI stopped caring.
 */

import { createNormalizer } from '../../dshub-worker/src/normalize.mjs';
import { fieldsFor } from './schemaForm.mjs';

/** connection id for a datasource — deterministic, so re-saves overwrite. */
export const connectionIdFor = (dsId) => `${dsId}.conn`;

/** connection {..} + datasource {..} -> one editable draft. */
export function mergeEntity(connection, datasource) {
  const { id: _cid, ...conn } = connection ?? {};
  const { connectionRef: _ref, ...ds } = datasource ?? {};
  return { ...ds, connection: conn };
}

/** draft -> the {connection, datasource} pair the store persists. */
export function splitEntity(draft) {
  const { connection = {}, ...ds } = draft ?? {};
  const id = ds.id;
  /**
   * The listener topic IS the reply destination on every server seen so far
   * (stern's editor has one field for both). The schema keeps them separate for
   * the servers where they differ, but the editor should not demand the same
   * value twice — so an unset replyDestination defaults from the listener.
   */
  if (ds.snapshot?.mode === 'trigger-reply' && !ds.snapshot.replyDestination && ds.updates?.destination) {
    ds.snapshot = { ...ds.snapshot, replyDestination: ds.updates.destination };
  }
  return {
    connection: { ...connection, id: connectionIdFor(id) },
    datasource: { ...ds, connectionRef: connectionIdFor(id) },
  };
}

/**
 * Per-transport curated Connection-tab paths (stern's shape: ~6 inputs).
 *
 * Presentation only: labels, widgets, enums, help and validation still come
 * from the schema, so this list can only REORDER and OMIT, never invent.
 * `endOfSnapshot.*` expands to whatever the active sentinel branch requires.
 */
export const CONNECTION_TAB = {
  stomp: ['connection.url', 'updates.destination', 'snapshot.triggerDestination',
          'snapshot.triggerBody', 'snapshot.endOfSnapshot.*', 'snapshot.timeoutMs'],
  ws:    ['connection.url', 'updates.destination', 'snapshot.triggerBody',
          'snapshot.endOfSnapshot.*', 'snapshot.timeoutMs'],
  socketio: ['connection.url', 'connection.vhost', 'updates.destination',
             'snapshot.triggerDestination', 'snapshot.triggerBody', 'snapshot.endOfSnapshot.*'],
  rest:  ['snapshot.url', 'snapshot.method', 'snapshot.pagination.style',
          'snapshot.pagination.pageSize', 'connection.updatesUrl', 'updates.destination'],
};

export const BEHAVIOUR_TAB = [
  'batch.maxMs', 'batch.maxRows', 'batch.dedupeByKey',
  'conflation.defaultIntervalMs', 'conflation.maxIntervalMs',
  'updates.updatesDuringSnapshot', 'connection.reconnect.initialMs', 'connection.reconnect.maxMs',
];

/** A new draft per transport, with the snapshot mode that transport implies. */
export function newDraft(kind) {
  const snapshot = {
    stomp:   { mode: 'trigger-reply', endOfSnapshot: { kind: 'sentinel-header' }, timeoutMs: 120000 },
    ws:      { mode: 'trigger-reply', endOfSnapshot: { kind: 'sentinel-body' }, timeoutMs: 120000 },
    socketio:{ mode: 'trigger-reply', endOfSnapshot: { kind: 'sentinel-substring' }, timeoutMs: 120000 },
    rest:    { mode: 'rest-then-subscribe', endOfSnapshot: { kind: 'stream-end' },
               pagination: { style: 'offset', pageSize: 1000 }, timeoutMs: 120000 },
  }[kind] ?? { mode: 'subscribe-only' };
  return {
    id: '', keyColumns: [], schemaRef: '',
    snapshot,
    updates: { destination: '', bodyShape: 'record-array', subscribeBeforeSnapshot: true, updatesDuringSnapshot: 'buffer' },
    flatten: { separator: '_', maxDepth: 4 },
    connection: { kind, url: '', auth: { mode: 'none' } },
  };
}

/**
 * Field metadata for the merged draft, path -> {label, widget, enum, ...}.
 *
 * Built from the SAME schema walk the generated forms use, so the curated tabs
 * cannot drift from what validates: they can only pick from this index.
 */
export function fieldIndex(draft, schema) {
  const idx = new Map();
  for (const f of fieldsFor('datasource', draft, schema)) idx.set(f.path.join('.'), f);
  for (const f of fieldsFor('connection', draft?.connection ?? {}, schema)) {
    idx.set(['connection', ...f.path].join('.'), { ...f, path: ['connection', ...f.path] });
  }
  return idx;
}

/** Expand curated paths (incl. `prefix.*`) against the index, keeping order. */
export function resolveTabPaths(paths, idx) {
  const out = [];
  for (const p of paths) {
    if (p.endsWith('.*')) {
      const prefix = p.slice(0, -2) + '.';
      for (const key of idx.keys()) if (key.startsWith(prefix)) out.push(key);
    } else if (idx.has(p)) {
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------- inference

/**
 * Field inference from probed rows (stern's Infer Fields).
 *
 * Runs the REAL flattener over the sample so the field names are exactly the
 * columns the worker will produce — inference through a simplified flatten
 * would offer fields the table never has.
 */
export function inferFields(rows, datasource) {
  const { flatten } = createNormalizer(
    { ...datasource, id: datasource?.id || 'infer', keyColumns: datasource?.keyColumns?.length ? datasource.keyColumns : [] },
    null,
  );
  const seen = new Map();   // field -> {types:Set, sample}
  for (const raw of rows ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    let flat;
    try { flat = flatten(raw); } catch { continue; }
    for (const [field, value] of Object.entries(flat)) {
      if (!seen.has(field)) seen.set(field, { types: new Set(), sample: value });
      seen.get(field).types.add(typeOf(value));
    }
  }
  return [...seen.entries()]
    .map(([field, { types, sample }]) => ({ field, type: pickType(types), sample }))
    .sort((a, b) => a.field.localeCompare(b.field));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/;
function typeOf(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return ISO_DATE.test(v) ? 'date' : 'string';
  return 'string';
}
/** Mixed types resolve to the widest useful one; null never decides. */
function pickType(types) {
  const t = [...types].filter((x) => x !== 'null');
  if (t.length === 0) return 'string';
  if (t.length === 1) return t[0];
  if (t.every((x) => x === 'date' || x === 'string')) return 'string';
  return 'string';
}

/**
 * Selection -> columns, union-by-field (stern's applyPendingFieldsCols):
 * existing columns keep their edits (header, type); newly selected fields
 * append; nothing is removed here — dropping columns is the Columns tab's job.
 */
export function columnsFromSelection(inferred, selectedFields, existing = []) {
  const byField = new Map(existing.map((c) => [c.field, c]));
  const out = [...existing];
  for (const f of inferred) {
    if (!selectedFields.has(f.field) || byField.has(f.field)) continue;
    out.push({ field: f.field, header: headerFor(f.field), type: f.type });
  }
  return out;
}

export const headerFor = (field) => field
  .split(/[._]/).map((w) => w.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
  .join(' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/**
 * Columns -> the schema artifact the hub resolves via `schemaRef` (§4.4).
 * This is what makes admin onboarding reach the worker: the artifact IS the
 * table schema and the colDef source, stored versioned in IDB.
 */
export function buildArtifact(dsId, columns, keyColumns, { estimatedRows = 0, version = 1 } = {}) {
  return {
    id: dsId, version, estimatedRows,
    keyColumns: [...keyColumns],
    columns: columns.map((c) => ({
      id: c.field, column: c.field, type: c.type === 'date' ? 'datetime' : c.type === 'number' ? 'float' : c.type,
      filter: c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : 'text',
      colDef: { headerName: c.header },
    })),
  };
}

// ---------------------------------------------------------------- portability

/** Per-entity export (stern's portable provider config). */
export function exportEntity(draft, artifact) {
  const { connection, datasource } = splitEntity(draft);
  return { kind: 'dshub-datasource', specVersion: '1.0', connection, datasource, ...(artifact ? { artifact } : {}) };
}

export function importEntity(portable) {
  if (portable?.kind !== 'dshub-datasource') throw new Error('not a dshub-datasource export');
  return {
    draft: mergeEntity(portable.connection, portable.datasource),
    artifact: portable.artifact ?? null,
  };
}
