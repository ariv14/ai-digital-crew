/**
 * Public-read Firestore REST client.
 *
 * Uses the unauthenticated REST API. All collections this client touches
 * (projects, projectsCache, embeddingsCache, searchCache) are public-read
 * per firestore.rules.
 *
 * Does NOT support writes. The Worker is read-only against Firestore;
 * cache writes go to Cloudflare KV.
 */

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';

export interface FirestoreValue {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
  nullValue?: null;
}

export interface FirestoreDoc {
  name: string;
  fields: Record<string, FirestoreValue>;
  createTime?: string;
  updateTime?: string;
}

export async function getDocument(projectId: string, path: string): Promise<FirestoreDoc | null> {
  const url = `${FIRESTORE_BASE}/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Firestore getDocument(${path}) failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as FirestoreDoc;
}

export interface EmbeddingsCacheMeta {
  partCount: number;
  totalProjects: number;
}

export async function fetchEmbeddingsCacheMeta(projectId: string): Promise<EmbeddingsCacheMeta> {
  const doc = await getDocument(projectId, 'embeddingsCache/meta');
  if (!doc) {
    throw new Error('embeddingsCache/meta not found');
  }
  return {
    partCount: Number(doc.fields.partCount?.integerValue ?? '0'),
    totalProjects: Number(doc.fields.totalProjects?.integerValue ?? '0'),
  };
}

export interface EmbeddingEntry {
  fullName: string;
  embedding: number[];
}

export async function fetchEmbeddingsCachePart(projectId: string, partIndex: number): Promise<EmbeddingEntry[]> {
  const doc = await getDocument(projectId, `embeddingsCache/part${partIndex}`);
  if (!doc) return [];
  const entries = doc.fields.entries?.arrayValue?.values ?? [];
  const result: EmbeddingEntry[] = [];
  for (const entry of entries) {
    const map = entry.mapValue?.fields;
    if (!map) continue;
    const fullName = map.fullName?.stringValue;
    const embeddingValues = map.embedding?.arrayValue?.values ?? [];
    if (typeof fullName !== 'string' || embeddingValues.length === 0) continue;
    const embedding: number[] = [];
    for (const v of embeddingValues) {
      if (typeof v.doubleValue === 'number') embedding.push(v.doubleValue);
      else if (typeof v.integerValue === 'string') embedding.push(Number(v.integerValue));
    }
    result.push({ fullName, embedding });
  }
  return result;
}

/**
 * Run a structured query for a single project document by fullName.
 * Used by /api/badge.
 */
export async function queryProjects(projectId: string, fullName: string): Promise<FirestoreDoc[]> {
  const url = `${FIRESTORE_BASE}/projects/${projectId}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'projects' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'fullName' },
          op: 'EQUAL',
          value: { stringValue: fullName },
        },
      },
      limit: 1,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Firestore queryProjects(${fullName}) failed: ${res.status} ${res.statusText}`);
  }
  const rows = (await res.json()) as Array<{ document?: FirestoreDoc }>;
  return rows.map(r => r.document).filter((d): d is FirestoreDoc => d !== undefined);
}
