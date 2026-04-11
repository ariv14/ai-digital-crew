import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../src/lib/cosine';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('returns 0 when either vector is null', () => {
    // @ts-expect-error testing runtime guard
    expect(cosineSimilarity(null, [1, 0])).toBe(0);
    // @ts-expect-error testing runtime guard
    expect(cosineSimilarity([1, 0], null)).toBe(0);
  });

  it('returns 0 when lengths mismatch (defensive guard for dimension mismatch)', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });

  it('returns 0 for zero vectors (avoids divide-by-zero)', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('produces a value between 0 and 1 for two random positive vectors', () => {
    const a = [0.1, 0.2, 0.3, 0.4];
    const b = [0.4, 0.3, 0.2, 0.1];
    const result = cosineSimilarity(a, b);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});
