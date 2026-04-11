import { handleSearch } from './routes/search';
import { handleBadge } from './routes/badge';

export interface RateLimit {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

export interface Env {
  AI: Ai;
  QUERY_EMBEDDING_CACHE: KVNamespace;
  SEARCH_RATE_LIMITER: RateLimit;
  BADGE_RATE_LIMITER: RateLimit;
  GCP_PROJECT_ID: string;
  CORS_ORIGIN: string;
  GEMINI_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health') {
      return new Response('ok', { status: 200 });
    }

    if (path === '/api/search') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      return handleSearch(request, env, ctx);
    }

    if (path === '/api/badge') {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return handleBadge(request, env, ctx);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
