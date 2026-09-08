/**
 * Convergence property test — a Phase 2 exit criterion.
 *
 * Random insert/update/delete sequences pushed through normalize + micro-batch
 * + dedupe must converge to the same state as a naive fold over the same
 * sequence. The oracle is deliberately dumb: apply every message in order, one
 * at a time, no batching, no conflation. If the fast path and the dumb path
 * disagree, the fast path is wrong.
 *
 * This is what catches conflation and ordering bugs that unit tests miss,
 * because the failures only appear in specific interleavings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNormalizer } from '../src/normalize.mjs';
import { TableActor, STATE } from '../src/table_actor.mjs';

const datasource = {
  id: 'conv',
  keyColumns: ['id'],
  opField: { path: 'op', map: { N: 'insert', U: 'update', D: 'delete' } },
  softDelete: { column: '_deleted' },
  flatten: { separator: '_' },
};

/** Deterministic PRNG — a seed in the failure message must reproduce the case. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function generate(seed, count) {
  const rand = rng(seed);
  const ids = ['P1', 'P2', 'P3', 'P4', 'P5'];
  const fields = ['price', 'notional', 'spread'];
  const msgs = [];
  for (let i = 0; i < count; i++) {
    const id = ids[Math.floor(rand() * ids.length)];
    const r = rand();
    if (r < 0.15) msgs.push({ id, op: 'N', [fields[0]]: Math.floor(rand() * 100) });
    else if (r < 0.25) msgs.push({ id, op: 'D' });
    else {
      // Partial patch: touches ONE field. The case that breaks naive dedupe.
      const f = fields[Math.floor(rand() * fields.length)];
      msgs.push({ id, op: 'U', [f]: Math.floor(rand() * 1000) });
    }
  }
  return msgs;
}

/** The oracle: fold messages one at a time into a plain map. */
function fold(rows) {
  const state = new Map();
  for (const row of rows) {
    const { __key, __op, ...fields } = row;
    // Every op merges. Delete is not special here: it arrives carrying its
    // soft-delete flag, and that flag is the delete. Suppressing anything at
    // this layer would be batch-boundary-dependent.
    state.set(__key, { ...(state.get(__key) ?? {}), ...fields });
  }
  return state;
}

/** The real path: normalize -> actor with batching and dedupe -> table. */
function throughActor(rows, maxRows) {
  const state = new Map();
  const table = {
    update(block) {
      const keys = block.__key;
      for (let i = 0; i < keys.length; i++) {
        const merged = { ...(state.get(keys[i]) ?? {}) };
        for (const [col, values] of Object.entries(block)) merged[col] = values[i];
        state.set(keys[i], merged);
      }
    },
  };

  const actor = new TableActor({ table, batch: { maxRows, maxMs: 60_000, dedupeByKey: true } });
  actor.transition(STATE.CONNECTING);
  actor.transition(STATE.SNAPSHOTTING);
  actor.endSnapshot();
  for (const row of rows) actor.push([row]);
  actor.flush();
  return state;
}

test('batched + deduped ingest converges with a naive fold, across many seeds', () => {
  const n = createNormalizer(datasource, null);

  for (let seed = 1; seed <= 200; seed++) {
    const msgs = generate(seed, 120);
    const rows = msgs.flatMap((m) => n.normalize(m).rows);

    const expected = fold(rows);
    // Vary the batch boundary: bugs hide at specific flush points.
    for (const maxRows of [1, 3, 17, 1000]) {
      const actual = throughActor(rows, maxRows);

      assert.deepEqual(
        [...actual.keys()].sort(),
        [...expected.keys()].sort(),
        `seed ${seed} maxRows ${maxRows}: key sets diverged`
      );

      for (const [key, want] of expected) {
        const got = actual.get(key);
        for (const [col, value] of Object.entries(want)) {
          assert.equal(
            got[col], value,
            `seed ${seed} maxRows ${maxRows} key ${key} col ${col}: ` +
            `expected ${value}, got ${got[col]} — conflation lost or reordered a field`
          );
        }
      }
    }
  }
});

test('a field set early and never touched again survives a long run', () => {
  // The specific regression dedupe-by-replace would cause: an early field is
  // silently dropped once a later partial patch for the same key arrives.
  const n = createNormalizer(datasource, null);
  const rows = [
    ...n.normalize({ id: 'P1', op: 'N', price: 42 }).rows,
    ...Array.from({ length: 500 }, (_, i) => n.normalize({ id: 'P1', op: 'U', spread: i }).rows[0]),
  ];
  const state = throughActor(rows, 7);
  assert.equal(state.get('P1').price, 42, 'the original price must still be there');
  assert.equal(state.get('P1').spread, 499);
});

test('batch size never changes the final state', () => {
  const n = createNormalizer(datasource, null);
  const rows = generate(99, 500).flatMap((m) => n.normalize(m).rows);
  const reference = throughActor(rows, 1);
  for (const maxRows of [2, 5, 50, 499, 5000]) {
    assert.deepEqual(
      Object.fromEntries(throughActor(rows, maxRows)),
      Object.fromEntries(reference),
      `maxRows ${maxRows} produced a different final state than unbatched`
    );
  }
});
