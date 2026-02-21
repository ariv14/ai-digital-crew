/**
 * Cloud Functions for AI Digital Crew
 *
 * getQueryEmbedding — Callable function that returns an embedding for a search query.
 * Uses Gemini (primary) with Jina AI fallback. Checks Firestore searchCache first.
 *
 * Secrets (set via firebase functions:secrets:set):
 *   GEMINI_API_KEY, JINA_API_KEY
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';
import crypto from 'crypto';

initializeApp();
const db = getFirestore();

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function hashQuery(query) {
  return crypto.createHash('sha256').update(query.toLowerCase().trim()).digest('hex').slice(0, 32);
}

async function embedWithGemini(text, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'text-embedding-004' });
  const result = await model.embedContent(text);
  return { values: result.embedding.values, provider: 'gemini', dimensions: 768 };
}

async function embedWithJina(text, apiKey) {
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
    throw new Error(`Jina API ${res.status}: ${body}`);
  }
  const data = await res.json();
  return { values: data.data[0].embedding, provider: 'jina', dimensions: 1024 };
}

export const getQueryEmbedding = onCall(
  {
    secrets: ['GEMINI_API_KEY', 'JINA_API_KEY'],
    maxInstances: 10,
    region: 'us-central1',
  },
  async (request) => {
    const query = request.data?.query;
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'query is required');
    }

    const normalizedQuery = query.toLowerCase().trim();
    const cacheKey = hashQuery(normalizedQuery);

    // Check cache
    const cacheDoc = await db.collection('searchCache').doc(cacheKey).get();
    if (cacheDoc.exists) {
      const cached = cacheDoc.data();
      const age = Date.now() - (cached.createdAt?.toMillis?.() || 0);
      if (age < CACHE_TTL_MS) {
        return {
          embedding: cached.embedding,
          provider: cached.provider,
          dimensions: cached.dimensions,
          cached: true,
        };
      }
    }

    // Generate embedding with fallback chain
    let result;
    const geminiKey = process.env.GEMINI_API_KEY;
    const jinaKey = process.env.JINA_API_KEY;

    try {
      if (geminiKey) {
        result = await embedWithGemini(normalizedQuery, geminiKey);
      } else {
        throw new Error('No GEMINI_API_KEY');
      }
    } catch (geminiErr) {
      console.warn('Gemini embedding failed:', geminiErr.message);
      try {
        if (jinaKey) {
          result = await embedWithJina(normalizedQuery, jinaKey);
        } else {
          throw new Error('No JINA_API_KEY');
        }
      } catch (jinaErr) {
        console.error('All embedding providers failed:', jinaErr.message);
        throw new HttpsError('internal', 'All embedding providers failed');
      }
    }

    // Store in cache
    try {
      await db.collection('searchCache').doc(cacheKey).set({
        query: normalizedQuery,
        embedding: result.values,
        provider: result.provider,
        dimensions: result.dimensions,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (cacheErr) {
      console.warn('Cache write failed (non-fatal):', cacheErr.message);
    }

    return {
      embedding: result.values,
      provider: result.provider,
      dimensions: result.dimensions,
      cached: false,
    };
  }
);
