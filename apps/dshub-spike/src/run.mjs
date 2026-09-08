/**
 * Phase 0 spike — measure the things that would change the plan.
 *
 * Runs against Perspective 5.3.0 (@perspective-dev/*), NOT the deprecated
 * @finos/perspective 3.x the architecture was written against.
 *
 * Prints a table of findings. Numbers here are the input to the go/no-go memo.
 */

import * as psp from '@perspective-dev/client/dist/esm/perspective.node.js';

const MB = (b) => (b / 1e6).toFixed(1) + ' MB';
const ms = (n) => n.toFixed(1) + ' ms';
const findings = [];
const record = (k, v, note = '') => { findings.push([k, String(v), note]); console.log(`  ${k.padEnd(34)} ${String(v).padEnd(22)} ${note}`); };

async function heap() {
  const i = await psp.system_info();
  return { size: i.heap_size, used: i.used_size };
}

/** Synthetic FI rows in the shape the docs describe: 160 cols, mixed types. */
function makeColumns(rows, cols, offset = 0) {
  const books = ['CMBS', 'RMBS', 'ABS', 'CLO'];
  const cps = Array.from({ length: 340 }, (_, i) => `Broker ${i}`);
  const data = {
    positionId: Array.from({ length: rows }, (_, i) => `P${String(offset + i).padStart(9, '0')}`),
    book: Array.from({ length: rows }, (_, i) => books[i % books.length]),
    counterparty: Array.from({ length: rows }, (_, i) => cps[i % cps.length]),
    tradeDate: Array.from({ length: rows }, (_, i) => new Date(Date.UTC(2026, 0, 1 + (i % 365)))),
    notional: Array.from({ length: rows }, (_, i) => (i % 1000) * 1000),
    dv01: Array.from({ length: rows }, (_, i) => (i % 997) * 1.25),
    px: Array.from({ length: rows }, (_, i) => 99 + (i % 32) / 32),
    active: Array.from({ length: rows }, (_, i) => i % 2 === 0),
  };
  // Pad to `cols` with a realistic float/string mix.
  let n = Object.keys(data).length;
  for (let c = 0; n < cols; c++, n++) {
    const key = c % 3 === 0 ? `attr_s${c}` : `attr_f${c}`;
    data[key] = c % 3 === 0
      ? Array.from({ length: rows }, (_, i) => `V${i % 500}`)
      : Array.from({ length: rows }, (_, i) => (i % 10_000) * 0.25);
  }
  return data;
}

console.log('\n=== 0. environment ===');
record('perspective', '5.3.0', '@perspective-dev/* (…/perspective 3.x is deprecated)');
record('memory64 supported', psp.host_supports_memory64(), 'loader prefers it, falls back to wasm32');
const info0 = await psp.system_info();
record('cpu_time_epoch', info0.cpu_time_epoch, 'engine reports CPU accounting');

// ---------------------------------------------------------------- item 1
console.log('\n=== 1. working set: 10 tables, 2 large + 8 small ===');
const base = await heap();
const tables = [];

/**
 * Build in chunks. The JS->wasm bridge JSON-stringifies the payload, and one
 * 500k x 160 object exceeds V8's max string length — a bridge limit, not an
 * engine one. Chunking is also what the hub does anyway (micro-batches), so
 * this measures the realistic path.
 */
const CHUNK = 25_000;
async function buildTable(rows, cols) {
  const t = await psp.table(makeColumns(Math.min(CHUNK, rows), cols, 0), { index: 'positionId' });
  for (let off = CHUNK; off < rows; off += CHUNK) {
    await t.update(makeColumns(Math.min(CHUNK, rows - off), cols, off));
  }
  return t;
}

let t0 = performance.now();
for (let i = 0; i < 2; i++) tables.push(await buildTable(500_000, 160));
const afterLarge = await heap();
record('2 x 500k x 160 built in', ms(performance.now() - t0), '');
// NOT reported as a memory figure. `used_size` is not a monotonic counter here
// and these deltas came out NEGATIVE, which proves the method wrong rather than
// the engine. Per-table memory is measured correctly in the browser instead —
// see docs/phase-0-findings.md §8 and apps/dshub-spike/web.
record('  per-table memory', 'see §8', 'this method is unreliable; do not use it');

t0 = performance.now();
for (let i = 0; i < 8; i++) tables.push(await buildTable(50_000, 160));
const afterAll = await heap();
record('+ 8 x 50k x 160 built in', ms(performance.now() - t0), '');
record('  engine heap reserved', MB(afterAll.size), 'reserved is meaningful; used_size deltas are not');

// ---------------------------------------------------------------- item 2
console.log('\n=== 2. 100 concurrent grouped views (SSRM node expansion) ===');
const big = tables[0];
const beforeViews = await heap();
t0 = performance.now();
const views = [];
for (let i = 0; i < 100; i++) {
  views.push(await big.view({
    group_by: ['book', 'counterparty'],
    aggregates: { notional: 'sum', dv01: 'sum' },
    filter: [['notional', '>', (i % 50) * 1000]],
  }));
}
const viewsBuilt = performance.now() - t0;
const afterViews = await heap();
record('100 views created', ms(viewsBuilt), `${ms(viewsBuilt / 100)} each`);
record('  incremental memory', MB(afterViews.used - beforeViews.used), MB((afterViews.used - beforeViews.used) / 100) + ' per view');

