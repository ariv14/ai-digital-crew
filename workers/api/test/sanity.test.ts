import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/worker';
import type { Env } from '../src/worker';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

describe('worker (sanity)', () => {
  it('returns 200 ok on any request', async () => {
    const request = new Request('https://example.com/');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });
});
