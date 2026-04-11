import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';
import { handleSearch } from '../src/routes/search';
import { _resetForTesting as resetEmbeddingsCache } from '../src/lib/embeddings-cache';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

beforeEach(async () => {
  resetEmbeddingsCache();
  // Wipe KV between tests
  const list = await env.QUERY_EMBEDDING_CACHE.list();
  for (const k of list.keys) await env.QUERY_EMBEDDING_CACHE.delete(k.name);
});

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';

function postSearch(body: object): Request {
  return new Request('https://example.com/api/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': env.CORS_ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

function mockGeminiSuccess(values: number[]) {
  fetchMock.get(GEMINI_HOST).intercept({
    path: /.*/,
    method: 'POST',
  }).reply(200, { embedding: { values } });
}

function mockEmbeddingsCacheLoad(entries: Array<{ fullName: string; embedding: number[] }>) {
  const FIRESTORE_HOST = 'https://firestore.googleapis.com';
  fetchMock.get(FIRESTORE_HOST).intercept({
    path: `/v1/projects/${env.GCP_PROJECT_ID}/databases/(default)/documents/embeddingsCache/meta`,
    method: 'GET',
  }).reply(200, {
    name: 'meta',
    fields: { partCount: { integerValue: '1' }, totalProjects: { integerValue: String(entries.length) } },
  });
  fetchMock.get(FIRESTORE_HOST).intercept({
    path: `/v1/projects/${env.GCP_PROJECT_ID}/databases/(default)/documents/embeddingsCache/part0`,
    method: 'GET',
  }).reply(200, {
    name: 'part0',
    fields: {
      entries: {
        arrayValue: {
          values: entries.map(e => ({
            mapValue: {
              fields: {
                fullName: { stringValue: e.fullName },
                embedding: { arrayValue: { values: e.embedding.map(v => ({ doubleValue: v })) } },
              },
            },
          })),
        },
      },
    },
  });
}

describe('handleSearch — query mode', () => {
  it('rejects non-POST methods', async () => {
    const req = new Request('https://example.com/api/search', { method: 'GET' });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });

  it('rejects requests without an Origin header', async () => {
    const req = new Request('https://example.com/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hi' }),
    });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });

  it('returns 400 on invalid query payload', async () => {
    const req = postSearch({ query: '' });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it('returns the Gemini embedding on a fresh query', async () => {
    mockGeminiSuccess([0.1, 0.2, 0.3]);
    const req = postSearch({ query: 'vector database' });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { embedding: number[]; provider: string; cached: boolean };
    expect(body.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(body.provider).toBe('gemini');
    expect(body.cached).toBe(false);
  });

  it('returns the cached embedding on a repeat query (KV hit)', async () => {
    mockGeminiSuccess([0.5, 0.6, 0.7]);
    // First call populates KV
    const ctx1 = createExecutionContext();
    await handleSearch(postSearch({ query: 'graph rag' }), env, ctx1);
    await waitOnExecutionContext(ctx1);

    // Second call should NOT call Gemini again — no fetch mock set up
    const ctx2 = createExecutionContext();
    const res = await handleSearch(postSearch({ query: 'graph rag' }), env, ctx2);
    await waitOnExecutionContext(ctx2);
    const body = (await res.json()) as { embedding: number[]; cached: boolean };
    expect(body.embedding).toEqual([0.5, 0.6, 0.7]);
    expect(body.cached).toBe(true);
  });
});

describe('handleSearch — rankProjects mode', () => {
  it('returns ranked projects when query + rankProjects=true', async () => {
    mockEmbeddingsCacheLoad([
      { fullName: 'a/x', embedding: [1, 0, 0] },
      { fullName: 'b/y', embedding: [0, 1, 0] },
      { fullName: 'c/z', embedding: [1, 1, 0] },
    ]);
    mockGeminiSuccess([1, 0, 0]); // Same direction as a/x

    const req = postSearch({ query: 'first', rankProjects: true });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rankings: Array<{ fullName: string; score: number }> };
    expect(body.rankings.length).toBeGreaterThan(0);
    expect(body.rankings[0]!.fullName).toBe('a/x');
  });
});

describe('handleSearch — findSimilar mode', () => {
  it('returns similar projects without calling Gemini', async () => {
    mockEmbeddingsCacheLoad([
      { fullName: 'a/x', embedding: [1, 0, 0] },
      { fullName: 'b/y', embedding: [0.9, 0.1, 0] },
      { fullName: 'c/z', embedding: [0, 0, 1] },
    ]);
    const req = postSearch({ findSimilar: 'a/x' });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rankings: Array<{ fullName: string; score: number }>; provider: string };
    expect(body.provider).toBe('cached');
    expect(body.rankings[0]!.fullName).toBe('b/y');
  });

  it('returns empty rankings when target is not in cache', async () => {
    mockEmbeddingsCacheLoad([{ fullName: 'a/x', embedding: [1, 0, 0] }]);
    const req = postSearch({ findSimilar: 'unknown/repo' });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as { rankings: unknown[] };
    expect(body.rankings).toEqual([]);
  });
});

describe('handleSearch — findSimilarBatch mode', () => {
  it('returns batchResults keyed by target name', async () => {
    mockEmbeddingsCacheLoad([
      { fullName: 'a/x', embedding: [1, 0, 0] },
      { fullName: 'b/y', embedding: [0.9, 0.1, 0] },
      { fullName: 'c/z', embedding: [0, 1, 0] },
    ]);
    const req = postSearch({ findSimilarBatch: ['a/x', 'c/z'] });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batchResults: Record<string, Array<{ fullName: string }>> };
    expect(Object.keys(body.batchResults)).toEqual(['a/x', 'c/z']);
  });

  it('rejects batches larger than 12', async () => {
    const req = postSearch({ findSimilarBatch: Array.from({ length: 13 }, (_, i) => `r/${i}`) });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});