t0 = performance.now();
for (const v of views) await v.delete();
const afterDispose = await heap();
const leaked = afterDispose.used - beforeViews.used;
record('100 views disposed', ms(performance.now() - t0), '');
record('  memory returned', MB(leaked), leaked < (afterViews.used - beforeViews.used) * 0.1 ? 'OK — returns to baseline' : 'LEAK — investigate');

// ---------------------------------------------------------------- item 3
console.log('\n=== 3. update throughput at a sort-key column ===');
const sorted = await big.view({ sort: [['px', 'desc']] });
let applied = 0;
t0 = performance.now();
for (let batch = 0; batch < 20; batch++) {
  const n = 1000;
  await big.update({
    positionId: Array.from({ length: n }, (_, i) => `P${String((batch * n + i) % 500_000).padStart(9, '0')}`),
    px: Array.from({ length: n }, () => 99 + Math.floor(Math.random() * 32) / 32),
  });
  applied += n;
}
const elapsed = performance.now() - t0;
record('20k updates on sort key', ms(elapsed), Math.round(applied / (elapsed / 1000)).toLocaleString() + ' rows/sec');
await sorted.delete();

// ---------------------------------------------------------------- item 6
console.log('\n=== 6. read format at 160 columns ===');
const win = await big.view();
for (const [name, fn] of [
  ['to_columns', () => win.to_columns({ start_row: 0, end_row: 5000 })],
  ['to_json', () => win.to_json({ start_row: 0, end_row: 5000 })],
  ['to_arrow', () => win.to_arrow({ start_row: 0, end_row: 5000 })],
]) {
  try {
    await fn(); // warm
    const s = performance.now();
    for (let i = 0; i < 5; i++) await fn();
    record(`  ${name} (5k rows)`, ms((performance.now() - s) / 5), '');
  } catch (e) { record(`  ${name}`, 'unsupported', e.message.slice(0, 40)); }
}
await win.delete();

// ---------------------------------------------------------------- item 4
console.log('\n=== 4. aggregations ===');
const aggTests = [
  ['sum', { notional: 'sum' }],
  ['avg', { dv01: 'avg' }],
  ['weighted mean (native)', { dv01: ['weighted mean', 'notional'] }],
  ['first by order', { px: 'first' }],
  ['last by order', { px: 'last' }],
  ['distinct count', { counterparty: 'distinct count' }],
  ['median', { dv01: 'median' }],
];
for (const [label, aggregates] of aggTests) {
  try {
    const v = await big.view({ group_by: ['book'], aggregates });
    const out = await v.to_columns();
    await v.delete();
    record(`  ${label}`, 'OK', Object.keys(out).length + ' cols returned');
  } catch (e) { record(`  ${label}`, 'UNSUPPORTED', e.message.slice(0, 50)); }
}

// DV01-weighted spread via the sum-decomposition path: no engine support needed.
try {
  const v = await big.view({
    group_by: ['book'],
    expressions: { wx: '"dv01" * "px"' },
    aggregates: { wx: 'sum', dv01: 'sum' },
  });
  const c = await v.to_columns();
  const ratio = c.wx.map((w, i) => (c.dv01[i] ? w / c.dv01[i] : null));
  await v.delete();
  record('  weighted via sum(w*x)/sum(w)', 'OK', `e.g. ${ratio[1]?.toFixed(4)} — needs no engine support`);
} catch (e) { record('  weighted via decomposition', 'FAILED', e.message.slice(0, 50)); }

// ---------------------------------------------------------------- item 7
console.log('\n=== 7. VRM feasibility: is the expanded tree a flat indexed list? ===');
try {
  const tree = await big.view({ group_by: ['book', 'counterparty'], aggregates: { notional: 'sum' } });
  const n0 = await tree.num_rows();
  const head = await tree.to_columns({ start_row: 0, end_row: 5 });
  record('  collapsed rows', n0, '__ROW_PATH__ present: ' + ('__ROW_PATH__' in head));
  if (typeof tree.expand === 'function') {
    await tree.expand(1);
    const n1 = await tree.num_rows();
    const win2 = await tree.to_columns({ start_row: 0, end_row: 10 });
    record('  after expand(1)', n1, `+${n1 - n0} rows, window read OK: ${Array.isArray(win2.__ROW_PATH__)}`);
    await tree.collapse(1);
    record('  after collapse(1)', await tree.num_rows(), (await tree.num_rows()) === n0 ? 'returns to baseline' : 'DRIFT');
  } else record('  expand/collapse', 'ABSENT', 'VRM would need a different mechanism');
  await tree.delete();
} catch (e) { record('  tree view', 'FAILED', e.message.slice(0, 60)); }

// ---------------------------------------------------------------- teardown
console.log('\n=== teardown ===');
for (const t of tables) await t.delete();
const end = await heap();
record('after disposing all tables', MB(end.used - base.used), 'residual vs. start');

console.log('\n=== summary ===');
console.log(findings.map(([k, v, n]) => `${k}\t${v}\t${n}`).join('\n'));
process.exit(0);
