/**
 * Cloud Functions for AI Digital Crew
 *
 * getQueryEmbedding — Callable function that returns an embedding for a search query.
 * Uses Gemini (primary) with Cloudflare Workers AI fallback. Checks Firestore searchCache first.
 *
 * Secrets (set via firebase functions:secrets:set):
 *   GEMINI_API_KEY, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
 */

import { onCall, HttpsError, onRequest } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';
import crypto from 'crypto';

initializeApp();
const db = getFirestore();

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── In-memory embedding cache for server-side ranking ─────────────────────────
let embCache = null;  // Map<fullName, number[]>
let embCacheAge = 0;
const EMB_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour in-memory TTL

async function loadEmbeddingsCache() {
  if (embCache && (Date.now() - embCacheAge) < EMB_CACHE_TTL_MS) return embCache;

  const metaDoc = await db.collection('embeddingsCache').doc('meta').get();
  if (!metaDoc.exists) return null;

  const { partCount } = metaDoc.data();
  const map = new Map();

  for (let i = 0; i < partCount; i++) {
    const partDoc = await db.collection('embeddingsCache').doc(`part${i}`).get();
    if (!partDoc.exists) continue;
    for (const entry of partDoc.data().entries) {
      map.set(entry.fullName, entry.embedding);
    }
  }

  embCache = map;
  embCacheAge = Date.now();
  console.log(`Loaded embeddingsCache: ${map.size} projects`);
  return map;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function hashQuery(query) {
  return crypto.createHash('sha256').update(query.toLowerCase().trim()).digest('hex').slice(0, 32);
}

async function embedWithGemini(text, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
  const result = await model.embedContent(text);
  return { values: result.embedding.values, provider: 'gemini', dimensions: 3072 };
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
    // findSimilar doesn't need a query — use cached project embeddings directly
    if (request.data?.findSimilar) {
      const targetName = request.data.findSimilar;
      const embMap = await loadEmbeddingsCache();
      if (embMap && embMap.size > 0) {
        const targetEmb = embMap.get(targetName);
        if (targetEmb) {
          const ranked = [];
          for (const [fullName, projectEmb] of embMap) {
            if (fullName === targetName) continue;
            const score = cosineSimilarity(targetEmb, projectEmb);
            if (score > 0.25) {
              ranked.push({ fullName, score: Math.round(score * 10000) / 10000 });
            }
          }
          ranked.sort((a, b) => b.score - a.score);
          return { rankings: ranked.slice(0, 12), provider: 'cached', cached: true };
        }
      }
      return { rankings: [], provider: 'cached', cached: true };
    }

    const query = request.data?.query;
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'query is required');
    }

    const normalizedQuery = query.toLowerCase().trim();
    const cacheKey = hashQuery(normalizedQuery);

    // Check searchCache for cached query embedding
    let queryEmbedding = null;
    let embProvider = null;
    let wasCached = false;

    const cacheDoc = await db.collection('searchCache').doc(cacheKey).get();
    if (cacheDoc.exists) {
      const cached = cacheDoc.data();
      const age = Date.now() - (cached.createdAt?.toMillis?.() || 0);
      if (age < CACHE_TTL_MS) {
        queryEmbedding = cached.embedding;
        embProvider = cached.provider;
        wasCached = true;
      }
    }

    // Generate embedding if not cached
    if (!queryEmbedding) {
      const geminiKey = process.env.GEMINI_API_KEY;
      const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const cfToken = process.env.CLOUDFLARE_API_TOKEN;

      let result;
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

      queryEmbedding = result.values;
      embProvider = result.provider;

      // Store in cache
      try {
        await db.collection('searchCache').doc(cacheKey).set({
          query: normalizedQuery,
          embedding: queryEmbedding,
          provider: embProvider,
          dimensions: result.dimensions,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (cacheErr) {
        console.warn('Cache write failed (non-fatal):', cacheErr.message);
      }
    }

    // If rankProjects requested, compute server-side scores and return ranked results
    if (request.data?.rankProjects) {
      const embMap = await loadEmbeddingsCache();
      if (embMap && embMap.size > 0) {
        const ranked = [];
        for (const [fullName, projectEmb] of embMap) {
          const score = cosineSimilarity(queryEmbedding, projectEmb);
          if (score > 0.25) {
            ranked.push({ fullName, score: Math.round(score * 10000) / 10000 });
          }
        }
        ranked.sort((a, b) => b.score - a.score);
        return { rankings: ranked.slice(0, 12), provider: embProvider, cached: wasCached };
      }
    }

    return {
      embedding: queryEmbedding,
      provider: embProvider,
      dimensions: queryEmbedding.length,
      cached: wasCached,
    };
  }
);

// ── trendBadge — Dynamic SVG badge for repos ────────────────────────────────

function generateBadgeSvg(label, score, trendLabel) {
  const colors = {
    hot: { bg: '#dc2626', text: '#fff' },
    rising: { bg: '#059669', text: '#fff' },
    steady: { bg: '#6b7280', text: '#fff' },
    declining: { bg: '#6b7280', text: '#d1d5db' },
    new: { bg: '#2563eb', text: '#fff' },
  };
  const c = colors[trendLabel] || colors.steady;
  const icons = { hot: '\uD83D\uDD25', rising: '\u2B06\uFE0F', steady: '\u2796', declining: '\u2B07\uFE0F', new: '\u2728' };
  const icon = icons[trendLabel] || '';
  const leftText = 'trending on AI Digital Crew';
  const rightText = `${icon} ${label} ${score}`;
  const leftW = leftText.length * 6.2 + 20;
  const rightW = rightText.length * 6.2 + 20;
  const totalW = leftW + rightW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${leftText}: ${rightText}">
  <title>${leftText}: ${rightText}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftW}" height="20" fill="#555"/>
    <rect x="${leftW}" width="${rightW}" height="20" fill="${c.bg}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${leftW / 2}" y="14">${leftText}</text>
    <text x="${leftW + rightW / 2}" y="14" fill="${c.text}">${rightText}</text>
  </g>
</svg>`;
}

export const trendBadge = onRequest(
  { region: 'us-central1', cors: true },
  async (req, res) => {
    const repo = req.query.repo;
    if (!repo || typeof repo !== 'string') {
      res.status(400).send('Missing ?repo= parameter');
      return;
    }

    try {
      const snap = await db.collection('projects')
        .where('fullName', '==', repo)
        .limit(1)
        .get();

      if (snap.empty) {
        res.status(404).send('Project not found');
        return;
      }

      const p = snap.docs[0].data();
      const score = (p.trend_momentum || 0).toFixed(0);
      const label = { hot: 'Hot', rising: 'Rising', steady: 'Steady', declining: 'Cooling', new: 'New' }[p.trend_label] || 'Tracked';
      const svg = generateBadgeSvg(label, score, p.trend_label || 'steady');

      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(svg);
    } catch (err) {
      console.error('trendBadge error:', err);
      res.status(500).send('Internal error');
    }
  }
);
