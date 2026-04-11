import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/worker';

describe('router', () => {
  it('routes POST /api/search to the search handler (returns 403 without origin)', async () => {
    const req = new Request('https://aidigitalcrew.com/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403); // search rejects missing origin — proves routing worked
  });

  it('routes GET /api/badge to the badge handler (returns 400 without ?repo)', async () => {
    const req = new Request('https://aidigitalcrew.com/api/badge');
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400); // badge rejects missing repo — proves routing worked
  });

  it('returns 404 for unknown paths', async () => {
    const req = new Request('https://aidigitalcrew.com/api/unknown');
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it('returns 405 for GET /api/search', async () => {
    const req = new Request('https://aidigitalcrew.com/api/search', { method: 'GET' });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });

  it('returns 405 for POST /api/badge', async () => {
    const req = new Request('https://aidigitalcrew.com/api/badge', { method: 'POST' });
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });

  it('returns 200 ok for GET /api/health', async () => {
    const req = new Request('https://aidigitalcrew.com/api/health');
    const ctx = createExecutionContext();
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
