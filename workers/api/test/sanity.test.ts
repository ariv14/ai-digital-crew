import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/worker';

// Keep ProvidedEnv augmentation to make env carry the Worker's Env type
import type { Env } from '../src/worker';
declare module 'cloudflare:test' { interface ProvidedEnv extends Env {} }

describe('worker (sanity)', () => {
  it('returns 200 ok for /api/health', async () => {
    const request = new Request('https://example.com/api/health');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });
});
