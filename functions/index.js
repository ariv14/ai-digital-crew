/**
 * Cloud Functions for AI Digital Crew
 *
 * getQueryEmbedding — Callable function that returns an embedding for a search query.
 * Uses Gemini (primary) with Cloudflare Workers AI fallback. Checks Firestore searchCache first.
 *
 * Secrets (set via firebase functions:secrets:set):
 *   GEMINI_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
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

async function embedWithCloudflare(text, accountId, apiToken) {
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
    throw new Error(`Cloudflare AI ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (!data.success) throw new Error(`Cloudflare AI error: ${JSON.stringify(data.errors)}`);
  return { values: data.result.data[0], provider: 'cloudflare', dimensions: 1024 };
}

export const getQueryEmbedding = onCall(
  {
    secrets: ['GEMINI_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
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
    const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const cfToken = process.env.CLOUDFLARE_API_TOKEN;

    try {
      if (geminiKey) {
        result = await embedWithGemini(normalizedQuery, geminiKey);
      } else {
        throw new Error('No GEMINI_API_KEY');
      }
    } catch (geminiErr) {
      console.warn('Gemini embedding failed:', geminiErr.message);
      try {
        if (cfAccountId && cfToken) {
          result = await embedWithCloudflare(normalizedQuery, cfAccountId, cfToken);
        } else {
          throw new Error('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN not set');
        }
      } catch (cfErr) {
        console.error('All embedding providers failed:', cfErr.message);
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
