/**
 * The real StompAdapter against the real server — the same code path the worker
 * will run, with only the socket factory differing from the unit tests.
 */
import { readFileSync } from 'node:fs';
import { StompAdapter } from '../../../packages/dshub-worker/src/adapters/stomp.mjs';
import { createNormalizer } from '../../../packages/dshub-worker/src/normalize.mjs';
import { TableActor, STATE } from '../../../packages/dshub-worker/src/table_actor.mjs';

const cfg = JSON.parse(readFileSync(new URL('../../../packages/dshub-spec/examples/positions-stomp.config.json', import.meta.url), 'utf8'));
const connection = cfg.connections[0];
const datasource = cfg.datasources[0];
const params = { clientId: 'trd1', rate: 2000, batchSize: 10 };

const states = [];
const table = { rows: 0, update(b) { this.rows += b.__key?.length ?? 0; } };
const actor = new TableActor({ table, batch: { maxMs: 50, maxRows: 5000, dedupeByKey: true } });
const n = createNormalizer(datasource, null);
let snapshotRows = 0, liveRows = 0, wentLive = null;
const t0 = Date.now();

const adapter = new StompAdapter({
  connection, datasource, params,
  openSocket: (url) => new WebSocket(url),
  onRows: (rows, phase) => {
    const norm = rows.map((r) => n.normalize(r).rows[0]);
    if (phase === 'snapshot') { snapshotRows += rows.length; actor.push(norm); }
    else { liveRows += rows.length; actor.push(norm); }
  },
  onState: (s, d) => {
    states.push(d ? `${s}(${d})` : s);
    console.log(`  [+${String(Date.now() - t0).padStart(5)}ms] ${s}${d ? ' — ' + d : ''}`);
    if (s === STATE.SNAPSHOTTING) { actor.transition(STATE.CONNECTING); actor.beginSnapshot('buffer'); }
    if (s === STATE.LIVE) { wentLive = Date.now() - t0; actor.endSnapshot(); }
  },
});

console.log(`adapter -> ${connection.url}`);
adapter.connect();

setTimeout(() => {
  actor.flush();
  adapter.close();
  console.log('\n=== result ===');
  console.log('  snapshot rows      ', snapshotRows.toLocaleString());
  console.log('  live rows          ', liveRows.toLocaleString());
  console.log('  went live at       ', wentLive + 'ms');
  console.log('  actor state        ', actor.state);
  console.log('  rows into table    ', table.rows.toLocaleString());
  console.log('  conflation ratio   ', actor.conflationRatio.toFixed(3));
  console.log('  states             ', states.map((s) => s.split('(')[0]).join(' -> '));
  process.exit(actor.state === STATE.LIVE && snapshotRows === 20000 ? 0 : 1);
}, 8000);
