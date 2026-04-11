const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-embedding-001';
const DIMENSIONS = 3072;

export class GeminiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GeminiError';
  }
}

export interface GeminiEmbeddingResult {
  values: number[];
  provider: 'gemini';
  dimensions: number;
}

export interface GeminiOptions {
  /** Default 2000 ms */
  initialBackoffMs?: number;
  /** Default 4 */
  maxAttempts?: number;
  /** Default 30000 ms */
  maxBackoffMs?: number;
}

/**
 * Generate an embedding via the Gemini REST API with retry-on-transient-errors.
 *
 * Retries (with exponential backoff) on HTTP 5xx and 429. Fails fast on 4xx
 * (other than 429), since those indicate prompt or auth bugs that won't
 * resolve with retries.
 */
export async function embedWithGemini(
  text: string,
  apiKey: string,
  opts: GeminiOptions = {}
): Promise<GeminiEmbeddingResult> {
  const initialBackoffMs = opts.initialBackoffMs ?? 2000;
  const maxAttempts = opts.maxAttempts ?? 4;
  const maxBackoffMs = opts.maxBackoffMs ?? 30000;

  const url = `${GEMINI_BASE}/models/${MODEL}:embedContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    content: { parts: [{ text }] },
  });

  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      // Network-level failure (DNS, TCP). Treat as transient.
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxAttempts) throw lastErr;
      await sleep(backoffMs(attempt, initialBackoffMs, maxBackoffMs));
      continue;
    }

    if (res.ok) {
      const data = (await res.json()) as { embedding?: { values?: number[] } };
      const values = data.embedding?.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new GeminiError(200, 'Gemini returned an empty embedding');
      }
      return { values, provider: 'gemini', dimensions: DIMENSIONS };
    }

    const transient = res.status === 429 || (res.status >= 500 && res.status <= 599);
    if (!transient) {
      const errBody = await res.text().catch(() => '');
      throw new GeminiError(res.status, `Gemini ${res.status}: ${errBody.slice(0, 200)}`);
    }

    lastErr = new GeminiError(res.status, `Gemini ${res.status} (transient)`);
    if (attempt === maxAttempts) throw lastErr;

    const wait = backoffMs(attempt, initialBackoffMs, maxBackoffMs);
    console.warn(`Gemini attempt ${attempt}/${maxAttempts} failed (${res.status}) — retrying in ${wait}ms`);
    await sleep(wait);
  }

  // Unreachable (loop always returns or throws), but TS doesn't know.
  throw lastErr ?? new GeminiError(0, 'Gemini retry loop exited unexpectedly');
}

function backoffMs(attempt: number, initial: number, cap: number): number {
  return Math.min(cap, initial * Math.pow(2, attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
