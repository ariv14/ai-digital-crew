import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getDocument,
  queryProjects,
  fetchEmbeddingsCacheMeta,
  fetchEmbeddingsCachePart,
  type FirestoreDoc,
} from '../src/lib/firestore';

const PROJECT_ID = 'ai-digital-crew';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(responses: Array<{ url: RegExp; body: object; status?: number }>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const match = responses.find(r => r.url.test(url));
    if (!match) {
      throw new Error(`Unexpected fetch to ${url}`);
    }
    return new Response(JSON.stringify(match.body), {
      status: match.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('getDocument', () => {
  it('fetches a single document by path and returns the parsed body', async () => {
    mockFetch([
      {
        url: /projectsCache\/featured$/,
        body: {
          name: `projects/${PROJECT_ID}/databases/(default)/documents/projectsCache/featured`,
          fields: { fullName: { stringValue: 'foo/bar' } },
          updateTime: '2026-04-06T13:26:14.148211Z',
        },
      },
    ]);
    const doc = await getDocument(PROJECT_ID, 'projectsCache/featured');
    expect(doc).not.toBeNull();
    expect(doc!.fields.fullName?.stringValue).toBe('foo/bar');
  });

  it('returns null on 404', async () => {
    mockFetch([{ url: /missing$/, body: { error: { code: 404 } }, status: 404 }]);
    const doc = await getDocument(PROJECT_ID, 'projectsCache/missing');
    expect(doc).toBeNull();
  });

  it('throws on non-404 errors', async () => {
    mockFetch([{ url: /broken$/, body: { error: { code: 500 } }, status: 500 }]);
    await expect(getDocument(PROJECT_ID, 'projectsCache/broken')).rejects.toThrow(/500/);
  });
});

describe('fetchEmbeddingsCacheMeta', () => {
  it('returns the partCount as a number', async () => {
    mockFetch([
      {
        url: /embeddingsCache\/meta$/,
        body: {
          name: 'meta',
          fields: {
            partCount: { integerValue: '40' },
            totalProjects: { integerValue: '1163' },
          },
        },
      },
    ]);
    const meta = await fetchEmbeddingsCacheMeta(PROJECT_ID);
    expect(meta.partCount).toBe(40);
    expect(meta.totalProjects).toBe(1163);
  });
});

describe('fetchEmbeddingsCachePart', () => {
  it('returns parsed entries with fullName + embedding tuples', async () => {
    mockFetch([
      {
        url: /embeddingsCache\/part0$/,
        body: {
          name: 'part0',
          fields: {
            entries: {
              arrayValue: {
                values: [
                  {
                    mapValue: {
                      fields: {
                        fullName: { stringValue: 'foo/bar' },
                        embedding: { arrayValue: { values: [{ doubleValue: 0.1 }, { doubleValue: 0.2 }] } },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ]);
    const entries = await fetchEmbeddingsCachePart(PROJECT_ID, 0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ fullName: 'foo/bar', embedding: [0.1, 0.2] });
  });

  it('returns empty array when part doc has no entries field', async () => {
    mockFetch([
      {
        url: /embeddingsCache\/part1$/,
        body: { name: 'part1', fields: {} },
      },
    ]);
    const entries = await fetchEmbeddingsCachePart(PROJECT_ID, 1);
    expect(entries).toEqual([]);
  });
});

describe('queryProjects', () => {
  it('runs a structuredQuery and returns matched docs', async () => {
    mockFetch([
      {
        url: /:runQuery$/,
        body: [
          {
            document: {
              name: `projects/${PROJECT_ID}/databases/(default)/documents/projects/abc123`,
              fields: {
                fullName: { stringValue: 'foo/bar' },
                trend_momentum: { doubleValue: 75.5 },
                trend_label: { stringValue: 'hot' },
              },
            },
          },
        ],
      },
    ]);
    const docs = await queryProjects(PROJECT_ID, 'foo/bar');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.fields.fullName?.stringValue).toBe('foo/bar');
  });

  it('returns empty array when query has no matches', async () => {
    mockFetch([{ url: /:runQuery$/, body: [{}] }]);
    const docs = await queryProjects(PROJECT_ID, 'no/such');
    expect(docs).toEqual([]);
  });
});
