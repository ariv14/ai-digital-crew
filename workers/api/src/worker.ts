interface RateLimit {
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
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response('ok', { status: 200 });
  },
} satisfies ExportedHandler<Env>;
