/**
 * embedding-provider.js — Shared embedding provider abstraction
 *
 * Supports Gemini (primary) and Jina AI (fallback).
 * Env vars:
 *   EMBEDDING_PROVIDER — primary provider: 'gemini' (default) or 'jina'
 *   GEMINI_API_KEY     — Google AI API key
 *   JINA_API_KEY       — Jina AI API key
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
  jina: {
    name: 'jina',
    model: 'jina-embeddings-v3',
    dimensions: 1024,
    async generate(text) {
      const apiKey = process.env.JINA_API_KEY;
      if (!apiKey) throw new Error('JINA_API_KEY not set');
      const res = await fetch('https://api.jina.ai/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'jina-embeddings-v3',
          task: 'text-matching',
          input: [text],
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Jina API error ${res.status}: ${body}`);
      }
      const data = await res.json();
      return data.data[0].embedding;
    },
  },
};

const FALLBACK_ORDER = ['gemini', 'jina'];

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
 * Returns an object like { embedding_gemini: [...], embedding_jina: [...] }
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
