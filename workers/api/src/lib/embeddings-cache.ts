import { fetchEmbeddingsCacheMeta, fetchEmbeddingsCachePart } from './firestore';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CachedMap {
  map: Map<string, number[]>;
  loadedAt: number;
}

// Module-scope cache — persists for the lifetime of the isolate.
let cached: CachedMap | null = null;
let inFlight: Promise<Map<string, number[]>> | null = null;

export interface LoadOptions {
  ttlMs?: number;
}

export async function loadProjectEmbeddings(
  projectId: string,
  opts: LoadOptions = {}
): Promise<Map<string, number[]>> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();

  if (cached && now - cached.loadedAt < ttlMs) {
    return cached.map;
  }

  // De-dupe concurrent loads on cold start
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const meta = await fetchEmbeddingsCacheMeta(projectId);
      const map = new Map<string, number[]>();

      // Fetch all parts in parallel for fast cold start
      const partPromises = Array.from({ length: meta.partCount }, (_, i) =>
        fetchEmbeddingsCachePart(projectId, i)
      );
      const allParts = await Promise.all(partPromises);
      for (const entries of allParts) {
        for (const e of entries) {
          map.set(e.fullName, e.embedding);
        }
      }

      cached = { map, loadedAt: Date.now() };
      return map;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Test-only: reset module state between tests. Do not call from production code. */
export function _resetForTesting(): void {
  cached = null;
  inFlight = null;
}
