# Firebase Functions v2 → Cloudflare Workers Migration

**Status:** Approved design, ready for implementation plan
**Date:** 2026-04-10
**Author:** Claude (brainstorming session) + @ariv14 (approval)

## Context

AI Digital Crew currently runs two Firebase Functions v2 at `us-central1`:

- `getQueryEmbedding` (callable) — powers the homepage semantic search. Handles 4 modes: `query`, `query + rankProjects`, `findSimilar`, `findSimilarBatch`. Uses Gemini `gemini-embedding-001` (primary) with Cloudflare Workers AI `@cf/baai/bge-large-en-v1.5` (fallback). Caches query embeddings in Firestore `searchCache` (24h TTL) and loads all project embeddings from `embeddingsCache/part{i}` into an in-memory Map (1h TTL).
- `trendBadge` (HTTPS) — serves dynamic SVG trend badges (`hot` / `rising` / `steady` / `declining` / `new`) for embedding in third-party markdown. Reads one `projects` document per request, caches SVGs in-memory for 1h, IP-rate-limited.

Firebase Functions v2 runs on Cloud Run, which requires an active billing account on the GCP project regardless of whether the free tier is exceeded. The `ai-digital-crew` project has had billing disabled since ≥ 2026-04-02, causing both functions to continuously return `"The request failed because billing is disabled for this project."` This has broken semantic search and trend badges for all users for 8+ days.

The daily scrape pipeline is unaffected because it uses the Firebase Admin SDK writing directly to Firestore (which has a free tier quota independent of billing status).

The rest of the site — `index.html` SPA, Cloudflare Pages hosting, Firebase Auth (Spark plan, free), Firestore reads/writes within free tier — is healthy.

## Goals

1. **Zero ongoing cost.** No GCP billing re-enable, no recurring cost on any Cloudflare service. Must stay inside Cloudflare free-tier limits at current and 10× current traffic.
2. **Full behavior parity** with both existing Firebase Functions: all 4 `getQueryEmbedding` modes and `trendBadge` produce responses indistinguishable from the current implementation within 5% latency tolerance.
3. **No data migration.** Firestore remains the source of truth for project data, embeddings, and trend metrics. The daily scrape pipeline is untouched.
4. **Thorough audit** alongside the migration: a standalone audit document capturing behavior parity, security posture, performance benchmarks, cost projections, and rollback readiness.
5. **Safe cutover** with an explicit frontend kill switch and deploy-in-stages rollout.

## Non-goals

- Migrating off Firebase Auth. Firebase Auth is free on Spark plan and continues to power the site's OAuth flows for project submission. Only the *search API* stops verifying Firebase tokens.
- Migrating off Firestore. The public-read model (see "Firestore rules prerequisite" below) makes Firestore-from-Workers access trivial, and the scrape pipeline uses Admin SDK anyway.
- Removing search analytics. `searchAnalytics` is written directly from the authenticated frontend and continues to work unchanged.
- Migrating the daily scrape pipeline to Workers. Out of scope.
- Multi-region or edge-worker-specific routing optimizations. Default Cloudflare Workers global deployment is sufficient.
- Adding new search features (personalization, history, premium tier). Parity only.

## Firestore rules prerequisite (already satisfied)

From `firestore.rules`:

```
match /projects/{projectId}        { allow read: if true; ... }
match /projectsCache/{docId}       { allow read: if true; allow write: if false; }
match /embeddingsCache/{docId}     { allow read: if true; allow write: if false; }
match /searchCache/{cacheId}       { allow read: if true; allow write: if false; }
match /searchAnalytics/{docId}     { allow create, update: if request.auth != null; read: if false; }
```

Every collection the Worker needs to read (`projects`, `embeddingsCache`, `projectsCache`) is public-read. **No service account, no Admin SDK, no Firebase credentials in the Worker.** This is the single largest enabler of the migration.

The Worker does not write to any Firestore collection. Query embedding caching moves to Cloudflare KV. Search analytics continues to be written directly by the authenticated frontend using the Firebase Web SDK (unchanged).

## Architecture

### Deployment topology

