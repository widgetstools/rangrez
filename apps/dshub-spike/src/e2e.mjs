/**
 * End-to-end against the real feed and the real engine.
 *
 *   STOMP -> normalize -> TableActor (micro-batch + dedupe) -> Perspective
 *
 * This is Phase 2's exit criteria run on real data rather than fixtures:
 * snapshot atomicity, convergence with a naive fold, and conflation.
 */

import { readFileSync } from 'node:fs';
import * as psp from '@perspective-dev/client/dist/esm/perspective.node.js';
import { createNormalizer } from '../../../packages/dshub-worker/src/normalize.mjs';
import { TableActor, STATE } from '../../../packages/dshub-worker/src/table_actor.mjs';

const CORPUS = '../../../packages/dshub-spec/corpus/positions/raw.jsonl';
const artifact = JSON.parse(readFileSync(new URL('../../../packages/dshub-spec/corpus/positions/artifact.json', import.meta.url)));
const lines = readFileSync(new URL(CORPUS, import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const snapshot = lines.filter((l) => l.phase === 'snapshot').map((l) => l.row);
const live = lines.filter((l) => l.phase === 'live').map((l) => l.row);
const complete = lines.find((l) => l.phase === 'complete');

const ms = (n) => n.toFixed(0) + ' ms';
const line = (k, v, n = '') => console.log(`  ${k.padEnd(36)} ${String(v).padEnd(16)} ${n}`);

// The datasource config this feed actually needs, derived from what the probe saw.
const datasource = {
  id: 'positions',
  keyColumns: ['positionId'],
  // No op field: this feed has no insert/update/delete token. Every message is
  // an upsert, which is `updates`-only in the config model.
  flatten: { separator: '_', maxDepth: 6 },
  coercions: [],
};

console.log(`\ncorpus: ${snapshot.length} snapshot + ${live.length} live`);
line('completion frame', complete?.headers['message-type'] ?? '(none)', (complete?.body ?? '').slice(0, 60));

// ---------------------------------------------------------------- normalize
const n = createNormalizer(datasource, artifact);
let t0 = performance.now();
const snapRows = snapshot.map((r) => n.normalize(r).rows[0]);
line('normalize snapshot', ms(performance.now() - t0), `${Object.keys(snapRows[0]).length} columns per row`);

t0 = performance.now();
const liveRows = live.map((r) => n.normalize(r).rows[0]);
line('normalize live', ms(performance.now() - t0), '');

// ---------------------------------------------------------------- ingest
const table = await psp.table({ positionId: [snapRows[0].positionId] }, { index: 'positionId' });
const states = [];
const actor = new TableActor({
  table: { update: (block) => pending.push(block) },
  batch: { maxMs: 50, maxRows: 5000, dedupeByKey: true },
  onState: (s, d) => states.push(d ? `${s}(${d})` : s),
});
let pending = [];
const drain = async () => { for (const b of pending) await table.update(b); pending = []; };

actor.transition(STATE.CONNECTING);
actor.beginSnapshot('buffer');

t0 = performance.now();
for (let i = 0; i < snapRows.length; i += 1000) actor.push(snapRows.slice(i, i + 1000));

// The exit criterion: the count in the completion frame must match what arrived.
const declared = Number(/All (\d+) positions/.exec(complete?.body ?? '')?.[1] ?? NaN);
const ok = actor.endSnapshot({ expectedRows: declared, actualRows: snapshot.length });
await drain();
line('snapshot applied', ms(performance.now() - t0), `declared ${declared}, received ${snapshot.length}`);
line('  state', actor.state, ok ? 'went live' : 'FAILED (correct if counts differ)');
line('  rows in table', (await table.size()).toLocaleString(), '');

// ---------------------------------------------------------------- live
t0 = performance.now();
for (const r of liveRows) actor.push([r]);
actor.flush();
await drain();
line('live applied', ms(performance.now() - t0), '');
line('  conflation ratio', actor.conflationRatio.toFixed(3), `${actor.rowsIn} in -> ${actor.rowsOut} out`);
line('  rows in table', (await table.size()).toLocaleString(), 'unchanged = all updates hit existing keys');

// ---------------------------------------------------------------- convergence
// Naive fold over the same sequence, then compare a sample of keys field by field.
const oracle = new Map();
for (const row of [...snapRows, ...liveRows]) {
  const { __key, __op, ...fields } = row;
  oracle.set(__key, { ...(oracle.get(__key) ?? {}), ...fields });
}
const view = await table.view();
const cols = await view.to_columns();
await view.delete();

const idIdx = new Map(cols.positionId.map((id, i) => [id, i]));
let checked = 0, mismatches = [];
for (const [key, want] of oracle) {
  if (checked >= 500) break;
  const i = idIdx.get(key);
  if (i === undefined) { mismatches.push(`${key}: missing from table`); continue; }
  for (const [c, v] of Object.entries(want)) {
    if (!(c in cols)) continue;
    const got = cols[c][i];
    const same = typeof v === 'number' && typeof got === 'number'
      ? Math.abs(v - got) < 1e-6
      : (v instanceof Date ? +v === +new Date(got) : String(v) === String(got));
    if (!same) { mismatches.push(`${key}.${c}: fold=${JSON.stringify(v)} table=${JSON.stringify(got)}`); break; }
  }
  checked++;
}
line('convergence vs naive fold', mismatches.length === 0 ? 'MATCH' : `${mismatches.length} MISMATCH`, `${checked} keys checked`);
for (const m of mismatches.slice(0, 5)) console.log('     ', m);

// ---------------------------------------------------------------- truncation
console.log('\n=== snapshot truncation must fail, not go live ===');
const a2 = new TableActor({ table: { update: () => {} } });
a2.transition(STATE.CONNECTING);
a2.beginSnapshot('buffer');
const bad = a2.endSnapshot({ expectedRows: declared, actualRows: declared - 1 });
line('one row short', bad ? 'went live (WRONG)' : 'refused', `state=${a2.state}`);

await table.delete();
console.log('\nstates observed:', states.join(' -> '));
process.exit(mismatches.length === 0 && !bad ? 0 : 1);
