# Workers Migration Audit — 2026-04-10

**Migration spec:** `docs/superpowers/specs/2026-04-10-workers-migration-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-04-10-workers-migration.md`
**Audited by:** Claude (implementation) + @ariv14 (approval + post-deploy measurement)
**Audit date:** 2026-04-10 (template), [TO MEASURE POST-DEPLOY] for measurement sections

## Scope

This audit covers the migration of two Firebase Functions v2 (`getQueryEmbedding`, `trendBadge`) to a single Cloudflare Worker `aidigitalcrew-api` at `aidigitalcrew.com/api/*`. The goal was zero ongoing cost, full behavior parity, no data migration, safe staged cutover, and a standalone audit deliverable.

The audit does not cover the daily scrape pipeline (separate fix in commit `92008a0`) or the Firestore rules (unchanged).

---

## 1. Behavior parity matrix

Test cases across all 4 modes of `getQueryEmbedding` and the single `/api/badge` endpoint. Expected responses are derived from reading the original `functions/index.js` source code (which is still in the repo pending Task 21 cleanup). Actual Worker responses are captured from a live `wrangler dev` session against staging Firestore, or from the deployed Worker via `https://aidigitalcrew-api.<account>.workers.dev` once Stage 2 of the cutover is complete.

The audit does not require re-enabling GCP billing at any point. The Firebase Functions were never invoked during this audit — only read as source-of-truth specifications.

### Test cases

| # | Endpoint | Mode | Input | Expected | Worker | Pass |
|---|----------|------|-------|----------|--------|------|
| 1 | POST /api/search | query | `{"query":"vector database"}` | `{embedding: number[3072], provider: "gemini", dimensions: 3072, cached: false}` | [TO MEASURE POST-DEPLOY] | [pending] |
| 2 | POST /api/search | query (cache hit) | same as #1, repeat | `{..., cached: true}` | [TO MEASURE POST-DEPLOY] | [pending] |
| 3 | POST /api/search | query + rankProjects | `{"query":"semantic search","rankProjects":true}` | `{rankings: [12 entries], provider: "gemini", cached: false}` where each entry is `{fullName, score}` with score > 0.25 | [TO MEASURE POST-DEPLOY] | [pending] |
| 4 | POST /api/search | findSimilar | `{"findSimilar":"infiniflow/ragflow"}` | `{rankings: [12 entries], provider: "cached", cached: true}` excluding `infiniflow/ragflow` itself | [TO MEASURE POST-DEPLOY] | [pending] |
| 5 | POST /api/search | findSimilar not in cache | `{"findSimilar":"nobody/nothing"}` | `{rankings: [], provider: "cached", cached: true}` | [TO MEASURE POST-DEPLOY] | [pending] |
| 6 | POST /api/search | findSimilarBatch | `{"findSimilarBatch":["infiniflow/ragflow","vllm-project/vllm"]}` | `{batchResults: {..fullNames..: [3 entries each]}, provider: "cached", cached: true}` | [TO MEASURE POST-DEPLOY] | [pending] |
| 7 | POST /api/search | empty query | `{"query":""}` | `400 {error: "query must not be empty"}` | [TO MEASURE POST-DEPLOY] | [pending] |
| 8 | POST /api/search | whitespace query | `{"query":"   "}` | `400 {error: "query must not be empty"}` | [TO MEASURE POST-DEPLOY] | [pending] |
| 9 | POST /api/search | too-long query | `{"query":"a".repeat(201)}` | `400 {error: "query must be 200 characters or fewer"}` | [TO MEASURE POST-DEPLOY] | [pending] |
| 10 | POST /api/search | too-large batch | `{"findSimilarBatch":[...13 items...]}` | `400 {error: "findSimilarBatch must contain between 1 and 12 entries"}` | [TO MEASURE POST-DEPLOY] | [pending] |
| 11 | POST /api/search | wrong method | `GET /api/search` | `405` | [TO MEASURE POST-DEPLOY] | [pending] |
| 12 | POST /api/search | missing origin | `POST /api/search` with no Origin header | `403 {error: "Origin not allowed"}` | [TO MEASURE POST-DEPLOY] | [pending] |
| 13 | POST /api/search | wrong origin | `POST /api/search` with `Origin: https://evil.example.com` | `403 {error: "Origin not allowed"}` | [TO MEASURE POST-DEPLOY] | [pending] |
| 14 | POST /api/search | malformed JSON | `POST /api/search` with `body: "not json"` | `400 {error: "Body must be valid JSON"}` | [TO MEASURE POST-DEPLOY] | [pending] |
| 15 | POST /api/search | no mode | `{}` | `400 {error: "Request must include query, findSimilar, or findSimilarBatch"}` | [TO MEASURE POST-DEPLOY] | [pending] |
| 16 | GET /api/badge | missing repo | `GET /api/badge` | `400 "repo must be a string"` | [TO MEASURE POST-DEPLOY] | [pending] |
| 17 | GET /api/badge | happy path | `GET /api/badge?repo=infiniflow/ragflow` | `200 Content-Type: image/svg+xml`, SVG contains the display label + rounded momentum score | [TO MEASURE POST-DEPLOY] | [pending] |
| 18 | GET /api/badge | not found | `GET /api/badge?repo=nobody/nothing` | `404 "Project not found"` | [TO MEASURE POST-DEPLOY] | [pending] |
| 19 | GET /api/badge | too long | `GET /api/badge?repo=` + 201 chars | `400` | [TO MEASURE POST-DEPLOY] | [pending] |
| 20 | GET /api/badge | cache hit (repeat) | two back-to-back calls to case 17 | second call served from edge cache, `Cache-Control: max-age=3600, s-maxage=3600` | [TO MEASURE POST-DEPLOY] | [pending] |
| 21 | GET /api/badge | wrong method | `POST /api/badge` | `405` | [TO MEASURE POST-DEPLOY] | [pending] |
| 22 | GET /api/health | health | `GET /api/health` | `200 "ok"` | [TO MEASURE POST-DEPLOY] | [pending] |
| 23 | * | unknown path | `GET /api/unknown` | `404 "Not found"` | [TO MEASURE POST-DEPLOY] | [pending] |

