import type { Env } from '../worker';
import { embedWithGemini, GeminiError } from '../lib/gemini';
import { validateQuery, validateFindSimilar, validateFindSimilarBatch, ValidationError } from '../lib/validation';
import { isOriginAllowed } from '../lib/origin';
import { loadProjectEmbeddings } from '../lib/embeddings-cache';
import { cosineSimilarity } from '../lib/cosine';

const QUERY_CACHE_TTL_S = 24 * 60 * 60;
const SCORE_THRESHOLD = 0.25;
const RANK_LIMIT = 12;
const BATCH_RESULT_LIMIT = 3;

interface CachedQueryEmbedding {
  embedding: number[];
  provider: 'gemini' | 'cloudflare';
  dimensions: number;
  createdAt: number;
}

export async function handleSearch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') return jsonError(405, 'Method not allowed');
  if (!isOriginAllowed(request, env.CORS_ORIGIN)) return jsonError(403, 'Origin not allowed');

  if (env.SEARCH_RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.SEARCH_RATE_LIMITER.limit({ key: ip });
    if (!success) return jsonError(429, 'Rate limit exceeded');
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonError(400, 'Body must be valid JSON');
  }

  // Mode dispatch
  if (Array.isArray(payload.findSimilarBatch)) {
    return handleFindSimilarBatch(payload, env);
  }
  if (typeof payload.findSimilar === 'string') {
    return handleFindSimilar(payload, env);
  }
  if (typeof payload.query === 'string') {
    return handleQueryMode(payload, env, !!payload.rankProjects);
  }
  return jsonError(400, 'Request must include query, findSimilar, or findSimilarBatch');
}

async function safeLoadEmbeddings(env: Env): Promise<Map<string, number[]> | Response> {
  try {
    return await loadProjectEmbeddings(env.GCP_PROJECT_ID);
  } catch (err) {
    console.error('search: failed to load project embeddings', err);
    return jsonError(500, 'Failed to load project embeddings');
  }
}

async function handleQueryMode(payload: Record<string, unknown>, env: Env, rankProjects: boolean): Promise<Response> {
  let query: string;
  try {
    query = validateQuery(payload.query);
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(400, err.message);
    throw err;
  }

  const normalized = query.toLowerCase().trim();
  const cacheKey = await sha256Hex(normalized);

  let provider: 'gemini' | 'cloudflare';
  let queryEmbedding: number[];
  let dimensions: number;
  let wasCached = false;

  const cachedRaw = await env.QUERY_EMBEDDING_CACHE.get(cacheKey);
  if (cachedRaw) {
    const cached = JSON.parse(cachedRaw) as CachedQueryEmbedding;
    queryEmbedding = cached.embedding;
    provider = cached.provider;
    dimensions = cached.dimensions;
    wasCached = true;
  } else {
    let result: { values: number[]; provider: 'gemini' | 'cloudflare'; dimensions: number };
    try {
      result = await embedWithGemini(normalized, env.GEMINI_API_KEY);
    } catch (geminiErr) {
      console.warn('search: Gemini failed, trying Workers AI fallback', (geminiErr as Error).message);
      try {
        const aiRes = (await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [normalized] })) as { data: number[][] };
        const values = aiRes.data?.[0];
        if (!Array.isArray(values) || values.length === 0) {
          throw new Error('Workers AI returned empty embedding');
        }
        result = { values, provider: 'cloudflare', dimensions: 1024 };
      } catch (aiErr) {
        console.error('search: All embedding providers failed', (aiErr as Error).message);
        return jsonError(500, 'All embedding providers failed');
      }
    }
    queryEmbedding = result.values;
    provider = result.provider;
    dimensions = result.dimensions;

    try {
      await env.QUERY_EMBEDDING_CACHE.put(
        cacheKey,
        JSON.stringify({ embedding: queryEmbedding, provider, dimensions, createdAt: Date.now() } satisfies CachedQueryEmbedding),
        { expirationTtl: QUERY_CACHE_TTL_S }
      );
    } catch (err) {
      console.warn('search: KV cache write failed (non-fatal)', err);
    }
  }

  if (!rankProjects) {
    return json({ embedding: queryEmbedding, provider, dimensions, cached: wasCached });
  }

  const embMapOrErr = await safeLoadEmbeddings(env);
  if (embMapOrErr instanceof Response) return embMapOrErr;
  const embMap = embMapOrErr;
  const ranked = rankAgainstMap(queryEmbedding, embMap, RANK_LIMIT);

  if (provider === 'cloudflare' && ranked.length === 0 && embMap.size > 0) {
    console.warn(
      `search: rankProjects returned empty results — Workers AI fallback is active ` +
      `(query dims=${queryEmbedding.length}) but embeddingsCache stores Gemini vectors (3072). ` +
      `Ranking will stay empty until Gemini recovers.`
    );
  }

  return json({ rankings: ranked, provider, cached: wasCached });
}

async function handleFindSimilar(payload: Record<string, unknown>, env: Env): Promise<Response> {
  let target: string;
  try {
    target = validateFindSimilar(payload.findSimilar);
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(400, err.message);
    throw err;
  }

  const embMapOrErr = await safeLoadEmbeddings(env);
  if (embMapOrErr instanceof Response) return embMapOrErr;
  const embMap = embMapOrErr;
  const targetEmb = embMap.get(target);
  if (!targetEmb) {
    return json({ rankings: [], provider: 'cached', cached: true });
  }
  const ranked = rankAgainstMap(targetEmb, embMap, RANK_LIMIT, target);
  return json({ rankings: ranked, provider: 'cached', cached: true });
}

async function handleFindSimilarBatch(payload: Record<string, unknown>, env: Env): Promise<Response> {
  let targets: string[];
  try {
    targets = validateFindSimilarBatch(payload.findSimilarBatch);
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(400, err.message);
    throw err;
  }

  const embMapOrErr = await safeLoadEmbeddings(env);
  if (embMapOrErr instanceof Response) return embMapOrErr;
  const embMap = embMapOrErr;
  const batchResults: Record<string, Array<{ fullName: string; score: number }>> = {};
  for (const target of targets) {
    const targetEmb = embMap.get(target);
    if (!targetEmb) {
      batchResults[target] = [];
      continue;
    }
    batchResults[target] = rankAgainstMap(targetEmb, embMap, BATCH_RESULT_LIMIT, target);
  }
  return json({ batchResults, provider: 'cached', cached: true });
}

function rankAgainstMap(
  queryEmb: number[],
  embMap: Map<string, number[]>,
  limit: number,
  excludeFullName?: string
): Array<{ fullName: string; score: number }> {
  const ranked: Array<{ fullName: string; score: number }> = [];
  for (const [fullName, projectEmb] of embMap) {
    if (excludeFullName !== undefined && fullName === excludeFullName) continue;
    if (queryEmb.length !== projectEmb.length) continue; // dimension mismatch
    const score = cosineSimilarity(queryEmb, projectEmb);
    if (score > SCORE_THRESHOLD) {
      ranked.push({ fullName, score: Math.round(score * 10000) / 10000 });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function jsonError(status: number, message: string): Response {
  return json({ error: message }, status);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