- **One Worker** named `aidigitalcrew-api`, deployed via Wrangler.
- **One production route:** `aidigitalcrew.com/api/*` via Cloudflare Worker Route. Same-origin to the frontend — no CORS preflight, no CSP `connect-src` changes beyond removing the now-dead `*.cloudfunctions.net` entry.
- **Two HTTP routes** in the Worker:
  - `POST /api/search` — replaces all 4 modes of `getQueryEmbedding`
  - `GET  /api/badge?repo=owner/name` — replaces `trendBadge`
- **Staging strategy:** `wrangler dev` against staging Firestore plus a pre-production deploy without attached route (callable directly via the assigned `*.workers.dev` URL) for smoke testing before route cutover.

### Component diagram

```
Browser (aidigitalcrew.com, Cloudflare Pages)
  │ fetch('/api/search',  { body: { query, rankProjects } })
  │ fetch('/api/badge?repo=owner/name')
  ▼
Cloudflare edge  (same origin — no CORS)
  │ Worker Route: aidigitalcrew.com/api/*
  ▼
┌─────────────────────────────────────────────────────┐
│ aidigitalcrew-api Worker                            │
│                                                     │
│  Router ── /api/search ─▶ searchHandler             │
│         │                     │                    │
│         │                     ├─ SEARCH_RATE_LIMITER (30/min/IP)
│         │                     ├─ origin check       │
│         │                     ├─ input validation   │
│         │                     ├─ KV QUERY_EMBEDDING_CACHE (24h)
│         │                     ├─ isolate Map: embCache (1h)
│         │                     ├─ Firestore REST (public read)
│         │                     ├─ Gemini REST (primary)
│         │                     └─ env.AI.run (fallback)
│         │                                            │
│         └── /api/badge ─▶ badgeHandler              │
│                               │                     │
│                               ├─ BADGE_RATE_LIMITER (60/min/IP)
│                               ├─ caches.default (1h, native)
│                               ├─ Firestore REST (single doc)
│                               └─ generateBadgeSvg() │
└─────────────────────────────────────────────────────┘
  │
  ▼
Firestore REST API (public-read, no auth)
Gemini REST API (key via wrangler secret)
Cloudflare Workers AI (native binding, no key)
```

### Bindings and secrets

