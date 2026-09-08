/**
 * Focused re-test of the two Phase 0 results whose methodology was flawed.
 *
 * Run 1 reported 2.5s per view creation, which would be fatal for SSRM. But
 * every view in that run had a UNIQUE FILTER over 500k rows plus a two-level
 * group_by, so it may have measured full rescans rather than view creation.
 * And the VRM test misused expand/collapse — they take a row index, not a
 * depth, so `expand(1)` expanded row 1, not level 1.
 *
 * This isolates: view creation vs first materialisation, filter cost, group_by
 * depth, and the actual tree API.
 */

import * as psp from '@perspective-dev/client/dist/esm/perspective.node.js';

const ms = (n) => n.toFixed(1) + ' ms';
const line = (k, v, n = '') => console.log(`  ${k.padEnd(38)} ${String(v).padEnd(14)} ${n}`);

const ROWS = 200_000, CHUNK = 25_000;
const books = ['CMBS', 'RMBS', 'ABS', 'CLO'];
const cps = Array.from({ length: 340 }, (_, i) => `Broker ${i}`);

function chunk(rows, offset) {
  return {
    positionId: Array.from({ length: rows }, (_, i) => `P${String(offset + i).padStart(9, '0')}`),
    book: Array.from({ length: rows }, (_, i) => books[(offset + i) % books.length]),
    counterparty: Array.from({ length: rows }, (_, i) => cps[(offset + i) % cps.length]),
    notional: Array.from({ length: rows }, (_, i) => ((offset + i) % 1000) * 1000),
    dv01: Array.from({ length: rows }, (_, i) => ((offset + i) % 997) * 1.25),
    px: Array.from({ length: rows }, (_, i) => 99 + ((offset + i) % 32) / 32),
  };
}

console.log(`\nbuilding ${ROWS.toLocaleString()} x 6 …`);
const t = await psp.table(chunk(CHUNK, 0), { index: 'positionId' });
for (let o = CHUNK; o < ROWS; o += CHUNK) await t.update(chunk(Math.min(CHUNK, ROWS - o), o));
console.log(`  rows: ${(await t.size()).toLocaleString()}`);

// ---------------------------------------------------------------- creation vs read
console.log('\n=== is view() lazy? separate creation from first read ===');
for (const [label, cfg] of [
  ['flat (no group_by)', {}],
  ['group_by 1 col', { group_by: ['book'] }],
  ['group_by 1 col + 2 aggs', { group_by: ['book'], aggregates: { notional: 'sum', dv01: 'sum' } }],
  ['group_by 2 cols + 2 aggs', { group_by: ['book', 'counterparty'], aggregates: { notional: 'sum', dv01: 'sum' } }],
  ['group_by 2 + aggs + filter', { group_by: ['book', 'counterparty'], aggregates: { notional: 'sum', dv01: 'sum' }, filter: [['notional', '>', 5000]] }],
]) {
  let s = performance.now();
  const v = await t.view(cfg);
  const create = performance.now() - s;
  s = performance.now();
  await v.to_columns({ start_row: 0, end_row: 50 });
  const read = performance.now() - s;
  await v.delete();
  line(label, ms(create), `first read ${ms(read)}`);
}

// ---------------------------------------------------------------- N concurrent
console.log('\n=== N concurrent views, identical config (the SSRM sibling-node case) ===');
for (const n of [10, 50, 100]) {
  const s = performance.now();
  const vs = [];
  for (let i = 0; i < n; i++) vs.push(await t.view({ group_by: ['book'], aggregates: { notional: 'sum' } }));
  const el = performance.now() - s;
  for (const v of vs) await v.delete();
  line(`${n} identical views`, ms(el), `${ms(el / n)} each`);
}

console.log('\n=== N concurrent views, each a DIFFERENT filter (run 1 shape) ===');
for (const n of [10, 50]) {
  const s = performance.now();
  const vs = [];
  for (let i = 0; i < n; i++) {
    vs.push(await t.view({ group_by: ['book'], aggregates: { notional: 'sum' }, filter: [['notional', '>', i * 1000]] }));
  }
  const el = performance.now() - s;
  for (const v of vs) await v.delete();
  line(`${n} distinct-filter views`, ms(el), `${ms(el / n)} each`);
}

// ---------------------------------------------------------------- VRM, correct API
console.log('\n=== VRM: the tree API, used correctly ===');
const tree = await t.view({ group_by: ['book', 'counterparty'], aggregates: { notional: 'sum' } });
const collapsed = await tree.num_rows();
line('collapsed rows', collapsed, '');

// expand/collapse take a ROW INDEX. Expanding row 0 (the first book) should
// reveal its counterparties.
if (typeof tree.expand === 'function') {
  await tree.expand(0);
  const afterExpand = await tree.num_rows();
  line('expand(row 0)', afterExpand, `+${afterExpand - collapsed} rows`);

  const win = await tree.to_columns({ start_row: 0, end_row: 8 });
  line('  __ROW_PATH__ shape', JSON.stringify(win.__ROW_PATH__?.slice(0, 4)), '');
  line('  window read', Array.isArray(win.__ROW_PATH__) ? 'flat indexed list' : 'NOT a flat list', '');

  await tree.collapse(0);
  const afterCollapse = await tree.num_rows();
  line('collapse(row 0)', afterCollapse, afterCollapse === collapsed ? 'returns to baseline' : `DRIFT (${afterCollapse} vs ${collapsed})`);
}

// Depth control is the other half of the SSRM story: set_depth(1) gives exactly
// one level of children, which is what getRows wants per expansion.
for (const m of ['set_depth', 'expand_to_depth', 'num_rows', 'collapse', 'expand']) {
  line(`  api: ${m}`, typeof tree[m] === 'function' ? 'present' : 'ABSENT', '');
}
await tree.delete();

// ---------------------------------------------------------------- distinct values
console.log('\n=== distinct values via grouped view (the set-filter path) ===');
let s = performance.now();
const dv = await t.view({ group_by: ['counterparty'] });
const rows = await dv.to_columns({ start_row: 0, end_row: 400 });
await dv.delete();
line('340 distinct counterparties', ms(performance.now() - s), `${rows.__ROW_PATH__?.length ?? 0} paths returned`);

await t.delete();
process.exit(0);