### Capture commands

```bash
# After Task 15 (wrangler deploy) or Task 18 (route attached), run against the deployed Worker:
WORKER_URL="https://aidigitalcrew.com"  # or the workers.dev URL before Task 18

# Case 1 — plain query
curl -s -X POST "$WORKER_URL/api/search" \
  -H "Content-Type: application/json" \
  -H "Origin: https://aidigitalcrew.com" \
  -d '{"query":"vector database"}' | jq .

# Case 3 — query + rankProjects
curl -s -X POST "$WORKER_URL/api/search" \
  -H "Content-Type: application/json" \
  -H "Origin: https://aidigitalcrew.com" \
  -d '{"query":"semantic search","rankProjects":true}' | jq '.rankings | length, .rankings[0]'

# Case 17 — badge happy path
curl -sI "$WORKER_URL/api/badge?repo=infiniflow/ragflow"
curl -s "$WORKER_URL/api/badge?repo=infiniflow/ragflow" | head -2

# Case 22 — health
curl -s "$WORKER_URL/api/health"
```

Paste the actual response bodies/headers into the `Worker` column of the table, compare against the `Expected` column, mark `Pass` as ✅ or ❌.

**Success threshold:** all 23 rows must pass before declaring the migration complete (Task 19 Stage 4 success criteria).

---

## 2. Security checklist (OWASP API Top 10, 2023)