| Name | Type | Purpose |
|---|---|---|
| `AI` | Workers AI binding | Fallback embedding provider (`@cf/baai/bge-large-en-v1.5`). Zero config, keyless. |
| `QUERY_EMBEDDING_CACHE` | KV Namespace | Cached query embeddings, 24h TTL. |
| `SEARCH_RATE_LIMITER` | Rate Limiting binding (currently configured under `[[unsafe.bindings]]` per Cloudflare's documentation; the API is GA-ready but the wrangler config namespace is still labeled `unsafe`) | 30 req/min per IP on `/api/search`. |
| `BADGE_RATE_LIMITER` | Rate Limiting binding (same as above) | 60 req/min per IP on `/api/badge`. |
| `GCP_PROJECT_ID` | Plaintext var | `"ai-digital-crew"` for Firestore REST URL construction. |
| `CORS_ORIGIN` | Plaintext var | `"https://aidigitalcrew.com"` for optional allowlist check. |
| `GEMINI_API_KEY` | Secret (`wrangler secret put`) | Google AI Studio key for Gemini REST calls. |

No service account JSON, no Firebase Admin credentials, no JWKS, no JWT library.

## Data flow — `/api/search`

For all 4 modes of the current `getQueryEmbedding`:

**Mode 1: Plain query embedding** (`{ query }`)
1. Rate limit check (30/min/IP). If exceeded → `429`.
2. Validate: `query` is a non-empty string ≤ 200 chars. Else → `400`.
3. Normalize query: `query.toLowerCase().trim()`.
4. Hash: `sha256(normalized).slice(0, 32)` — key for KV.
5. KV lookup `QUERY_EMBEDDING_CACHE`. If hit → return cached `{ embedding, provider, dimensions, cached: true }`.
6. Else: embed via Gemini REST (with 4× exponential-backoff retry on 5xx/429). On failure, fall back to `env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [normalized] })`. If both fail → `500 { error: 'All embedding providers failed' }`.
7. Write to KV with `expirationTtl: 86400`.
8. Return `{ embedding, provider, dimensions, cached: false }`.

**Mode 2: Query + rank** (`{ query, rankProjects: true }`)
1. Steps 1–7 as above to obtain `queryEmbedding` and `provider`.
2. Lazy-load project embeddings cache (`embCache`): if null or stale (> 1h), fetch `embeddingsCache/meta` via Firestore REST to get `partCount`, then fetch `embeddingsCache/part0..partN` in parallel, flatten into a `Map<fullName, number[]>`, store at module scope.
3. For each `(fullName, projectEmb)` in the map, compute `cosineSimilarity(queryEmbedding, projectEmb)`. Skip entries where the dimension doesn't match the query's provider (Gemini 3072 vs Cloudflare 1024).
4. Collect entries with `score > 0.25`, sort descending, slice `[:12]`.
5. Return `{ rankings: [{ fullName, score }], provider, cached }`.

**Mode 3: Find similar** (`{ findSimilar: "owner/repo" }`)
1. Rate limit check (same limiter, but cheap path — cache-only, no Gemini cost). Rationale: even cache-only requests consume Firestore REST reads.
2. Validate: `findSimilar` is a string ≤ 200 chars.
3. Lazy-load `embCache`.
4. Look up `targetEmb = embCache.get(targetName)`. If missing → `{ rankings: [], provider: 'cached', cached: true }`.
5. Cosine-rank all other projects vs `targetEmb`, filter `> 0.25`, sort, slice `[:12]`.
6. Return `{ rankings, provider: 'cached', cached: true }`.

**Mode 4: Batch find similar** (`{ findSimilarBatch: [...1..12] }`)
1. Rate limit check.
2. Validate: array of 1–12 strings, each ≤ 200 chars.
3. Lazy-load `embCache`.
4. For each target: cosine-rank other projects, filter `> 0.25`, slice `[:3]`.
5. Return `{ batchResults: { [targetName]: [{ fullName, score }] }, provider: 'cached', cached: true }`.

## Data flow — `/api/badge`

1. Rate limit check (60/min/IP). If exceeded → `429 "Rate limit exceeded"`.
2. Validate `?repo=owner/name` query parameter present, string, ≤ 200 chars. Else → `400`.
3. `caches.default.match(request)` — if hit (1h `Cache-Control`), return cached SVG response immediately.
4. Firestore REST: `GET /documents/projects?structuredQuery...` equivalent — use structured query POST to `projects` collection where `fullName == repo`, limit 1. (Firestore REST supports structured queries.)
5. If empty → `404 "Project not found"`.
6. Extract `trend_momentum` (round to integer) and `trend_label`. Generate SVG via `generateBadgeSvg()` (identical code to current implementation, copy-pasted).
7. Return SVG with `Content-Type: image/svg+xml` + `Cache-Control: public, max-age=3600, s-maxage=3600`.
8. `ctx.waitUntil(caches.default.put(request, response.clone()))` so subsequent requests hit the edge cache.

## Caching strategy

Three distinct layers, each matched to its access pattern:

| Layer | Medium | TTL | Scope | Key | Reason |
|---|---|---|---|---|---|
| Query embeddings | Cloudflare KV | 24h (native `expirationTtl`) | Global | `sha256(normalized_query)[:32]` | Small values (~24KB), infrequent writes, global consistency is fine because KV eventual consistency is measured in seconds. |
| Project embeddings Map | Worker isolate memory | 1h | Per-isolate | N/A (single Map) | 28 MB total — too large for a single KV value (25 MB cap). Isolate memory is effectively free and rebuild cost is ~300 ms on cold start only. |
| Badge SVGs | `caches.default` (Cloudflare Cache API) | 1h via `Cache-Control` | Edge-local | Request URL | Simpler than KV, respects CDN semantics, zero configuration. |

**Why not KV for project embeddings:** KV max value is 25 MB. Data is ~28 MB. Sharding into 2 blobs would work but complicates invalidation. Isolate memory with lazy Firestore REST load is simpler and has better latency (Map lookup < 1 µs vs KV read ~10–50 ms per lookup).

**Future optimization (not in scope):** Precompute the serialized embeddings Map into a static `embeddings.json` file committed to the repo during the daily scrape, served as a static asset from Cloudflare Pages with long cache headers. Reduces cold-start fetches from ~40 Firestore REST calls to 1 CDN read. Deferred because it couples the scrape pipeline cadence to the Worker and adds repo size.

## Security model

**No Firebase Auth requirement on the search API.** The original function used auth purely as a quota guard, not a product feature. Removing it simplifies the Worker substantially and eliminates JWT verification code (a common source of bugs).

Defense in depth:

1. **Cloudflare Rate Limiting binding** — enforced at the platform layer before Worker code runs.
   - `SEARCH_RATE_LIMITER`: 30 req/min per IP.
   - `BADGE_RATE_LIMITER`: 60 req/min per IP.
2. **Origin check** (search only) — requests must have `Origin: https://aidigitalcrew.com` or a matching `Referer`. `/api/badge` deliberately has no origin check since badges are embedded in third-party markdown and served to various user agents.
3. **Input validation** — strict string type checks, length caps, array size caps. Invalid inputs return `400` with the specific reason. Never echo the raw query in error messages (privacy).
4. **Logging** — `console.log` for cache hit/miss, provider used, rate limit hits. Never log the full query string or embedding values. Log structured JSON for easy Cloudflare Logs parsing.
5. **Secrets** — `GEMINI_API_KEY` only via `wrangler secret put`. Never in code, never in `vars`, never in error responses.

**Abuse escalation path** (not implemented up front): if IP-based rate limiting is insufficient in production, add Cloudflare Turnstile (invisible CAPTCHA, free, unlimited) to the frontend's search form. Requires a ~30-line frontend change and one additional Worker API call per search. Documented but deferred.

**Preserving Firebase Auth for the rest of the site:** The site's Firebase Auth flows (OAuth with Google / GitHub / Facebook, project submission gating, account linking, account deletion) continue to work unchanged. Firebase Auth is free on the Spark plan and has no dependency on the Cloud Functions billing state.

## Embedding provider strategy

Preserve the current Gemini-primary + Cloudflare-fallback pattern, but swap mechanisms:

- **Primary: Gemini `gemini-embedding-001` via REST API.** `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}` with body `{ content: { parts: [{ text }] } }`. Retry wrapper mirrors the `callGeminiWithRetry` pattern from `scripts/daily-scrape.js`: 4 attempts, exponential backoff 2s/4s/8s/cap-30s, retry only on HTTP 5xx and 429. Returns `{ values: number[], provider: 'gemini', dimensions: 3072 }`.
- **Fallback: Cloudflare Workers AI via native binding.** `await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [normalizedQuery] })`. No API key. No REST hop to a sibling Cloudflare endpoint. Runs in the same datacenter as the Worker. Returns `{ values: number[], provider: 'cloudflare', dimensions: 1024 }`.
- **Dimension handling during ranking:** the `provider` field is stored alongside cached query embeddings and propagated into rank responses. When ranking against `embCache`, match against `embedding_gemini` if provider is Gemini, else `embedding_cloudflare`. Both are already stored per project by the daily scrape (`embedding-provider.js#generateAllEmbeddings`).

## Cutover plan (four stages)

Each stage has an explicit success criterion and rollback path.

**Stage 1 — Build + local verify.** Implement the Worker locally. Run `wrangler dev` pointing at staging Firestore. Smoke-test each endpoint with curl + sample payloads captured from the existing Firebase Function responses. Verify parity matrix (audit deliverable §1). No Cloudflare deploy yet. **Rollback: delete local files.**

**Stage 2 — Deploy Worker, no route attached.** `wrangler deploy` to the production Cloudflare account without the `aidigitalcrew.com/api/*` route. Worker is reachable at `ai-digital-crew-api.<account>.workers.dev` for direct testing but not attached to production traffic. Verify via curl. **Rollback: `wrangler delete aidigitalcrew-api`.**

**Stage 3 — Attach route + frontend feature flag (off).** Two simultaneous changes merged together:
1. Add the `aidigitalcrew.com/api/*` route to the deployed Worker via `wrangler.toml` + `wrangler deploy`.
2. Push a frontend change that adds a `USE_WORKERS_API` constant in `index.html`, defaulting to `false`. When `false`, the existing Firebase callable is used (currently broken due to billing — errors to user, same as today). When `true`, `fetch('/api/search', ...)` is used instead.
**Rollback: unbind the route in the Cloudflare dashboard + revert the frontend commit.**

**Stage 4 — Flip flag to true + verify.** Single frontend commit flips `USE_WORKERS_API = true`. Monitor Cloudflare Worker metrics dashboard for 10 minutes. Success criteria, all measured over a rolling 10-minute window unless noted:
- Worker 5xx response rate < 1%
- `/api/search` p95 latency < 2 s
- `/api/badge` p95 latency < 500 ms
- Rate limiter (429) response rate within 50% of expected legitimate-rejection baseline (no false-positive spike)
- Manual smoke test: 5 different search queries return relevant results in a real browser, with results visually consistent against the pre-billing-outage behavior captured from screenshots
- Manual smoke test: 3 badge URLs render correctly in a test markdown preview

**If all criteria met for 24 hours:** delete `functions/index.js`, remove the Firebase Functions deploy steps from any remaining workflows, remove `*.cloudfunctions.net` from CSP, delete the `USE_WORKERS_API` flag (feature becomes unconditional).

**If any criterion fails:** flip `USE_WORKERS_API = false` in a revert commit. Investigate offline. Firebase Functions source remains deployable as a rollback target until Stage 4 final cleanup. Cloudflare Worker stays attached (can be left idle) while investigation proceeds.

## Rollback strategy

Two independent rollback mechanisms at every stage from Stage 3 onwards:

1. **Frontend kill switch (`USE_WORKERS_API` constant).** Single-line change + redeploy. Frontend immediately stops calling the Worker. Reaches production within the Cloudflare Pages cache invalidation window (~30 s).
2. **Cloudflare Worker route unbind.** Cloudflare dashboard → Workers Routes → delete the `aidigitalcrew.com/api/*` route. Immediate. Worker continues existing but receives no traffic.

**Hard rollback criteria** (any of these triggers automatic flip to `false`):
- Worker 5xx rate > 1% over a 10-minute window.
- `/api/search` p95 latency > 2 s.
- Legitimate requests being blocked by rate limiter (> 5% of expected traffic).
- Any response containing user-visible text that differs from the Firebase Function reference behavior (measured via the audit parity matrix).
- KV read failures (> 0.1% over 10 minutes).

**Soft rollback criteria** (flag for investigation but don't auto-revert):
- Gemini primary provider failure rate > 10%.
- Cold-start rate > 20% (indicates isolate churn, not broken).
- Workers AI fallback being hit on > 5% of requests (Gemini reliability regression).

## Audit deliverables

A standalone audit document committed alongside the migration at `docs/audits/2026-04-10-workers-migration-audit.md`. The audit is not optional and not a follow-up — it ships with the migration PR.

1. **Behavior parity matrix.** Table of test cases for each of the 4 `getQueryEmbedding` modes + `/api/badge`. Each row: input JSON → expected response (per the existing `functions/index.js` source code) → Worker response → diff → pass/fail. At least 20 test cases across all modes. Expected responses are derived from the existing source code's documented behavior — **the audit does not depend on re-enabling GCP billing** at any point. If the user wants additional confidence, they can optionally re-enable billing on the staging project for a 1-hour validation window, but this is not required and not in the critical path.
2. **Security checklist.** OWASP API Top 10 walkthrough scoped to applicable items (injection, broken auth [intentional removal documented], excessive data exposure, rate limiting, improper asset management, security misconfiguration). Each item marked applicable/not-applicable with rationale.
3. **Performance benchmarks.** Cold-start time, warm p50 / p95 / p99 latency, KV read latency, `env.AI.run` latency, full search end-to-end time, Firestore REST read latency from the Worker runtime. Baseline against the current Firebase Function where possible.
4. **Cost projection.** Cloudflare Workers requests/day, KV reads/writes/storage, Workers AI calls, Firestore REST calls, Gemini API calls. Worked up at current traffic AND 10× current traffic. Explicit $0/month claim validated with math and Cloudflare's current free-tier limits cited.
5. **Rollback drill.** On the staging deploy, deliberately flip the flag mid-test and document recovery time and observed user impact.
6. **Code review checklist.** Line-by-line self-review using the project's code-review tooling against the final PR before merge. Output captured in the audit doc.

## Cost model

**Baseline traffic assumption:** ~200 search requests / day + ~500 badge requests / day ≈ 700 Worker invocations / day. This is an estimate based on the daily scrape volume, the Firestore read pattern visible in the cache, and typical traffic for a single-page community site of this size. If actual traffic differs by an order of magnitude in either direction, the cost projection still resolves to $0 (free tier headroom is large enough).

| Service | Free-tier limit | Projected daily usage | Headroom |
|---|---|---|---|
| Workers requests | 100,000 / day | ~700 / day | 99.3% |
| Workers AI (fallback) | 10,000 / day | ~0 (normal) / ~30 (Gemini outage) | 99.7% |
| KV reads | 100,000 / day | ~500 / day | 99.5% |
| KV writes | 1,000 / day | ~30 / day (unique queries) | 97% |
| KV storage | 1 GB | ~2 MB (30 days × ~30 entries × 24 KB) | 99.8% |
| Rate Limiting actions | 10,000 / day | ~700 / day | 93% |
| Cache API | unlimited | — | — |
| Firestore reads (REST) | 50,000 / day | ~580 / day (isolate rebuilds + badge single-doc reads) | 98.8% |
| Gemini API (Google AI free tier) | ~1,500 / day | ~30 / day (unique queries) | 98% |

**Projected monthly cost: $0.00** at current traffic and $0.00 at 10× current traffic.

## Frontend changes

Three surgical edits in `index.html`:

1. **CSP `connect-src`** — remove `https://*.cloudfunctions.net` (no longer called). `'self'` covers the same-origin `/api/*` calls.
2. **`getEmbeddingFn()` refactor** (currently ~lines 1299–1306) — replace the dynamic `httpsCallable` import with:
   ```js
   async function callSearch(data) {
     const res = await fetch('/api/search', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify(data),
     });
     if (!res.ok) throw new Error(`Search API error ${res.status}`);
     return res.json();
   }
   ```
   All call sites that previously invoked the Firebase callable now await `callSearch(...)` instead. Response shape is identical.
3. **Badge URL generation** (around line 3061) — replace the Cloud Function URL with `/api/badge?repo=${encodeURIComponent(repoFullName)}`.

Total diff: estimated ~15 lines changed in the 251 KB `index.html`. One additional edit: `project.html` has one badge URL that needs the same update.

Search analytics writes (from authenticated frontend to `searchAnalytics` collection) are unchanged.

## What stays untouched

- Firebase Hosting config, Firestore rules, Firestore schema, all 1163 existing project documents.
- The daily scrape pipeline (`scripts/daily-scrape.js`, `scripts/substack-publish.js`, `scripts/embedding-provider.js`). The Gemini-retry and Substack-non-fatal patches from the earlier incident investigation remain as a separate, small commit inside the same workstream but are architecturally independent.
- Cloudflare Pages hosting, `_headers`, `_redirects`.
- Firebase Auth flows for project submission, account linking, account deletion.
- GitHub Actions workflows (except the eventual removal of Firebase Functions deploy steps in Stage 4 cleanup, if any such steps exist — there are currently none).

## Open questions and deferred items

- **Precomputed static embeddings file.** Noted as a future optimization in the caching section. Not in scope for this migration.
- **Turnstile rollout.** Noted as an abuse escalation path. Not in scope unless rate limiting proves insufficient.
- **Cron gap April 8–10.** The scheduled daily-scrape cron has not fired on Apr 8, 9, or 10. Independent of this migration; investigated separately after Stage 4.
- **Removal of the `embedding_cloudflare` field from project documents.** Once the Worker is stable and using native Workers AI binding, we could reconsider whether we still need per-project Cloudflare embeddings stored alongside Gemini ones. Deferred until post-migration.

## Success criteria

The migration is considered complete when **all** of the following are true for 24 continuous hours:

1. All search requests on `aidigitalcrew.com` go through the Worker (verified via Cloudflare Worker metrics).
2. Worker error rate < 1%.
3. `/api/search` p95 latency < 2 s, `/api/badge` p95 latency < 500 ms.
4. Zero user-visible regressions in the parity matrix.
5. `functions/index.js` and any related Firebase Functions deploy configuration has been removed from the repo.
6. The audit document is committed and reviewed.
7. GCP billing on `ai-digital-crew` can be (but does not need to be) permanently disabled with no user-facing impact.

## Next step

After this spec is reviewed and approved, invoke the `writing-plans` skill to produce a detailed, step-by-step implementation plan that a developer (or an agent) can execute with explicit check-in points.
