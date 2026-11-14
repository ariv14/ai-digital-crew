/**
 * embedding-provider.js — Shared embedding logic (Cloudflare Workers AI only)
 *
 * Every call goes through the shared daily neuron budget (ai-budget.js) when a
 * Firestore `db` is passed. Gemini is not used.
 * Env vars:
 *   CLOUDFLARE_ACCOUNT_ID    — Cloudflare account ID
 *   CLOUDFLARE_API_TOKEN     — Cloudflare Workers AI API token
 */

import { withBudget } from './ai-budget.js';

const EMBED_MODEL = '@cf/baai/bge-large-en-v1.5';
// bge-large reads 512 tokens at most; keeping the input bounded keeps the budget estimate small.
const MAX_EMBED_CHARS = 2000;

const PROVIDERS = {
  cloudflare: {
    name: 'cloudflare',
    model: 'bge-large-en-v1.5',
    dimensions: 1024,
    async generate(text, db) {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = process.env.CLOUDFLARE_API_TOKEN;
      if (!accountId || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN not set');
      const input = text.slice(0, MAX_EMBED_CHARS);
      const result = await withBudget(db, { model: EMBED_MODEL, inputChars: input.length, maxOutputTokens: 0 }, async () => {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBED_MODEL}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
            body: JSON.stringify({ text: [input] }),
          }
        );
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Cloudflare AI error ${res.status}: ${body}`);
        }
        const data = await res.json();
        if (!data.success) throw new Error(`Cloudflare AI error: ${JSON.stringify(data.errors)}`);
        return { value: data.result, usage: data.result?.usage };
      });
      return result.data[0];
    },
  },
};

/**
 * Generate an embedding with Cloudflare.
 * @param {string} text - Text to embed
 * @param {object} [db] - Firestore, to meter the call against the daily budget
 * @returns {Promise<{values: number[], provider: string, dimensions: number}>}
 */
export async function generateEmbedding(text, db) {
  const p = PROVIDERS.cloudflare;
  return { values: await p.generate(text, db), provider: p.name, dimensions: p.dimensions };
}

/**
 * Returns { embedding_cloudflare: [...] }. A missing key or a failed call is a
 * warning and an empty result; an exhausted daily budget throws
 * BudgetExhaustedError so callers can stop their loop.
 * @param {string} text
 * @param {object} [db] - Firestore, for the daily budget
 * @returns {Promise<Record<string, number[]>>}
 */
export async function generateAllEmbeddings(text, db) {
  try {
    return { embedding_cloudflare: await PROVIDERS.cloudflare.generate(text, db) };
  } catch (err) {
    if (err?.code === 'budget-exhausted') throw err;
    console.warn(`Skipping cloudflare embedding: ${err.message}`);
    return {};
  }
}

/**
 * Build a searchable text string from a project document.
 * @param {object} project - Firestore project document
 * @returns {string}
 */
export function projectToEmbeddingText(project) {
  const parts = [
    project.name || '',
    project.description || '',
    project.writeup || '',
    (project.topics || []).join(' '),
    project.language || '',
    project.category || '',
  ];
  return parts.filter(Boolean).join('. ');
}
