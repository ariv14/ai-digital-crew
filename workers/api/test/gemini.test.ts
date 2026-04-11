import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { embedWithGemini, GeminiError } from '../src/lib/gemini';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fetchMockSequence(responses: Response[]) {
  let i = 0;
  globalThis.fetch = vi.fn(async () => {
    if (i >= responses.length) throw new Error('Unexpected extra fetch call');
    return responses[i++]!;
  }) as typeof fetch;
}

const successBody = {
  embedding: { values: Array.from({ length: 3072 }, (_, i) => i / 3072) },
};

describe('embedWithGemini', () => {
  it('returns the embedding values on a 200 response', async () => {
    fetchMockSequence([
      new Response(JSON.stringify(successBody), { status: 200 }),
    ]);
    const result = await embedWithGemini('hello world', 'fake-api-key');
    expect(result.values).toHaveLength(3072);
    expect(result.provider).toBe('gemini');
    expect(result.dimensions).toBe(3072);
  });

  it('retries once on 503 then succeeds', async () => {
    fetchMockSequence([
      new Response('high demand', { status: 503 }),
      new Response(JSON.stringify(successBody), { status: 200 }),
    ]);
    const result = await embedWithGemini('hello', 'k', { initialBackoffMs: 1, maxAttempts: 4 });
    expect(result.values).toHaveLength(3072);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 (rate limit)', async () => {
    fetchMockSequence([
      new Response('rate limited', { status: 429 }),
      new Response(JSON.stringify(successBody), { status: 200 }),
    ]);
    const result = await embedWithGemini('hello', 'k', { initialBackoffMs: 1, maxAttempts: 4 });
    expect(result.values).toHaveLength(3072);
  });

  it('does NOT retry on 400', async () => {
    fetchMockSequence([new Response('bad request', { status: 400 })]);
    await expect(
      embedWithGemini('hello', 'k', { initialBackoffMs: 1, maxAttempts: 4 })
    ).rejects.toThrow(GeminiError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all 4 attempts on persistent 503', async () => {
    fetchMockSequence([
      new Response('503', { status: 503 }),
      new Response('503', { status: 503 }),
      new Response('503', { status: 503 }),
      new Response('503', { status: 503 }),
    ]);
    await expect(
      embedWithGemini('hello', 'k', { initialBackoffMs: 1, maxAttempts: 4 })
    ).rejects.toThrow(GeminiError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it('retries on a network-level fetch error then succeeds', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      if (call++ === 0) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(successBody), { status: 200 });
    }) as typeof fetch;

    const result = await embedWithGemini('hello', 'k', { initialBackoffMs: 1, maxAttempts: 4 });
    expect(result.values).toHaveLength(3072);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
