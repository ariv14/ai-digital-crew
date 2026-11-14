/**
 * ai-budget.js — one shared daily budget for every Cloudflare Workers AI call.
 *
 * Workers AI is free up to 10,000 neurons a day (resets 00:00 UTC) and billed
 * beyond that, so every call reserves its worst-case cost in `aiBudget/{UTC date}`
 * first, runs, then settles to the real cost. Over the cap, the call is refused.
 *
 * A copy of this file lives in functions/ and scripts/ (separate npm packages);
 * keep the two identical. Both write the same Firestore document.
 */

export const FREE_NEURONS_PER_DAY = 10000;
export const DEFAULT_DAILY_CAP = 9000;
export const BUDGET_COLLECTION = 'aiBudget';
export const BUDGET_MESSAGE = "Today's free AI allowance is used up. It resets at midnight UTC.";

/** Neurons per token. Unknown models get a conservative default. */
export const NEURON_RATES = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 0.026668, output: 0.204805 },
  '@cf/baai/bge-large-en-v1.5': { input: 0.018582, output: 0 },
};
export const DEFAULT_RATE = { input: 0.06, output: 0.21 };

export class BudgetExhaustedError extends Error {
  constructor() {
    super(BUDGET_MESSAGE);
    this.name = 'BudgetExhaustedError';
    this.code = 'budget-exhausted';
  }
}

export const isBudgetExhausted = (err) => err?.code === 'budget-exhausted';

/** The daily cap: AI_DAILY_NEURON_CAP if set and valid, never above the free allowance. */
export function dailyCap(env = process.env) {
  const n = Number(env?.AI_DAILY_NEURON_CAP);
  const cap = env?.AI_DAILY_NEURON_CAP !== undefined && env.AI_DAILY_NEURON_CAP !== '' && Number.isFinite(n) ? n : DEFAULT_DAILY_CAP;
  return Math.min(Math.max(cap, 0), FREE_NEURONS_PER_DAY);
}

/** UTC date, the budget document's id. */
export const budgetDay = (now = new Date()) => now.toISOString().slice(0, 10);

/** Worst-case neurons for a call: 1 token per 3 characters in, the full max output out. */
export function estimateNeurons({ model, inputChars = 0, maxOutputTokens = 0 }) {
  const rate = NEURON_RATES[model] ?? DEFAULT_RATE;
  const inTokens = Math.ceil(inputChars / 3);
  return Math.ceil(inTokens * rate.input + maxOutputTokens * rate.output);
}

/** Real neurons from a response's `usage`, or null when it reports none. */
export function actualNeurons({ model, usage }) {
  const p = Number(usage?.prompt_tokens);
  const c = Number(usage?.completion_tokens);
  if (!Number.isFinite(p) || !Number.isFinite(c)) return null;
  const rate = NEURON_RATES[model] ?? DEFAULT_RATE;
  return Math.ceil(p * rate.input + c * rate.output);
}

const budgetRef = (db) => db.collection(BUDGET_COLLECTION).doc(budgetDay());

/** Adds `estimate` to today's counter unless that would pass the cap. Returns whether it did. */
export async function reserveNeurons(db, estimate) {
  const cap = dailyCap();
  const ref = budgetRef(db);
  return db.runTransaction(async (tx) => {
    const current = Number((await tx.get(ref)).data()?.neurons) || 0;
    if (current + estimate > cap) return false;
    tx.set(ref, { neurons: current + estimate, updatedAt: new Date() }, { merge: true });
    return true;
  });
}

/** Cheap check before spending anything else: is any budget left today? (Not a reservation.) */
export async function budgetLeft(db, needed = 1) {
  const current = Number((await budgetRef(db).get()).data()?.neurons) || 0;
  return current + needed <= dailyCap();
}

/**
 * Corrects the counter once the real cost is known: `actual` neurons replace
 * `estimate`. A null/undefined `actual` keeps the estimate; 0 refunds it.
 * Never throws.
 */
export async function settleNeurons(db, estimate, actual) {
  if (actual === null || actual === undefined || !Number.isFinite(actual)) return;
  const delta = actual - estimate;
  if (delta === 0) return;
  try {
    const ref = budgetRef(db);
    await db.runTransaction(async (tx) => {
      const current = Number((await tx.get(ref)).data()?.neurons) || 0;
      tx.set(ref, { neurons: Math.max(current + delta, 0), updatedAt: new Date() }, { merge: true });
    });
  } catch (err) {
    console.warn('ai-budget: could not settle the neuron counter:', String(err?.message ?? err).slice(0, 200));
  }
}

/**
 * Reserve → call → settle. `call` does the Workers AI request and returns
 * { value, usage? }; it must throw if inference did not succeed (the estimate
 * is then refunded). Without a `db` (tutor-smoke.mjs) there is no budget.
 * Throws BudgetExhaustedError when today's allowance is spent.
 */
export async function withBudget(db, { model, inputChars, maxOutputTokens }, call) {
  if (!db) return (await call()).value;
  const estimate = estimateNeurons({ model, inputChars, maxOutputTokens });
  if (!(await reserveNeurons(db, estimate))) throw new BudgetExhaustedError();
  let out;
  try {
    out = await call();
  } catch (err) {
    await settleNeurons(db, estimate, 0);
    throw err;
  }
  await settleNeurons(db, estimate, actualNeurons({ model, usage: out.usage }));
  return out.value;
}
