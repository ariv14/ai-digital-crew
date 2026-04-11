import type { Env } from '../worker';
import { generateBadgeSvg, type TrendLabel } from '../lib/svg';
import { queryProjects } from '../lib/firestore';
import { validateRepoName, ValidationError } from '../lib/validation';

const LABEL_TO_DISPLAY: Record<string, string> = {
  hot: 'Hot',
  rising: 'Rising',
  steady: 'Steady',
  declining: 'Cooling',
  new: 'New',
};

export async function handleBadge(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Rate limit (skipped if binding is undefined — local test environment)
  if (env.BADGE_RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.BADGE_RATE_LIMITER.limit({ key: ip });
    if (!success) {
      return new Response('Rate limit exceeded. Try again in a minute.', { status: 429 });
    }
  }

  // Cache check — use URL-only Request so we don't copy CF-Connecting-IP or other
  // per-request headers into the cache key object.
  const cacheKey = new Request(request.url);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  // Validate input
  const url = new URL(request.url);
  const repoParam = url.searchParams.get('repo');
  let repo: string;
  try {
    repo = validateRepoName(repoParam);
  } catch (err) {
    if (err instanceof ValidationError) {
      return new Response(err.message, { status: 400 });
    }
    throw err;
  }

  // Firestore lookup
  let docs;
  try {
    docs = await queryProjects(env.GCP_PROJECT_ID, repo);
  } catch (err) {
    console.error('badge: Firestore query failed', err);
    return new Response('Internal error', { status: 500 });
  }

  if (docs.length === 0) {
    return new Response('Project not found', { status: 404 });
  }

  const doc = docs[0]!;
  const momentum = doc.fields.trend_momentum?.doubleValue ?? 0;
  const trendLabelRaw = doc.fields.trend_label?.stringValue ?? 'steady';
  const score = Math.round(momentum).toString();
  const displayLabel = LABEL_TO_DISPLAY[trendLabelRaw] ?? 'Tracked';
  const svg = generateBadgeSvg(displayLabel, score, trendLabelRaw as TrendLabel);

  const response = new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });

  // Populate edge cache asynchronously — don't block the response
  ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}
