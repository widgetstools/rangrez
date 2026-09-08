import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorWithRepair, repairPrompt } from '../src/ruleAuthor.mjs';

const COLS = ['dv01', 'pnl', 'desk', 'marketValue'];

test('a first-try valid rule needs one attempt', async () => {
  const generate = async () => 'pnl < -900000';
  const r = await authorWithRepair({ generate, request: 'big losses', columns: COLS, purpose: 'predicate' });
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 1);
});

test('a wrong column is repaired from the structured error', async () => {
  // The whole point: the model fixes its own output when handed the specific
  // failure, not a bare "invalid".
  const generate = async ({ priorError }) =>
    (priorError && priorError.includes('pnl_total')) ? 'pnl < -900000' : 'pnl_total < -900000';
  const r = await authorWithRepair({ generate, request: 'big losses', columns: COLS, purpose: 'predicate' });
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 2);
  assert.equal(r.rule, 'pnl < -900000');
});

test('the prior error and attempt are fed back to the model', async () => {
  const seen = [];
  const generate = async (prompt) => { seen.push(prompt); return prompt.priorError ? 'pnl < 0' : 'bogus_col < 0'; };
  await authorWithRepair({ generate, request: 'x', columns: COLS, purpose: 'predicate' });
  assert.equal(seen[0].priorError, undefined, 'first attempt has no prior');
  assert.ok(seen[1].priorError.includes('bogus_col'), 'the repair sees the specific error');
  assert.equal(seen[1].priorAttempt, 'bogus_col < 0', 'and its own prior text');
});

test('authoring FAILS after the budget rather than shipping a broken rule', async () => {
  // Never persist an invalid rule.
  const generate = async () => 'still_wrong < 0';
  const r = await authorWithRepair({ generate, request: 'x', columns: COLS, purpose: 'predicate', maxAttempts: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.attempts.length, 3);
  assert.ok(r.verdict.errors.length, 'the last failure is reported');
});

test('a syntax slip is also repairable', async () => {
  const generate = async ({ priorError }) => (priorError ? 'pnl < -900000' : 'pnl <');
  const r = await authorWithRepair({ generate, request: 'x', columns: COLS, purpose: 'predicate' });
  assert.equal(r.ok, true);
  assert.equal(r.attempts.length, 2);
});

test('the repair prompt names the previous attempt and the reason', () => {
  const p = repairPrompt({ request: 'big losses', columns: COLS, priorError: 'no column "pnl_total"', priorAttempt: 'pnl_total < 0' });
  assert.match(p, /pnl_total < 0/);
  assert.match(p, /no column "pnl_total"/);
  assert.match(p, /return only the corrected rule/);
});

test('a huge column list is truncated in the prompt, not dumped whole', () => {
  const many = Array.from({ length: 200 }, (_, i) => `col${i}`);
  const p = repairPrompt({ request: 'x', columns: many });
  assert.match(p, /… \(200 total\)/);
});
