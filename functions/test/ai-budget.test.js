import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateNeurons, actualNeurons, dailyCap, reserveNeurons, settleNeurons, withBudget, budgetLeft, budgetDay,
  BudgetExhaustedError, isBudgetExhausted, DEFAULT_DAILY_CAP, FREE_NEURONS_PER_DAY,
} from '../ai-budget.js';

const LLAMA = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const BGE = '@cf/baai/bge-large-en-v1.5';

/** A tiny in-memory Firestore: collection/doc/get, runTransaction with get/set(merge). */
function fakeDb(initial = {}) {
  const store = new Map(Object.entries(initial));
  const ref = (path) => ({ path, get: async () => ({ data: () => store.get(path) }) });
  return {
    store,
    collection: (c) => ({ doc: (id) => ref(`${c}/${id}`) }),
    runTransaction: async (fn) => fn({
      get: (r) => r.get(),
      set: (r, data, opts) => store.set(r.path, opts?.merge ? { ...store.get(r.path), ...data } : data),
    }),
  };
}
const todayPath = () => `aiBudget/${budgetDay()}`;
const used = (db) => db.store.get(todayPath())?.neurons ?? 0;

test('estimate: worst case, 3 chars per token, output at max, rounded up', () => {
  assert.equal(estimateNeurons({ model: LLAMA, inputChars: 3000, maxOutputTokens: 700 }), Math.ceil(1000 * 0.026668 + 700 * 0.204805));
  assert.equal(estimateNeurons({ model: BGE, inputChars: 200, maxOutputTokens: 0 }), Math.ceil(67 * 0.018582));
  assert.equal(estimateNeurons({ model: 'other', inputChars: 100, maxOutputTokens: 10 }), Math.ceil(34 * 0.06 + 10 * 0.21));
  assert.equal(estimateNeurons({ model: BGE, inputChars: 0 }), 0);
});

test('actual: from usage tokens, null when usage is missing', () => {
  assert.equal(actualNeurons({ model: LLAMA, usage: { prompt_tokens: 1000, completion_tokens: 100 } }), Math.ceil(26.668 + 20.4805));
  assert.equal(actualNeurons({ model: LLAMA, usage: undefined }), null);
  assert.equal(actualNeurons({ model: LLAMA, usage: { prompt_tokens: 5 } }), null);
});

test('cap: default 9000, env override, clamped to the free allowance', () => {
  assert.equal(dailyCap({}), DEFAULT_DAILY_CAP);
  assert.equal(dailyCap({ AI_DAILY_NEURON_CAP: '5000' }), 5000);
  assert.equal(dailyCap({ AI_DAILY_NEURON_CAP: '999999' }), FREE_NEURONS_PER_DAY);
  assert.equal(dailyCap({ AI_DAILY_NEURON_CAP: 'abc' }), DEFAULT_DAILY_CAP);
  assert.equal(dailyCap({ AI_DAILY_NEURON_CAP: '-5' }), 0);
});

test('reserve: adds until the cap, then refuses without changing the counter', async () => {
  const db = fakeDb({ [todayPath()]: { neurons: 8900 } });
  assert.equal(await reserveNeurons(db, 100), true);
  assert.equal(used(db), 9000);
  assert.equal(await reserveNeurons(db, 1), false);
  assert.equal(used(db), 9000);
  assert.ok(db.store.get(todayPath()).updatedAt);
});

test('settle: adjusts by actual minus estimate, keeps estimate without usage, never goes negative', async () => {
  const db = fakeDb();
  await reserveNeurons(db, 200);
  await settleNeurons(db, 200, 50);
  assert.equal(used(db), 50);
  await settleNeurons(db, 50, undefined);
  assert.equal(used(db), 50);
  await settleNeurons(db, 500, 0);
  assert.equal(used(db), 0);
});

test('settle never throws', async () => {
  const db = { collection: () => ({ doc: () => ({}) }), runTransaction: async () => { throw new Error('down'); } };
  await settleNeurons(db, 10, 1);
});

test('withBudget: reserves, settles to real usage, refunds on failure, refuses when spent', async () => {
  const db = fakeDb();
  const args = { model: LLAMA, inputChars: 3000, maxOutputTokens: 700 };
  const est = estimateNeurons(args);
  const value = await withBudget(db, args, async () => ({ value: 'ok', usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  assert.equal(value, 'ok');
  assert.equal(used(db), actualNeurons({ model: LLAMA, usage: { prompt_tokens: 100, completion_tokens: 10 } }));

  const before = used(db);
  await assert.rejects(withBudget(db, args, async () => { throw new Error('http 500'); }), /http 500/);
  assert.equal(used(db), before);

  await withBudget(db, args, async () => ({ value: 1 }));
  assert.equal(used(db), before + est);

  const full = fakeDb({ [todayPath()]: { neurons: 8999 } });
  let called = false;
  await assert.rejects(withBudget(full, args, async () => { called = true; return { value: 1 }; }), (e) => e instanceof BudgetExhaustedError && isBudgetExhausted(e));
  assert.equal(called, false);
  assert.equal(await budgetLeft(full), true);
  assert.equal(await budgetLeft(full, 2), false);
});

test('withBudget without a db just runs the call', async () => {
  assert.equal(await withBudget(undefined, { model: LLAMA, inputChars: 1, maxOutputTokens: 1 }, async () => ({ value: 7 })), 7);
});
