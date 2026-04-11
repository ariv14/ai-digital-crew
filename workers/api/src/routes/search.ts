import type { Env } from '../worker';
import { embedWithGemini, GeminiError } from '../lib/gemini';
import { validateQuery, ValidationError } from '../lib/validation';
import { isOriginAllowed } from '../lib/origin';

const QUERY_CACHE_TTL_S = 24 * 60 * 60; // 24 hours

interface CachedQueryEmbedding {
  embedding: number[];
  provider: 'gemini' | 'cloudflare';
  dimensions: number;
  createdAt: number;
}

export async function handleSearch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonError(405, 'Method not allowed');
  }

  if (!isOriginAllowed(request, env.CORS_ORIGIN)) {
    return jsonError(403, 'Origin not allowed');
  }

  // Rate limit (skip if binding undefined in tests)
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

  // Mode dispatch — Task 12 adds the other 3 modes
  return handleQueryMode(payload, env);
}

async function handleQueryMode(payload: Record<string, unknown>, env: Env): Promise<Response> {
  let query: string;
  try {
    query = validateQuery(payload.query);
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(400, err.message);
    throw err;
  }

  const normalized = query.toLowerCase().trim();
  const cacheKey = await sha256Hex(normalized);

  // KV cache lookup
  const cachedRaw = await env.QUERY_EMBEDDING_CACHE.get(cacheKey);
  if (cachedRaw) {
    const cached = JSON.parse(cachedRaw) as CachedQueryEmbedding;
    return json({
      embedding: cached.embedding,
      provider: cached.provider,
      dimensions: cached.dimensions,
      cached: true,
    });
  }

  // Embed via Gemini (with retry built into embedWithGemini)
  let result;
  try {
    result = await embedWithGemini(normalized, env.GEMINI_API_KEY);
  } catch (err) {
    if (err instanceof GeminiError) {
      console.error('search: Gemini failed', err.status, err.message);
      return jsonError(500, 'Embedding provider failed');
    }
    throw err;
  }

  // Write to KV (best-effort)
  const toCache: CachedQueryEmbedding = {
    embedding: result.values,
    provider: result.provider,
    dimensions: result.dimensions,
    createdAt: Date.now(),
  };
  try {
    await env.QUERY_EMBEDDING_CACHE.put(cacheKey, JSON.stringify(toCache), {
      expirationTtl: QUERY_CACHE_TTL_S,
    });
  } catch (err) {
    console.warn('search: KV cache write failed (non-fatal)', err);
  }

  return json({
    embedding: result.values,
    provider: result.provider,
    dimensions: result.dimensions,
    cached: false,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
