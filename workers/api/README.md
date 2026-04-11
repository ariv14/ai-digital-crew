# aidigitalcrew-api

Cloudflare Worker that replaces Firebase Functions v2 (`getQueryEmbedding`, `trendBadge`).
Bound to `aidigitalcrew.com/api/*`. Reads Firestore via the public REST API (no service account).

## Local development

```bash
cd workers/api
npm install
wrangler login                                    # one-time
wrangler kv:namespace create QUERY_EMBEDDING_CACHE  # one-time, paste id into wrangler.toml
wrangler secret put GEMINI_API_KEY                # one-time, paste from Google AI Studio
npm run dev
```

`wrangler dev` runs the Worker locally with Miniflare. Reaches Firestore over the public internet using the
real production project read endpoints. Cache writes go to a local KV simulator. Rate limiter is disabled
locally (always succeeds).

## Tests

```bash
npm test            # one-shot
npm run test:watch  # watch mode
npm run typecheck   # tsc --noEmit
```

## Deploy

```bash
npm run deploy
```

In CI: pushed to main triggers `.github/workflows/deploy-workers.yml`.

## Architecture

See `docs/superpowers/specs/2026-04-10-workers-migration-design.md`.