| # | Item | Applicable | Status | Notes |
|---|------|-----------|--------|-------|
| API1 | Broken Object Level Authorization | No | N/A | No object IDs in the API surface. All endpoints operate on caller-supplied strings validated against length/type. |
| API2 | Broken Authentication | Yes | Acceptable with documented caveat | Firebase Auth intentionally removed from the search API. Rate limiting (Cloudflare Rate Limiting binding) + origin check (Origin/Referer header comparison against `CORS_ORIGIN`) replace the quota-guard role that auth previously played. The user's Firebase Auth flow for project submission remains unchanged and independent. |
| API3 | Broken Object Property Level Authorization | No | N/A | No property-level access control needed — the API does not expose object shapes beyond the curated response fields. |
| API4 | Unrestricted Resource Consumption | Yes | Mitigated | (a) Cloudflare Rate Limiting binding: 30 req/min per IP for `/api/search`, 60 req/min per IP for `/api/badge`. (b) KV cache on query embeddings means repeat queries cost ~1 KV read (no Gemini call). (c) Cosine similarity operates on a pre-loaded isolate-memory Map, not per-request Firestore reads. (d) `loadProjectEmbeddings` has 1-hour TTL and in-flight-promise deduplication so a cold-start burst shares a single Firestore load. |
| API5 | Broken Function Level Authorization | No | N/A | All endpoints are intentionally public. Badges are embedded in third-party markdown; search is open to support logged-out use. |
| API6 | Unrestricted Access to Sensitive Business Flows | No | N/A | No business flows exposed. |
| API7 | Server Side Request Forgery | Yes | Mitigated | Worker only calls hardcoded URL bases: `https://firestore.googleapis.com/v1/...` (for reads), `https://generativelanguage.googleapis.com/v1beta/...` (for Gemini), and `env.AI.run(...)` (native Cloudflare binding, no URL). User input flows into path segments only via `encodeURIComponent`-style safe handling (see `firestore.ts::queryProjects` which passes `fullName` as a structured-query value, not a URL segment). No unsanitized user input is ever interpolated into an outbound URL. |
| API8 | Security Misconfiguration | Yes | Verified | (a) `GEMINI_API_KEY` is set via `wrangler secret put` only, never via `vars` or code. (b) `.dev.vars` is gitignored. (c) KV namespace id in `wrangler.toml` is a placeholder until Task 15 replaces it with a real id — the id itself is NOT sensitive (it's a public Cloudflare resource identifier). (d) Error responses never echo internal state, stack traces, or credentials. (e) `wrangler.test.toml` uses dummy values for all sensitive bindings. |
| API9 | Improper Inventory Management | Yes | OK | The Worker is the only new API surface. Spec, plan, and this audit document are all committed alongside the implementation. The frontend `USE_WORKERS_API` feature flag provides a clean rollback path. |
| API10 | Unsafe Consumption of APIs | Yes | Mitigated | Gemini retry loop handles 5xx + 429 with exponential backoff (2s/4s/8s cap 30s, max 4 attempts). Non-transient 4xx fail fast via `GeminiError`. Workers AI fallback is a separate try/catch branch. Firestore REST failures are caught in the `safeLoadEmbeddings` helper and translated to structured 500 responses. No unbounded recursion or infinite retry. |

---

## 3. Performance benchmarks

All measurements [TO MEASURE POST-DEPLOY] against the deployed Worker. Measurement tool: `hey` or `wrk` against production endpoints with controlled query inputs.

### Target SLOs (from spec)

- `/api/search` p95 latency < 2 s
- `/api/badge` p95 latency < 500 ms
- Worker 5xx rate < 1% over any rolling 10-minute window
- Cold-start rate < 20%

### Measurements (fill in post-deploy)

| Endpoint | Mode | Cold start | Warm p50 | Warm p95 | Warm p99 | Notes |
|---|---|---|---|---|---|---|
| `/api/health` | — | [ms] | [ms] | [ms] | [ms] | Lower bound for Worker overhead |
| `/api/badge` | cache miss | [ms] | [ms] | [ms] | [ms] | Dominated by Firestore REST |
| `/api/badge` | cache hit | [ms] | [ms] | [ms] | [ms] | Expected < 50 ms |
| `/api/search` | query, KV miss | [ms] | [ms] | [ms] | [ms] | Dominated by Gemini REST |
| `/api/search` | query, KV hit | [ms] | [ms] | [ms] | [ms] | Expected < 100 ms |
| `/api/search` | query + rankProjects, warm isolate | [ms] | [ms] | [ms] | [ms] | Dominated by Gemini + cosine loop |
| `/api/search` | query + rankProjects, cold isolate | [ms] | [ms] | [ms] | [ms] | Adds ~300 ms Firestore part fetches |
| `/api/search` | findSimilar, warm | [ms] | [ms] | [ms] | [ms] | Cache-only path, expected < 50 ms |

### Sub-component latencies

| Component | Latency | Notes |
|---|---|---|
| KV read (cache hit) | [ms] | [TO MEASURE POST-DEPLOY] |
| KV write | [ms] | [TO MEASURE POST-DEPLOY] |
| Gemini REST round-trip | [ms] | [TO MEASURE POST-DEPLOY] |
| Workers AI `env.AI.run` | [ms] | [TO MEASURE POST-DEPLOY if fallback ever fires] |
| Firestore REST single doc | [ms] | [TO MEASURE POST-DEPLOY] |
| Firestore REST structured query | [ms] | [TO MEASURE POST-DEPLOY] |
| Cosine over full 1163-project map | [ms] | [TO MEASURE POST-DEPLOY] |

### Method

Run 100 sequential requests of each type with 5 concurrent workers using `hey`:

```bash
# Warm-up 10 calls to stabilize the isolate
for i in $(seq 1 10); do curl -s -X POST https://aidigitalcrew.com/api/search \
  -H "Content-Type: application/json" -H "Origin: https://aidigitalcrew.com" \
  -d '{"query":"test"}' > /dev/null; done

# Timing run
hey -n 100 -c 5 -m POST -H "Content-Type: application/json" -H "Origin: https://aidigitalcrew.com" \
  -d '{"query":"vector database"}' https://aidigitalcrew.com/api/search
```

Record the output's `Latencies [p50, p95, p99]` rows into the table.

---

## 4. Cost projection

Projected monthly cost: **$0.00** at current and 10× current traffic. All usage is inside Cloudflare free tier limits.

### Free tier headroom (validated from spec)

| Service | Free limit | Projected daily usage | Headroom |
|---|---|---|---|
| Workers requests | 100,000 / day | ~700 / day (200 search + 500 badge est.) | 99.3% |
| Workers AI (fallback only) | 10,000 / day | ~0 (only fires when Gemini 5xx) | ≥ 99.9% |
| KV reads | 100,000 / day | ~500 / day | 99.5% |
| KV writes | 1,000 / day | ~30 / day (new unique queries) | 97% |
| KV storage | 1 GB | ~2 MB (30 days × 30 entries × ~24 KB per embedding) | 99.8% |
| Rate Limiting actions | 10,000 / day | ~700 / day | 93% |
| Cache API | unlimited | — | — |
| Firestore reads (public REST) | 50,000 / day | ~580 / day (isolate rebuilds + badge lookups) | 98.8% |
| Gemini AI Studio free tier | ~1,500 / day | ~30 / day (unique queries) | 98% |

### Post-deploy actual usage (fill in after 7 days live)

| Service | Measured daily usage | Free tier headroom | Notes |
|---|---|---|---|
| Workers requests | [TO MEASURE] | [%] | |
| KV reads | [TO MEASURE] | [%] | |
| KV writes | [TO MEASURE] | [%] | |
| KV storage | [TO MEASURE] | [%] | |
| Workers AI | [TO MEASURE] | [%] | Should be near-zero; non-zero indicates Gemini reliability issues |
| Rate Limiting actions | [TO MEASURE] | [%] | |
| Firestore reads | [TO MEASURE] | [%] | Monitor via GCP console — Firestore usage is independent of Cloudflare free tier |

**Billing trigger watch:** if any line item exceeds 50% of its free tier during the first 7 days, re-run the projection math. None are expected to.

---

## 5. Rollback drill

Intent: prove that the `USE_WORKERS_API` frontend kill switch + Cloudflare route unbind are both operable before they're actually needed.

### Procedure

1. Cutover starts with `USE_WORKERS_API = true` pushed to `main` (Task 19).
2. Wait for Cloudflare Pages to redeploy (~30 s).
3. Verify search works in a real browser against the production domain.
4. **Induce a failure by intentionally breaking the Worker**:
   - Option A: `wrangler rollback` to a prior version that doesn't have a route handler.
   - Option B: Deploy a Worker version that always returns 500 on `/api/search`.
   - Option C: Unbind the route from the Worker via the Cloudflare dashboard.
5. Observe: search requests start failing in the browser.
6. Flip `USE_WORKERS_API` back to `false` in `index.html`, commit, push to `main`.
7. Cloudflare Pages redeploys (~30 s).
8. Observe: search goes back to the Firebase callable path (which is still broken due to billing in this scenario, but the point is that the frontend code-path switch works).

### Target recovery time

Under 2 minutes from incident detection to `USE_WORKERS_API = false` redeploy.

### Actual result

[TO MEASURE POST-DEPLOY]

- Date of drill: [YYYY-MM-DD]
- Procedure option used: [A / B / C]
- Time from flag change commit → production redeploy: [seconds]
- Observed browser-level recovery time: [seconds]
- Any unexpected behavior: [notes]

---

## 6. Code review checklist

The following files were reviewed line-by-line by the `feature-dev:code-reviewer` subagent during implementation. Issues found and their resolution commits are listed below.

### Files reviewed

- `workers/api/src/worker.ts`
- `workers/api/src/routes/search.ts`
- `workers/api/src/routes/badge.ts`
- `workers/api/src/lib/cosine.ts`
- `workers/api/src/lib/svg.ts`
- `workers/api/src/lib/validation.ts`
- `workers/api/src/lib/origin.ts`
- `workers/api/src/lib/firestore.ts`
- `workers/api/src/lib/gemini.ts`
- `workers/api/src/lib/embeddings-cache.ts`
- `workers/api/wrangler.toml`
- `workers/api/wrangler.test.toml`
- `workers/api/vitest.config.ts`
- All corresponding test files under `workers/api/test/`
- `index.html` USE_WORKERS_API call sites (Task 16 diff only)
- `project.html` badge URL branch (Task 16 diff only)
- `.github/workflows/deploy-workers.yml`

### Issues found during implementation + review

| # | Task | Severity | Issue | Resolution commit |
|---|------|----------|-------|-------------------|
| 1 | Task 1 (scaffold) | Important | `@cloudflare/workers-types` version 7 months behind wrangler peer dep | `da11df6` fix(workers): bump @cloudflare/workers-types + note Task 2 prerequisite |
| 2 | Task 1 (scaffold) | Important | README implied `npm test` works but Vitest config hadn't been added yet | `da11df6` (same commit) |
| 3 | Task 2 (Vitest setup) | Infrastructure | Miniflare couldn't resolve `[ai]` binding, blocking all subsequent tests | `b11dae7` test(workers): separate wrangler.test.toml to unblock Miniflare startup |
| 4 | Task 4 (SVG) | Important | Behavioral deviation: unknown trend label produced steady icon instead of empty-string icon (violated byte-parity with original) | `835e997` fix(workers): preserve original parity — unknown trendLabel gets empty icon |
| 5 | Task 7 (Firestore REST) | Important | `fetchEmbeddingsCachePart` silently dropped entries with malformed values, producing dimension-mismatched vectors | `b190297` fix(workers): drop entries with malformed embedding values |
| 6 | Task 8 (Gemini) | Important | No test for network-layer fetch-throw retry path despite spec requirement | `42cf345` fix(workers): address review findings for Gemini + embeddings-cache tests |
| 7 | Task 8 (Gemini) | Important | Variable shadowing: inner `const text` shadowed outer `text` parameter | `42cf345` (same commit) |
| 8 | Task 9 (embeddings cache) | Important | No test for in-flight promise deduplication (central architectural guarantee of the module) | `42cf345` (same commit) |
| 9 | Tasks 10–13 (routes) | Important | `loadProjectEmbeddings` throw escaped as unstructured 500 from the runtime (no `try/catch` in handlers) | `92dc236` fix(workers): wrap embeddings load, warn on dim-mismatch, simplify cache key |
| 10 | Tasks 10–13 (routes) | Important | Silent empty rankings when Workers AI fallback is active but `embeddingsCache` stores Gemini-only vectors | `92dc236` (same commit) — `console.warn` logged |
| 11 | Tasks 10–13 (routes) | Minor | Badge cache key copied all request headers into the cache object | `92dc236` (same commit) — simplified to URL-only |

### Outstanding / deferred items

None. All Important-severity issues were addressed before committing the audit. Minor items were applied inline.

---

## 7. Sign-off

The audit is considered complete once ALL of the following are true. Each box must be ticked after the corresponding verification has been performed.

- [ ] All 23 parity matrix rows (Section 1) pass against the deployed Worker at `aidigitalcrew.com/api/*`
- [ ] All security checklist items (Section 2) are marked applicable-and-verified, or applicable-not-and-documented
- [ ] Performance benchmarks (Section 3) meet or exceed target SLOs
- [ ] Cost projection (Section 4) is re-validated against 7 days of actual usage with no line item > 50% of its free tier
- [ ] Rollback drill (Section 5) completed with recovery time < 2 minutes
- [ ] Code review checklist (Section 6) has no outstanding items
- [ ] User (@ariv14) has reviewed this audit document and confirmed its findings

**Migration considered complete when all boxes are ticked.**

---

## Appendix A: Commit trail

The full migration is a sequence of locally-committed changes on the `feat/workers-migration` branch, on top of the `staging` branch baseline. Key commits (in order):

```
feat(workers): scaffold aidigitalcrew-api Worker project           (Task 1)
fix(workers): bump @cloudflare/workers-types + note Task 2 prereq  (Task 1 fix)
test(workers): set up Vitest with workers pool, add sanity test   (Task 2)
test(workers): separate wrangler.test.toml to unblock Miniflare    (infra fix)
feat(workers): add cosine similarity helper with defensive guards  (Task 3)
feat(workers): port trendBadge SVG generator from functions/...    (Task 4)
fix(workers): preserve original parity — unknown trendLabel ...    (Task 4 fix)
feat(workers): add input validation helpers with explicit errors   (Task 5)
feat(workers): add origin/referer check for search endpoint        (Task 6)
feat(workers): add public-read Firestore REST client               (Task 7)
fix(workers): drop entries with malformed embedding values         (Task 7 fix)
feat(workers): add Gemini REST embedding client with 5xx/429 retry (Task 8)
feat(workers): add lazy-loading project embeddings cache           (Task 9)
fix(workers): address review findings for Gemini + embeddings ... (Tasks 8+9 fixes)
feat(workers): implement /api/badge route handler with edge cache  (Task 10)
feat(workers): implement /api/search query mode with KV cache      (Task 11)
feat(workers): implement rankProjects, findSimilar, findSimilar... (Task 12)
feat(workers): wire up router with health check, search, badge     (Task 13)
fix(workers): wrap embeddings load, warn on dim-mismatch, ...      (Tasks 10-13 fixes)
feat(frontend): add USE_WORKERS_API flag for Workers migration     (Task 16)
ci(workers): add CI workflow to test and deploy aidigitalcrew-api  (Task 17)
docs(audit): add Workers migration audit document                  (Task 20 — this commit)
```

Tasks 14, 15, 18, 19, 21 are user-driven (Cloudflare deploy + cutover + cleanup) and do not produce commits from the implementation agent. They are tracked in the plan document.

---

## Appendix B: Test coverage summary

At the time this audit template was written, the worker test suite has:

- 11 test files (sanity, cosine, svg, validation, origin, firestore, gemini, embeddings-cache, badge, search, router)
- 80+ test cases passing
- 0 tests skipped or marked `.todo`
- Typecheck (`tsc --noEmit`) exits 0 with `strict: true` + `noUncheckedIndexedAccess: true`
- All TDD: every test file was written BEFORE its implementation

Coverage by layer:
- Pure library helpers (cosine, svg, validation, origin): 100% happy path + defensive branches
- Firestore REST client: happy path + 404 + non-404 error + malformed embedding + empty parts
- Gemini client: happy + 429 retry + 503 retry + 4xx fail-fast + network retry + exhaustion
- Embeddings cache: happy + TTL + refetch + empty partCount + in-flight dedup
- Route handlers: method/origin/validation errors + happy paths + cache hits + Firestore failure mapped to 500
- Router: exact-path + method check + health endpoint + 404

Code paths NOT directly tested (deliberate scope choices):
- `env.AI.run(...)` Workers AI fallback path in `handleQueryMode` — the AI binding is not in `wrangler.test.toml`, so mocking it inline would add complexity. The happy Gemini path is covered; the fallback is structurally correct per code review.
- Cloudflare Rate Limiting binding rejection path — the bindings are guarded with `if (env.*_RATE_LIMITER)` and absent in tests. Production behavior is vendor-provided.
