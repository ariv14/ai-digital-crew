/**
 * embedding-provider.js — Shared embedding provider abstraction
 *
 * Supports Gemini (primary) and Cloudflare Workers AI (fallback).
 * Env vars:
 *   EMBEDDING_PROVIDER       — primary provider: 'gemini' (default) or 'cloudflare'
 *   GEMINI_API_KEY           — Google AI API key
 *   CLOUDFLARE_ACCOUNT_ID    — Cloudflare account ID
 *   CLOUDFLARE_API_TOKEN     — Cloudflare Workers AI API token
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

const PROVIDERS = {
  gemini: {
    name: 'gemini',
    model: 'text-embedding-004',
    dimensions: 768,
    async generate(text) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('GEMINI_API_KEY not set');
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });
      const result = await model.embedContent(text);
      return result.embedding.values;
    },
  },
  cloudflare: {
    name: 'cloudflare',
    model: 'bge-large-en-v1.5',
    dimensions: 1024,
    async generate(text) {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = process.env.CLOUDFLARE_API_TOKEN;
      if (!accountId || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN not set');
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-large-en-v1.5`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiToken}`,
          },
          body: JSON.stringify({ text: [text] }),
        }
      );
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Cloudflare AI error ${res.status}: ${body}`);
      }
      const data = await res.json();
      if (!data.success) throw new Error(`Cloudflare AI error: ${JSON.stringify(data.errors)}`);
      return data.result.data[0];
    },
  },
};

const FALLBACK_ORDER = ['gemini', 'cloudflare'];

/**
 * Generate an embedding using a specific provider (or primary with fallback).
 * @param {string} text - Text to embed
 * @param {string} [provider] - Force a specific provider; omit for auto-fallback
 * @returns {Promise<{values: number[], provider: string, dimensions: number}>}
 */
export async function generateEmbedding(text, provider) {
  if (provider) {
    const p = PROVIDERS[provider];
    if (!p) throw new Error(`Unknown provider: ${provider}`);
    const values = await p.generate(text);
    return { values, provider: p.name, dimensions: p.dimensions };
  }

  // Auto-fallback chain
  const primary = process.env.EMBEDDING_PROVIDER || 'gemini';
  const order = [primary, ...FALLBACK_ORDER.filter(p => p !== primary)];

  for (const name of order) {
    const p = PROVIDERS[name];
    if (!p) continue;
    try {
      const values = await p.generate(text);
      return { values, provider: p.name, dimensions: p.dimensions };
    } catch (err) {
      console.warn(`Embedding provider ${name} failed: ${err.message}`);
    }
  }
  throw new Error('All embedding providers failed');
}

/**
 * Generate embeddings for ALL configured providers.
 * Returns an object like { embedding_gemini: [...], embedding_cloudflare: [...] }
 * Skips providers missing API keys silently.
 * @param {string} text
 * @returns {Promise<Record<string, number[]>>}
 */
export async function generateAllEmbeddings(text) {
  const results = {};
  const promises = Object.entries(PROVIDERS).map(async ([name, p]) => {
    try {
      const values = await p.generate(text);
      results[`embedding_${name}`] = values;
    } catch (err) {
      console.warn(`Skipping ${name} embedding: ${err.message}`);
    }
  });
  await Promise.all(promises);
  return results;
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
