/**
 * aidc-cron-trigger — fires the daily POTD scraper on cron.
 *
 * Cloudflare Workers Cron Triggers (free tier) fires `scheduled()` on the
 * schedule defined in wrangler.toml. This hands off to Pipedream, which runs
 * the actual scraper logic (~2–5 min, too long for a Worker's CPU budget).
 *
 * Also exposes a manual `fetch` trigger at `/run` (same secret-guarded) so
 * you can dispatch a run by curl without going through the Pipedream UI.
 */

export interface Env {
  PIPEDREAM_SCRAPE_WEBHOOK_URL: string;
  CRON_SHARED_SECRET: string;
}

async function fireScrape(env: Env, reason: string): Promise<Response> {
  if (!env.PIPEDREAM_SCRAPE_WEBHOOK_URL) {
    return new Response('PIPEDREAM_SCRAPE_WEBHOOK_URL not set', { status: 500 });
  }
  const res = await fetch(env.PIPEDREAM_SCRAPE_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cron-Secret': env.CRON_SHARED_SECRET ?? '',
    },
    body: JSON.stringify({ source: 'cf-worker', reason, at: new Date().toISOString() }),
  });
  const body = await res.text();
  console.log(`Pipedream ${res.status}: ${body.slice(0, 200)}`);
  return new Response(body, { status: res.status });
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const res = await fireScrape(env, `cron:${event.cron}`);
        if (!res.ok) console.error(`Scrape dispatch failed: ${res.status}`);
      })(),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/run') {
      return new Response('aidc-cron-trigger — POST /run with X-Cron-Secret to dispatch', { status: 404 });
    }
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    const got = request.headers.get('X-Cron-Secret');
    if (!env.CRON_SHARED_SECRET || got !== env.CRON_SHARED_SECRET) {
      return new Response('unauthorized', { status: 401 });
    }
    return fireScrape(env, 'manual-fetch');
  },
};
