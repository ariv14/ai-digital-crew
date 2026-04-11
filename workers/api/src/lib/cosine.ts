/**
 * Cosine similarity between two equal-length numeric vectors.
 *
 * Returns 0 (rather than throwing) on null inputs, length mismatch, or
 * zero-magnitude vectors. This matches the defensive behavior of the
 * original Firebase Function and ensures one bad embedding can never
 * crash a search response.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
