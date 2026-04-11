import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { handleBadge } from '../src/routes/badge';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

const FIRESTORE_HOST = 'https://firestore.googleapis.com';
const QUERY_PATH = `/v1/projects/${env.GCP_PROJECT_ID}/databases/(default)/documents:runQuery`;

function mockProjectFound(repo: string, momentum: number, label: string) {
  fetchMock.get(FIRESTORE_HOST).intercept({ path: QUERY_PATH, method: 'POST' }).reply(200, [
    {
      document: {
        name: `projects/${env.GCP_PROJECT_ID}/databases/(default)/documents/projects/abc`,
        fields: {
          fullName: { stringValue: repo },
          trend_momentum: { doubleValue: momentum },
          trend_label: { stringValue: label },
        },
      },
    },
  ]);
}

function mockProjectMissing() {
  fetchMock.get(FIRESTORE_HOST).intercept({ path: QUERY_PATH, method: 'POST' }).reply(200, [{}]);
}

describe('handleBadge', () => {
  it('returns 400 when ?repo= is missing', async () => {
    const req = new Request('https://example.com/api/badge');
    const ctx = createExecutionContext();
    const res = await handleBadge(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when ?repo= is too long', async () => {
    const req = new Request(`https://example.com/api/badge?repo=${'a'.repeat(201)}`);
    const ctx = createExecutionContext();
    const res = await handleBadge(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it('returns 200 with SVG content type when project is found', async () => {
    mockProjectFound('foo/bar', 85, 'hot');
    const req = new Request('https://example.com/api/badge?repo=foo%2Fbar');
    const ctx = createExecutionContext();
    const res = await handleBadge(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    const body = await res.text();
    expect(body).toContain('<svg');
    expect(body).toContain('Hot 85');
  });

  it('returns 404 when project not found', async () => {
    mockProjectMissing();
    const req = new Request('https://example.com/api/badge?repo=no%2Fsuch');
    const ctx = createExecutionContext();
    const res = await handleBadge(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it('sets Cache-Control max-age=3600 on successful responses', async () => {
    mockProjectFound('foo/bar', 30, 'steady');
    const req = new Request('https://example.com/api/badge?repo=foo%2Fbar');
    const ctx = createExecutionContext();
    const res = await handleBadge(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.headers.get('Cache-Control')).toContain('max-age=3600');
  });
});
