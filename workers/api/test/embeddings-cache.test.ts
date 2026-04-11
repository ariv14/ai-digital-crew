import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadProjectEmbeddings, _resetForTesting } from '../src/lib/embeddings-cache';

const PROJECT_ID = 'ai-digital-crew';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFirestore(meta: { partCount: number }, parts: Array<Array<{ fullName: string; embedding: number[] }>>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('embeddingsCache/meta')) {
      return new Response(JSON.stringify({
        name: 'meta',
        fields: {
          partCount: { integerValue: String(meta.partCount) },
          totalProjects: { integerValue: '99' },
        },
      }), { status: 200 });
    }
    const partMatch = url.match(/embeddingsCache\/part(\d+)$/);
    if (partMatch) {
      const idx = Number(partMatch[1]);
      const entries = parts[idx] ?? [];
      return new Response(JSON.stringify({
        name: `part${idx}`,
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
      }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe('loadProjectEmbeddings', () => {
  it('loads all parts and returns a Map keyed by fullName', async () => {
    mockFirestore({ partCount: 2 }, [
      [{ fullName: 'foo/bar', embedding: [0.1, 0.2] }],
      [{ fullName: 'baz/qux', embedding: [0.3, 0.4] }],
    ]);
    const map = await loadProjectEmbeddings(PROJECT_ID);
    expect(map.size).toBe(2);
    expect(map.get('foo/bar')).toEqual([0.1, 0.2]);
    expect(map.get('baz/qux')).toEqual([0.3, 0.4]);
  });

  it('caches the Map in isolate memory and does not refetch within TTL', async () => {
    mockFirestore({ partCount: 1 }, [[{ fullName: 'a/b', embedding: [1] }]]);
    await loadProjectEmbeddings(PROJECT_ID);
    await loadProjectEmbeddings(PROJECT_ID);
    // 1 meta call + 1 part call = 2 fetches total, NOT 4
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('reloads after the TTL expires', async () => {
    mockFirestore({ partCount: 1 }, [[{ fullName: 'a/b', embedding: [1] }]]);
    await loadProjectEmbeddings(PROJECT_ID, { ttlMs: 0 }); // 0 = always stale
    await loadProjectEmbeddings(PROJECT_ID, { ttlMs: 0 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it('returns an empty Map when partCount is 0', async () => {
    mockFirestore({ partCount: 0 }, []);
    const map = await loadProjectEmbeddings(PROJECT_ID);
    expect(map.size).toBe(0);
  });

  it('deduplicates concurrent cold-start loads into a single fetch', async () => {
    mockFirestore({ partCount: 1 }, [[{ fullName: 'a/b', embedding: [1] }]]);
    // Kick off two simultaneous loads before the first can resolve.
    // Both should share the same in-flight promise and return the same Map instance.
    const [map1, map2] = await Promise.all([
      loadProjectEmbeddings(PROJECT_ID),
      loadProjectEmbeddings(PROJECT_ID),
    ]);
    // Only 1 meta call + 1 part call = 2 fetches total, NOT 4 (which would happen
    // without the inFlight dedup).
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    // Both callers receive the same Map reference (not a copy).
    expect(map1).toBe(map2);
  });
});
