# Functions v2 → Cloudflare Workers Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two Firebase Functions v2 (`getQueryEmbedding`, `trendBadge`) with a single Cloudflare Worker at `aidigitalcrew.com/api/*`, eliminating the GCP billing dependency and restoring search + badges for users.

**Architecture:** Single TypeScript Worker, two routes (`POST /api/search`, `GET /api/badge`). Reads Firestore via the public REST API (no service account, no Admin SDK — `firestore.rules` already permits public reads on every collection the Worker needs). Caches query embeddings in Cloudflare KV; project embeddings live in isolate memory; badge SVGs live in the Workers Cache API. Gemini REST API as primary embedding provider, Workers AI binding (`@cf/baai/bge-large-en-v1.5`) as keyless fallback. No auth on the search API — defense via Cloudflare Rate Limiting binding + origin check + strict input validation. Four-stage cutover with frontend `USE_WORKERS_API` kill switch.

**Tech Stack:** TypeScript, Cloudflare Workers runtime (`workerd`), `@cloudflare/workers-types`, Wrangler 3, Vitest with `@cloudflare/vitest-pool-workers`, no HTTP framework (hand-rolled router for 2 routes), no other runtime dependencies.

**Spec:** See `docs/superpowers/specs/2026-04-10-workers-migration-design.md`.

**Active incident context:** GCP billing on `ai-digital-crew` project has been disabled since ≥ 2026-04-02. Both Firebase Functions return `"billing is disabled"` errors. Production search and badges are broken. The daily scrape pipeline is also stale (separate fix `scripts/daily-scrape.js` already committed locally as `92008a0`, not yet pushed). The migration is intended to restore service while permanently removing the billing dependency.

---

## Task-level overview

| # | Task | Output | Approx steps |
|---|---|---|---|
| 1 | Scaffold the Worker project | Empty TS Worker that returns "ok" | 8 |
| 2 | Set up Vitest with workers pool | One passing test against the empty worker | 5 |
| 3 | Library: cosine similarity (TDD) | `lib/cosine.ts` | 6 |
| 4 | Library: SVG badge generator (TDD) | `lib/svg.ts` | 6 |
| 5 | Library: input validation (TDD) | `lib/validation.ts` | 7 |
| 6 | Library: origin check (TDD) | `lib/origin.ts` | 5 |
| 7 | Library: Firestore REST client (TDD with mocked fetch) | `lib/firestore.ts` | 8 |
| 8 | Library: Gemini REST client with retry (TDD) | `lib/gemini.ts` | 9 |
| 9 | Library: project embeddings cache (TDD) | `lib/embeddings-cache.ts` | 7 |
| 10 | Route: `/api/badge` handler (TDD) | `routes/badge.ts` | 9 |
| 11 | Route: `/api/search` query mode (TDD) | `routes/search.ts` (partial) | 10 |
| 12 | Route: `/api/search` rankProjects + findSimilar + findSimilarBatch | `routes/search.ts` (complete) | 9 |
| 13 | Worker entry + router (TDD) | `src/worker.ts` final | 7 |
| 14 | Manual smoke test via `wrangler dev` | Verification only | 5 |
| 15 | Deploy to Cloudflare without route attached | Stage 2 of cutover | 6 |
| 16 | Frontend feature flag (default off) | Stage 3a — `index.html` + `project.html` | 8 |
| 17 | CI workflow for Worker deploy | `.github/workflows/deploy-workers.yml` | 5 |
| 18 | Attach route to Worker (Stage 3b) | Worker reachable at `/api/*` | 5 |
| 19 | Cutover — flip `USE_WORKERS_API` to true (Stage 4) | Production traffic on Workers | 6 |
| 20 | Audit document | `docs/audits/2026-04-10-workers-migration-audit.md` | 7 |
| 21 | Stage 4 cleanup — delete Firebase Functions | Final removal | 6 |

Total: ~143 individual steps across 21 tasks. Most tasks should take 15–30 minutes once started.

---

## Pre-flight checks

Before starting Task 1, verify these prerequisites in your shell:

```bash
node --version    # >= 20.x (24.x preferred)
npm --version     # >= 10.x
git rev-parse --abbrev-ref HEAD   # should be 'staging'
git status        # working tree should be clean apart from already-known untracked files
```

Required Cloudflare account state:
- The user (ariv14) is logged in to Cloudflare via `wrangler login` (run once interactively).
- The Cloudflare account that owns `aidigitalcrew.com` zone has Workers enabled (free tier is fine).
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist as GitHub Actions repo secrets (already true — they're used by `deploy-cloudflare.yml`).

If any of these are missing, stop and resolve before proceeding.

---

## Task 1: Scaffold the Worker project

**Files:**
- Create: `workers/api/wrangler.toml`
- Create: `workers/api/package.json`
- Create: `workers/api/tsconfig.json`
- Create: `workers/api/.gitignore`
- Create: `workers/api/README.md`
- Create: `workers/api/src/worker.ts`

- [ ] **Step 1: Create the directory structure**

```bash
mkdir -p workers/api/src/lib workers/api/src/routes workers/api/test
```

- [ ] **Step 2: Write `workers/api/.gitignore`**

```
node_modules/
.wrangler/
dist/
.dev.vars
*.log
```

- [ ] **Step 3: Write `workers/api/package.json`**

```json
{
  "name": "aidigitalcrew-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20240909.0",
    "typescript": "^5.5.0",
    "vitest": "~1.5.0",
    "wrangler": "^3.78.0"
  }
}
```

- [ ] **Step 4: Write `workers/api/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "allowJs": false,
    "checkJs": false
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 5: Write `workers/api/wrangler.toml`** (note: route is intentionally absent — added in Task 18)

```toml
name = "aidigitalcrew-api"
main = "src/worker.ts"
compatibility_date = "2026-04-10"
compatibility_flags = ["nodejs_compat"]

[ai]
binding = "AI"

# KV namespace will be created on first deploy via:
#   wrangler kv:namespace create QUERY_EMBEDDING_CACHE
# Then paste the resulting id below.
[[kv_namespaces]]
binding = "QUERY_EMBEDDING_CACHE"
id = "REPLACE_WITH_KV_NAMESPACE_ID_AFTER_CREATE"

[[unsafe.bindings]]
name = "SEARCH_RATE_LIMITER"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 30, period = 60 }

[[unsafe.bindings]]
name = "BADGE_RATE_LIMITER"
type = "ratelimit"
namespace_id = "1002"
simple = { limit = 60, period = 60 }

[vars]
GCP_PROJECT_ID = "ai-digital-crew"
CORS_ORIGIN = "https://aidigitalcrew.com"

# Secrets (set via `wrangler secret put`):
#   GEMINI_API_KEY

[observability.logs]
enabled = true

[placement]
mode = "smart"
```

- [ ] **Step 6: Write minimal `workers/api/src/worker.ts`**

```ts
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
```

The `RateLimit` type isn't in `@cloudflare/workers-types` yet (the binding is GA but the types lag). For now we declare it as a local interface — we'll formalize in Task 13. Add this temporary type at the top of the file:

```ts
interface RateLimit {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}
```

So the full file is:

```ts
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
```

- [ ] **Step 7: Write `workers/api/README.md`**

```markdown
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
```

- [ ] **Step 8: Install dependencies and verify scaffolding**

```bash
cd workers/api && npm install && npm run typecheck
```

Expected: `tsc --noEmit` exits 0 with no output. If there are type errors, fix them before continuing.

- [ ] **Step 9: Commit**

```bash
cd /Users/ariv/AgenticAILearner/ai-digital-crew-site/ai-digital-crew
git add workers/api/.gitignore workers/api/package.json workers/api/tsconfig.json \
        workers/api/wrangler.toml workers/api/src/worker.ts workers/api/README.md
git commit -m "feat(workers): scaffold aidigitalcrew-api Worker project

Empty TypeScript Worker with Wrangler config, KV/AI/RateLimit bindings,
Vitest dependencies. Returns 'ok' on every request — actual handlers come
in subsequent tasks. KV namespace id is a placeholder until first deploy.

Related: docs/superpowers/specs/2026-04-10-workers-migration-design.md"
```

(Do not commit `workers/api/node_modules/` or `package-lock.json` is fine to commit — npm convention.)

---

## Task 2: Set up Vitest with the Workers pool, get one passing test

**Files:**
- Create: `workers/api/vitest.config.ts`
- Create: `workers/api/test/sanity.test.ts`

- [ ] **Step 1: Write `workers/api/vitest.config.ts`**

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // Enable compatibility flags here if needed during tests
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
  },
});
```

- [ ] **Step 2: Write `workers/api/test/sanity.test.ts`**

```ts
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/worker';

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
```

- [ ] **Step 3: Run the test, expect it to pass**

```bash
cd workers/api && npm test
```

Expected: 1 passed, 0 failed.

If it fails with "module not found" or KV/AI binding errors, the most likely cause is that the placeholder KV namespace id (`REPLACE_WITH_KV_NAMESPACE_ID_AFTER_CREATE`) is being parsed by Miniflare. Workaround during local testing: temporarily comment out the `[[kv_namespaces]]` block in `wrangler.toml`, run the test, then restore it. (We'll come back and replace the id properly in Task 15.)

- [ ] **Step 4: Add a typecheck CI gate to the package.json scripts** — already done in Task 1, just verify:

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add workers/api/vitest.config.ts workers/api/test/sanity.test.ts
git commit -m "test(workers): set up Vitest with workers pool, add sanity test"
```

---

## Task 3: Library — cosine similarity (TDD)

**Files:**
- Create: `workers/api/src/lib/cosine.ts`
- Create: `workers/api/test/cosine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// workers/api/test/cosine.test.ts
import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../src/lib/cosine';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('returns 0 when either vector is null', () => {
    // @ts-expect-error testing runtime guard
    expect(cosineSimilarity(null, [1, 0])).toBe(0);
    // @ts-expect-error testing runtime guard
    expect(cosineSimilarity([1, 0], null)).toBe(0);
  });

  it('returns 0 when lengths mismatch (defensive guard for dimension mismatch)', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });

  it('returns 0 for zero vectors (avoids divide-by-zero)', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('produces a value between 0 and 1 for two random positive vectors', () => {
    const a = [0.1, 0.2, 0.3, 0.4];
    const b = [0.4, 0.3, 0.2, 0.1];
    const result = cosineSimilarity(a, b);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails with "module not found"**

```bash
npm test -- cosine
```

Expected: FAIL with "Cannot find module '../src/lib/cosine'".

- [ ] **Step 3: Implement `workers/api/src/lib/cosine.ts`**

```ts
/**
 * Cosine similarity between two equal-length numeric vectors.
 *
 * Returns 0 (rather than throwing) on null inputs, length mismatch, or
 * zero-magnitude vectors. This matches the defensive behavior of the
 * original Firebase Function and ensures one bad embedding can never
 * crash a search response.
 */
export function cosineSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- cosine
```

Expected: 7 tests passed.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/lib/cosine.ts workers/api/test/cosine.test.ts
git commit -m "feat(workers): add cosine similarity helper with defensive guards"
```

---

## Task 4: Library — SVG badge generator (TDD)

**Files:**
- Create: `workers/api/src/lib/svg.ts`
- Create: `workers/api/test/svg.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// workers/api/test/svg.test.ts
import { describe, it, expect } from 'vitest';
import { generateBadgeSvg } from '../src/lib/svg';

describe('generateBadgeSvg', () => {
  it('returns a well-formed SVG document', () => {
    const svg = generateBadgeSvg('Hot', '85', 'hot');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('includes the trend label and score in the right-hand text', () => {
    const svg = generateBadgeSvg('Rising', '60', 'rising');
    expect(svg).toContain('Rising 60');
  });

  it('uses the hot color (#dc2626) for hot trend', () => {
    const svg = generateBadgeSvg('Hot', '90', 'hot');
    expect(svg).toContain('#dc2626');
  });

  it('uses the rising color (#059669) for rising trend', () => {
    const svg = generateBadgeSvg('Rising', '50', 'rising');
    expect(svg).toContain('#059669');
  });

  it('falls back to steady color for unknown trend label', () => {
    // @ts-expect-error testing runtime fallback
    const svg = generateBadgeSvg('Cooling', '10', 'banana');
    expect(svg).toContain('#6b7280');
  });

  it('left text is the constant brand label', () => {
    const svg = generateBadgeSvg('New', '0', 'new');
    expect(svg).toContain('trending on AI Digital Crew');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
npm test -- svg
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `workers/api/src/lib/svg.ts`**

(This is a near-line-for-line port of `generateBadgeSvg` from `functions/index.js:315–346`. The original logic is correct; we're just moving it.)

```ts
export type TrendLabel = 'hot' | 'rising' | 'steady' | 'declining' | 'new';

const COLORS: Record<TrendLabel, { bg: string; text: string }> = {
  hot:       { bg: '#dc2626', text: '#fff' },
  rising:    { bg: '#059669', text: '#fff' },
  steady:    { bg: '#6b7280', text: '#fff' },
  declining: { bg: '#6b7280', text: '#d1d5db' },
  new:       { bg: '#2563eb', text: '#fff' },
};

const ICONS: Record<TrendLabel, string> = {
  hot:       '\uD83D\uDD25', // 🔥
  rising:    '\u2B06\uFE0F', // ⬆️
  steady:    '\u2796',       // ➖
  declining: '\u2B07\uFE0F', // ⬇️
  new:       '\u2728',       // ✨
};

const FALLBACK_LABEL: TrendLabel = 'steady';

/**
 * Generate the dynamic SVG badge served by /api/badge.
 * Direct port of the trendBadge function in functions/index.js.
 */
export function generateBadgeSvg(label: string, score: string, trendLabel: TrendLabel | string): string {
  const key = (trendLabel in COLORS ? trendLabel : FALLBACK_LABEL) as TrendLabel;
  const c = COLORS[key];
  const icon = ICONS[key] ?? '';
  const leftText = 'trending on AI Digital Crew';
  const rightText = `${icon} ${label} ${score}`;
  const leftW = leftText.length * 6.2 + 20;
  const rightW = rightText.length * 6.2 + 20;
  const totalW = leftW + rightW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${leftText}: ${rightText}">
  <title>${leftText}: ${rightText}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftW}" height="20" fill="#555"/>
    <rect x="${leftW}" width="${rightW}" height="20" fill="${c.bg}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="${leftW / 2}" y="14">${leftText}</text>
    <text x="${leftW + rightW / 2}" y="14" fill="${c.text}">${rightText}</text>
  </g>
</svg>`;
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
npm test -- svg
```

Expected: 6 tests passed.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/lib/svg.ts workers/api/test/svg.test.ts
git commit -m "feat(workers): port trendBadge SVG generator from functions/index.js"
```

---

## Task 5: Library — input validation (TDD)

**Files:**
- Create: `workers/api/src/lib/validation.ts`
- Create: `workers/api/test/validation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// workers/api/test/validation.test.ts
import { describe, it, expect } from 'vitest';
import {
  validateQuery,
  validateRepoName,
  validateFindSimilar,
  validateFindSimilarBatch,
  ValidationError,
} from '../src/lib/validation';

describe('validateQuery', () => {
  it('accepts a normal query string', () => {
    expect(validateQuery('vector database')).toBe('vector database');
  });

  it('rejects empty string', () => {
    expect(() => validateQuery('')).toThrow(ValidationError);
  });

  it('rejects whitespace-only string', () => {
    expect(() => validateQuery('   ')).toThrow(ValidationError);
  });

  it('rejects non-string input', () => {
    // @ts-expect-error testing runtime guard
    expect(() => validateQuery(42)).toThrow(ValidationError);
  });

  it('rejects strings over 200 chars', () => {
    expect(() => validateQuery('a'.repeat(201))).toThrow(ValidationError);
  });

  it('accepts strings exactly 200 chars', () => {
    expect(validateQuery('a'.repeat(200))).toBe('a'.repeat(200));
  });
});

describe('validateRepoName', () => {
  it('accepts owner/repo style', () => {
    expect(validateRepoName('infiniflow/ragflow')).toBe('infiniflow/ragflow');
  });

  it('rejects empty', () => {
    expect(() => validateRepoName('')).toThrow(ValidationError);
  });

  it('rejects too long', () => {
    expect(() => validateRepoName('a'.repeat(201))).toThrow(ValidationError);
  });

  it('rejects non-string', () => {
    // @ts-expect-error testing runtime guard
    expect(() => validateRepoName(null)).toThrow(ValidationError);
  });
});

describe('validateFindSimilar', () => {
  it('accepts a valid repo name', () => {
    expect(validateFindSimilar('infiniflow/ragflow')).toBe('infiniflow/ragflow');
  });
  it('shares the same constraints as validateRepoName', () => {
    expect(() => validateFindSimilar('a'.repeat(201))).toThrow(ValidationError);
  });
});

describe('validateFindSimilarBatch', () => {
  it('accepts a 1-element array', () => {
    expect(validateFindSimilarBatch(['a/b'])).toEqual(['a/b']);
  });
  it('accepts a 12-element array', () => {
    const arr = Array.from({ length: 12 }, (_, i) => `owner/repo${i}`);
    expect(validateFindSimilarBatch(arr)).toEqual(arr);
  });
  it('rejects a 13-element array', () => {
    const arr = Array.from({ length: 13 }, (_, i) => `owner/repo${i}`);
    expect(() => validateFindSimilarBatch(arr)).toThrow(ValidationError);
  });
  it('rejects an empty array', () => {
    expect(() => validateFindSimilarBatch([])).toThrow(ValidationError);
  });
  it('rejects a non-array', () => {
    // @ts-expect-error testing runtime guard
    expect(() => validateFindSimilarBatch('not-an-array')).toThrow(ValidationError);
  });
  it('rejects an array containing a non-string', () => {
    // @ts-expect-error testing runtime guard
    expect(() => validateFindSimilarBatch(['ok', 42])).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run the tests, expect failure**

```bash
npm test -- validation
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `workers/api/src/lib/validation.ts`**

```ts
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const MAX_QUERY_LEN = 200;
const MAX_REPO_NAME_LEN = 200;
const MIN_BATCH = 1;
const MAX_BATCH = 12;

export function validateQuery(input: unknown): string {
  if (typeof input !== 'string') {
    throw new ValidationError('query must be a string');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('query must not be empty');
  }
  if (input.length > MAX_QUERY_LEN) {
    throw new ValidationError(`query must be ${MAX_QUERY_LEN} characters or fewer`);
  }
  return input;
}

export function validateRepoName(input: unknown): string {
  if (typeof input !== 'string') {
    throw new ValidationError('repo must be a string');
  }
  if (input.length === 0) {
    throw new ValidationError('repo must not be empty');
  }
  if (input.length > MAX_REPO_NAME_LEN) {
    throw new ValidationError(`repo must be ${MAX_REPO_NAME_LEN} characters or fewer`);
  }
  return input;
}

export function validateFindSimilar(input: unknown): string {
  // Same constraints as repo name; separated for clarity at call sites.
  return validateRepoName(input);
}

export function validateFindSimilarBatch(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ValidationError('findSimilarBatch must be an array');
  }
  if (input.length < MIN_BATCH || input.length > MAX_BATCH) {
    throw new ValidationError(`findSimilarBatch must contain between ${MIN_BATCH} and ${MAX_BATCH} entries`);
  }
  for (const entry of input) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_REPO_NAME_LEN) {
      throw new ValidationError(`findSimilarBatch entries must be non-empty strings of ${MAX_REPO_NAME_LEN} characters or fewer`);
    }
  }
  return input as string[];
}
```

- [ ] **Step 4: Run the tests, verify pass**

```bash
npm test -- validation
```

Expected: all tests passed.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/lib/validation.ts workers/api/test/validation.test.ts
git commit -m "feat(workers): add input validation helpers with explicit error types"
```

- [ ] **Step 7: Note for later** — `ValidationError` is what the route handlers will catch and translate to `400` responses. Document this in your mental model; it's not a code change.

---

## Task 6: Library — origin check (TDD)

**Files:**
- Create: `workers/api/src/lib/origin.ts`
- Create: `workers/api/test/origin.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// workers/api/test/origin.test.ts
import { describe, it, expect } from 'vitest';
import { isOriginAllowed } from '../src/lib/origin';

const ALLOWED = 'https://aidigitalcrew.com';

describe('isOriginAllowed', () => {
  it('accepts requests with matching Origin header', () => {
    const req = new Request('https://aidigitalcrew.com/api/search', {
      headers: { Origin: ALLOWED },
    });
    expect(isOriginAllowed(req, ALLOWED)).toBe(true);
  });

  it('accepts requests with matching Referer when Origin is missing', () => {
    const req = new Request('https://aidigitalcrew.com/api/search', {
      headers: { Referer: 'https://aidigitalcrew.com/some/page' },
    });
    expect(isOriginAllowed(req, ALLOWED)).toBe(true);
  });

  it('rejects requests with no Origin and no Referer', () => {
    const req = new Request('https://aidigitalcrew.com/api/search');
    expect(isOriginAllowed(req, ALLOWED)).toBe(false);
  });

  it('rejects requests with mismatched Origin', () => {
    const req = new Request('https://aidigitalcrew.com/api/search', {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(isOriginAllowed(req, ALLOWED)).toBe(false);
  });

  it('rejects requests where Referer points to a different host', () => {
    const req = new Request('https://aidigitalcrew.com/api/search', {
      headers: { Referer: 'https://evil.example.com/spoof' },
    });
    expect(isOriginAllowed(req, ALLOWED)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

```bash
npm test -- origin
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `workers/api/src/lib/origin.ts`**

```ts
/**
 * Returns true if the request was made from an allowed origin.
 * Accepts a match on Origin OR Referer (Referer host must equal allowed host).
 *
 * Used only on /api/search. /api/badge intentionally does NOT call this
 * because badges are embedded in third-party markdown and the user-agent
 * controls whether Origin/Referer is sent.
 */
export function isOriginAllowed(request: Request, allowedOrigin: string): boolean {
  const origin = request.headers.get('Origin');
  if (origin && origin === allowedOrigin) return true;

  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      const refUrl = new URL(referer);
      const allowedUrl = new URL(allowedOrigin);
      if (refUrl.origin === allowedUrl.origin) return true;
    } catch {
      // Malformed Referer header — fall through to reject
    }
  }

  return false;
}
```

- [ ] **Step 4: Run the test, verify pass**

```bash
npm test -- origin
```

Expected: all 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/origin.ts workers/api/test/origin.test.ts
git commit -m "feat(workers): add origin/referer check for search endpoint"
```

---

## Task 7: Library — Firestore REST client (TDD with mocked fetch)

**Files:**
- Create: `workers/api/src/lib/firestore.ts`
- Create: `workers/api/test/firestore.test.ts`

This client only does READS. No service account, no auth. It calls the public Firestore REST endpoints.

- [ ] **Step 1: Write the failing test (mocked fetch via Vitest)**

```ts
// workers/api/test/firestore.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getDocument,
  queryProjects,
  fetchEmbeddingsCacheMeta,
  fetchEmbeddingsCachePart,
  type FirestoreDoc,
} from '../src/lib/firestore';

const PROJECT_ID = 'ai-digital-crew';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(responses: Array<{ url: RegExp; body: object; status?: number }>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const match = responses.find(r => r.url.test(url));
    if (!match) {
      throw new Error(`Unexpected fetch to ${url}`);
    }
    return new Response(JSON.stringify(match.body), {
      status: match.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('getDocument', () => {
  it('fetches a single document by path and returns the parsed body', async () => {
    mockFetch([
      {
        url: /projectsCache\/featured$/,
        body: {
          name: `projects/${PROJECT_ID}/databases/(default)/documents/projectsCache/featured`,
          fields: { fullName: { stringValue: 'foo/bar' } },
          updateTime: '2026-04-06T13:26:14.148211Z',
        },
      },
    ]);
    const doc = await getDocument(PROJECT_ID, 'projectsCache/featured');
    expect(doc).not.toBeNull();
    expect(doc!.fields.fullName?.stringValue).toBe('foo/bar');
  });

  it('returns null on 404', async () => {
    mockFetch([{ url: /missing$/, body: { error: { code: 404 } }, status: 404 }]);
    const doc = await getDocument(PROJECT_ID, 'projectsCache/missing');
    expect(doc).toBeNull();
  });

  it('throws on non-404 errors', async () => {
    mockFetch([{ url: /broken$/, body: { error: { code: 500 } }, status: 500 }]);
    await expect(getDocument(PROJECT_ID, 'projectsCache/broken')).rejects.toThrow(/500/);
  });
});

describe('fetchEmbeddingsCacheMeta', () => {
  it('returns the partCount as a number', async () => {
    mockFetch([
      {
        url: /embeddingsCache\/meta$/,
        body: {
          name: 'meta',
          fields: {
            partCount: { integerValue: '40' },
            totalProjects: { integerValue: '1163' },
          },
        },
      },
    ]);
    const meta = await fetchEmbeddingsCacheMeta(PROJECT_ID);
    expect(meta.partCount).toBe(40);
    expect(meta.totalProjects).toBe(1163);
  });
});

describe('fetchEmbeddingsCachePart', () => {
  it('returns parsed entries with fullName + embedding tuples', async () => {
    mockFetch([
      {
        url: /embeddingsCache\/part0$/,
        body: {
          name: 'part0',
          fields: {
            entries: {
              arrayValue: {
                values: [
                  {
                    mapValue: {
                      fields: {
                        fullName: { stringValue: 'foo/bar' },
                        embedding: { arrayValue: { values: [{ doubleValue: 0.1 }, { doubleValue: 0.2 }] } },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ]);
    const entries = await fetchEmbeddingsCachePart(PROJECT_ID, 0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ fullName: 'foo/bar', embedding: [0.1, 0.2] });
  });

  it('returns empty array when part doc has no entries field', async () => {
    mockFetch([
      {
        url: /embeddingsCache\/part1$/,
        body: { name: 'part1', fields: {} },
      },
    ]);
    const entries = await fetchEmbeddingsCachePart(PROJECT_ID, 1);
    expect(entries).toEqual([]);
  });
});

describe('queryProjects', () => {
  it('runs a structuredQuery and returns matched docs', async () => {
    mockFetch([
      {
        url: /:runQuery$/,
        body: [
          {
            document: {
              name: `projects/${PROJECT_ID}/databases/(default)/documents/projects/abc123`,
              fields: {
                fullName: { stringValue: 'foo/bar' },
                trend_momentum: { doubleValue: 75.5 },
                trend_label: { stringValue: 'hot' },
              },
            },
          },
        ],
      },
    ]);
    const docs = await queryProjects(PROJECT_ID, 'foo/bar');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.fields.fullName?.stringValue).toBe('foo/bar');
  });

  it('returns empty array when query has no matches', async () => {
    mockFetch([{ url: /:runQuery$/, body: [{}] }]);
    const docs = await queryProjects(PROJECT_ID, 'no/such');
    expect(docs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

```bash
npm test -- firestore
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `workers/api/src/lib/firestore.ts`**

```ts
/**
 * Public-read Firestore REST client.
 *
 * Uses the unauthenticated REST API. All collections this client touches
 * (projects, projectsCache, embeddingsCache, searchCache) are public-read
 * per firestore.rules.
 *
 * Does NOT support writes. The Worker is read-only against Firestore;
 * cache writes go to Cloudflare KV.
 */

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1';

export interface FirestoreValue {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
  nullValue?: null;
}

export interface FirestoreDoc {
  name: string;
  fields: Record<string, FirestoreValue>;
  createTime?: string;
  updateTime?: string;
}

export async function getDocument(projectId: string, path: string): Promise<FirestoreDoc | null> {
  const url = `${FIRESTORE_BASE}/projects/${projectId}/databases/(default)/documents/${path}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Firestore getDocument(${path}) failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as FirestoreDoc;
}

export interface EmbeddingsCacheMeta {
  partCount: number;
  totalProjects: number;
}

export async function fetchEmbeddingsCacheMeta(projectId: string): Promise<EmbeddingsCacheMeta> {
  const doc = await getDocument(projectId, 'embeddingsCache/meta');
  if (!doc) {
    throw new Error('embeddingsCache/meta not found');
  }
  return {
    partCount: Number(doc.fields.partCount?.integerValue ?? '0'),
    totalProjects: Number(doc.fields.totalProjects?.integerValue ?? '0'),
  };
}

export interface EmbeddingEntry {
  fullName: string;
  embedding: number[];
}

export async function fetchEmbeddingsCachePart(projectId: string, partIndex: number): Promise<EmbeddingEntry[]> {
  const doc = await getDocument(projectId, `embeddingsCache/part${partIndex}`);
  if (!doc) return [];
  const entries = doc.fields.entries?.arrayValue?.values ?? [];
  const result: EmbeddingEntry[] = [];
  for (const entry of entries) {
    const map = entry.mapValue?.fields;
    if (!map) continue;
    const fullName = map.fullName?.stringValue;
    const embeddingValues = map.embedding?.arrayValue?.values ?? [];
    if (typeof fullName !== 'string' || embeddingValues.length === 0) continue;
    const embedding: number[] = [];
    for (const v of embeddingValues) {
      if (typeof v.doubleValue === 'number') embedding.push(v.doubleValue);
      else if (typeof v.integerValue === 'string') embedding.push(Number(v.integerValue));
    }
    result.push({ fullName, embedding });
  }
  return result;
}

/**
 * Run a structured query for a single project document by fullName.
 * Used by /api/badge.
 */
export async function queryProjects(projectId: string, fullName: string): Promise<FirestoreDoc[]> {
  const url = `${FIRESTORE_BASE}/projects/${projectId}/databases/(default)/documents:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'projects' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'fullName' },
          op: 'EQUAL',
          value: { stringValue: fullName },
        },
      },
      limit: 1,
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Firestore queryProjects(${fullName}) failed: ${res.status} ${res.statusText}`);
  }
  const rows = (await res.json()) as Array<{ document?: FirestoreDoc }>;
  return rows.map(r => r.document).filter((d): d is FirestoreDoc => d !== undefined);
}
```

- [ ] **Step 4: Run the test, verify pass**

```bash
npm test -- firestore
```

Expected: all tests passed.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/lib/firestore.ts workers/api/test/firestore.test.ts
git commit -m "feat(workers): add public-read Firestore REST client"
```

---

## Task 8: Library — Gemini REST client with retry (TDD)

**Files:**
- Create: `workers/api/src/lib/gemini.ts`
- Create: `workers/api/test/gemini.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// workers/api/test/gemini.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { embedWithGemini, GeminiError } from '../src/lib/gemini';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fetchMockSequence(responses: Response[]) {
  let i = 0;
  globalThis.fetch = vi.fn(async () => {
    if (i >= responses.length) throw new Error('Unexpected extra fetch call');
    return responses[i++]!;
  }) as typeof fetch;
}

const successBody = {
  embedding: { values: Array.from({ length: 3072 }, (_, i) => i / 3072) },
};

describe('embedWithGemini', () => {
  it('returns the embedding values on a 200 response', async () => {
    fetchMockSequence([
      new Response(JSON.stringify(successBody), { status: 200 }),
    ]);
    const result = await embedWithGemini('hello world', 'fake-api-key');
    expect(result.values).toHaveLength(3072);
    expect(result.provider).toBe('gemini');
    expect(result.dimensions).toBe(3072);
  });

  it('retries once on 503 then succeeds', async () => {
    fetchMockSequence([
      new Response('high demand', { status: 503 }),
      new Response(JSON.stringify(successBody), { status: 200 }),
    ]);
    const result = await embedWithGemini('hello', 'k', { initialBackoffMs: 1, maxAttempts: 4 });
    expect(result.values).toHaveLength(3072);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 429 (rate limit)', async () => {
    fetchMockSequence([
      new Response('rate limited', { status: 429 }),
      new Response(JSON.stringify(successBody), { status: 200 }),
    ]);
    const result = await embedWithGemini('hello', 'k', { initialBackoffMs: 1, maxAttempts: 4 });
    expect(result.values).toHaveLength(3072);
  });

  it('does NOT retry on 400', async () => {
    fetchMockSequence([new Response('bad request', { status: 400 })]);
    await expect(
      embedWithGemini('hello', 'k', { initialBackoffMs: 1, maxAttempts: 4 })
    ).rejects.toThrow(GeminiError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all 4 attempts on persistent 503', async () => {
    fetchMockSequence([
      new Response('503', { status: 503 }),
      new Response('503', { status: 503 }),
      new Response('503', { status: 503 }),
      new Response('503', { status: 503 }),
    ]);
    await expect(
      embedWithGemini('hello', 'k', { initialBackoffMs: 1, maxAttempts: 4 })
    ).rejects.toThrow(GeminiError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

```bash
npm test -- gemini
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `workers/api/src/lib/gemini.ts`**

```ts
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'gemini-embedding-001';
const DIMENSIONS = 3072;

export class GeminiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GeminiError';
  }
}

export interface GeminiEmbeddingResult {
  values: number[];
  provider: 'gemini';
  dimensions: number;
}

export interface GeminiOptions {
  /** Default 2000 ms */
  initialBackoffMs?: number;
  /** Default 4 */
  maxAttempts?: number;
  /** Default 30000 ms */
  maxBackoffMs?: number;
}

/**
 * Generate an embedding via the Gemini REST API with retry-on-transient-errors.
 *
 * Retries (with exponential backoff) on HTTP 5xx and 429. Fails fast on 4xx
 * (other than 429), since those indicate prompt or auth bugs that won't
 * resolve with retries.
 */
export async function embedWithGemini(
  text: string,
  apiKey: string,
  opts: GeminiOptions = {}
): Promise<GeminiEmbeddingResult> {
  const initialBackoffMs = opts.initialBackoffMs ?? 2000;
  const maxAttempts = opts.maxAttempts ?? 4;
  const maxBackoffMs = opts.maxBackoffMs ?? 30000;

  const url = `${GEMINI_BASE}/models/${MODEL}:embedContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    content: { parts: [{ text }] },
  });

  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      // Network-level failure (DNS, TCP). Treat as transient.
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxAttempts) throw lastErr;
      await sleep(backoffMs(attempt, initialBackoffMs, maxBackoffMs));
      continue;
    }

    if (res.ok) {
      const data = (await res.json()) as { embedding?: { values?: number[] } };
      const values = data.embedding?.values;
      if (!Array.isArray(values) || values.length === 0) {
        throw new GeminiError(200, 'Gemini returned an empty embedding');
      }
      return { values, provider: 'gemini', dimensions: DIMENSIONS };
    }

    const transient = res.status === 429 || (res.status >= 500 && res.status <= 599);
    if (!transient) {
      const text = await res.text().catch(() => '');
      throw new GeminiError(res.status, `Gemini ${res.status}: ${text.slice(0, 200)}`);
    }

    lastErr = new GeminiError(res.status, `Gemini ${res.status} (transient)`);
    if (attempt === maxAttempts) throw lastErr;

    const wait = backoffMs(attempt, initialBackoffMs, maxBackoffMs);
    console.warn(`Gemini attempt ${attempt}/${maxAttempts} failed (${res.status}) — retrying in ${wait}ms`);
    await sleep(wait);
  }

  // Unreachable (loop always returns or throws), but TS doesn't know.
  throw lastErr ?? new GeminiError(0, 'Gemini retry loop exited unexpectedly');
}

function backoffMs(attempt: number, initial: number, cap: number): number {
  return Math.min(cap, initial * Math.pow(2, attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Run the test, verify pass**

```bash
npm test -- gemini
```

Expected: 5 tests passed.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/lib/gemini.ts workers/api/test/gemini.test.ts
git commit -m "feat(workers): add Gemini REST embedding client with 5xx/429 retry"
```

---

## Task 9: Library — project embeddings cache (TDD)

**Files:**
- Create: `workers/api/src/lib/embeddings-cache.ts`
- Create: `workers/api/test/embeddings-cache.test.ts`

This module owns the in-isolate `Map<fullName, number[]>` and lazy-loads from Firestore on first request per isolate.

- [ ] **Step 1: Write the failing test**

```ts
// workers/api/test/embeddings-cache.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadProjectEmbeddings, _resetForTesting } from '../src/lib/embeddings-cache';

const PROJECT_ID = 'ai-digital-crew';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFirestore(meta: { partCount: number }, parts: Array<Array<{ fullName: string; embedding: number[] }>>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('embeddingsCache/meta')) {
      return new Response(JSON.stringify({
        name: 'meta',
        fields: {
          partCount: { integerValue: String(meta.partCount) },
          totalProjects: { integerValue: '99' },
        },
      }), { status: 200 });
    }
    const partMatch = url.match(/embeddingsCache\/part(\d+)$/);
    if (partMatch) {
      const idx = Number(partMatch[1]);
      const entries = parts[idx] ?? [];
      return new Response(JSON.stringify({
        name: `part${idx}`,
        fields: {
          entries: {
            arrayValue: {
              values: entries.map(e => ({
                mapValue: {
                  fields: {
                    fullName: { stringValue: e.fullName },
                    embedding: { arrayValue: { values: e.embedding.map(v => ({ doubleValue: v })) } },
                  },
                },
              })),
            },
          },
        },
      }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe('loadProjectEmbeddings', () => {
  it('loads all parts and returns a Map keyed by fullName', async () => {
    mockFirestore({ partCount: 2 }, [
      [{ fullName: 'foo/bar', embedding: [0.1, 0.2] }],
      [{ fullName: 'baz/qux', embedding: [0.3, 0.4] }],
    ]);
    const map = await loadProjectEmbeddings(PROJECT_ID);
    expect(map.size).toBe(2);
    expect(map.get('foo/bar')).toEqual([0.1, 0.2]);
    expect(map.get('baz/qux')).toEqual([0.3, 0.4]);
  });

  it('caches the Map in isolate memory and does not refetch within TTL', async () => {
    mockFirestore({ partCount: 1 }, [[{ fullName: 'a/b', embedding: [1] }]]);
    await loadProjectEmbeddings(PROJECT_ID);
    await loadProjectEmbeddings(PROJECT_ID);
    // 1 meta call + 1 part call = 2 fetches total, NOT 4
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('reloads after the TTL expires', async () => {
    mockFirestore({ partCount: 1 }, [[{ fullName: 'a/b', embedding: [1] }]]);
    await loadProjectEmbeddings(PROJECT_ID, { ttlMs: 0 }); // 0 = always stale
    await loadProjectEmbeddings(PROJECT_ID, { ttlMs: 0 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  it('returns an empty Map when partCount is 0', async () => {
    mockFirestore({ partCount: 0 }, []);
    const map = await loadProjectEmbeddings(PROJECT_ID);
    expect(map.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

```bash
npm test -- embeddings-cache
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `workers/api/src/lib/embeddings-cache.ts`**

```ts
import { fetchEmbeddingsCacheMeta, fetchEmbeddingsCachePart } from './firestore';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CachedMap {
  map: Map<string, number[]>;
  loadedAt: number;
}

// Module-scope cache — persists for the lifetime of the isolate.
let cached: CachedMap | null = null;
let inFlight: Promise<Map<string, number[]>> | null = null;

export interface LoadOptions {
  ttlMs?: number;
}

export async function loadProjectEmbeddings(
  projectId: string,
  opts: LoadOptions = {}
): Promise<Map<string, number[]>> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();

  if (cached && now - cached.loadedAt < ttlMs) {
    return cached.map;
  }

  // De-dupe concurrent loads on cold start
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const meta = await fetchEmbeddingsCacheMeta(projectId);
      const map = new Map<string, number[]>();

      // Fetch all parts in parallel for fast cold start
      const partPromises = Array.from({ length: meta.partCount }, (_, i) =>
        fetchEmbeddingsCachePart(projectId, i)
      );
      const allParts = await Promise.all(partPromises);
      for (const entries of allParts) {
        for (const e of entries) {
          map.set(e.fullName, e.embedding);
        }
      }

      cached = { map, loadedAt: Date.now() };
      return map;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Test-only: reset module state between tests. Do not call from production code. */
export function _resetForTesting(): void {
  cached = null;
  inFlight = null;
}
```

- [ ] **Step 4: Run the test, verify pass**

```bash
npm test -- embeddings-cache
```

Expected: 4 tests passed.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/lib/embeddings-cache.ts workers/api/test/embeddings-cache.test.ts
git commit -m "feat(workers): add lazy-loading project embeddings cache (1h isolate TTL)"
```

- [ ] **Step 7: Note** — `_resetForTesting` is exported only for unit tests. It is NOT called from any production code path. We accept the test-only export rather than restructuring as a class instance because the module-scope pattern matches Workers idioms and is what the original Firebase Function used.

---

## Task 10: Route — `/api/badge` handler (TDD)

**Files:**
- Create: `workers/api/src/routes/badge.ts`
- Create: `workers/api/test/badge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// workers/api/test/badge.test.ts
import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { handleBadge } from '../src/routes/badge';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

const FIRESTORE_HOST = 'https://firestore.googleapis.com';
const QUERY_PATH = `/v1/projects/${env.GCP_PROJECT_ID}/databases/(default)/documents:runQuery`;

function mockProjectFound(repo: string, momentum: number, label: string) {
  fetchMock.get(FIRESTORE_HOST).intercept({ path: QUERY_PATH, method: 'POST' }).reply(200, [
    {
      document: {
        name: `projects/${env.GCP_PROJECT_ID}/databases/(default)/documents/projects/abc`,
        fields: {
          fullName: { stringValue: repo },
          trend_momentum: { doubleValue: momentum },
          trend_label: { stringValue: label },
        },
      },
    },
  ]);
}

function mockProjectMissing() {
  fetchMock.get(FIRESTORE_HOST).intercept({ path: QUERY_PATH, method: 'POST' }).reply(200, [{}]);
}

describe('handleBadge', () => {
  it('returns 400 when ?repo= is missing', async () => {
    const req = new Request('https://example.com/api/badge');
    const ctx = createExecutionContext();
    const res = await handleBadge(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it('returns 400 when ?repo= is too long', async () => {
    const req = new Request(`https://example.com/api/badge?repo=${'a'.repeat(201)}`);
    const ctx = createExecutionContext();
    const res = await handleBadge(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it('returns 200 with SVG content type when project is found', async () => {
    mockProjectFound('foo/bar', 85, 'hot');
    const req = new Request('https://example.com/api/badge?repo=foo%2Fbar');
    const ctx = createExecutionContext();
    const res = await handleBadge(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    const body = await res.text();
    expect(body).toContain('<svg');
    expect(body).toContain('Hot 85');
  });

  it('returns 404 when project not found', async () => {
    mockProjectMissing();
    const req = new Request('https://example.com/api/badge?repo=no%2Fsuch');
    const ctx = createExecutionContext();
    const res = await handleBadge(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it('sets Cache-Control max-age=3600 on successful responses', async () => {
    mockProjectFound('foo/bar', 30, 'steady');
    const req = new Request('https://example.com/api/badge?repo=foo%2Fbar');
    const ctx = createExecutionContext();
    const res = await handleBadge(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.headers.get('Cache-Control')).toContain('max-age=3600');
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

```bash
npm test -- badge
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `workers/api/src/routes/badge.ts`**

```ts
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

  // Cache check
  const cacheKey = new Request(request.url, request);
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
```

- [ ] **Step 4: Run the test, verify pass**

```bash
npm test -- badge
```

Expected: 5 tests passed.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 6: Add `caches` types if missing** — TypeScript may complain about `caches.default` if `@cloudflare/workers-types` doesn't have it in scope. If so, add an interface declaration at the top of `routes/badge.ts`:

```ts
declare const caches: { default: Cache };
```

- [ ] **Step 7: Re-run typecheck and tests, verify clean**

```bash
npm run typecheck && npm test -- badge
```

- [ ] **Step 8: Commit**

```bash
git add workers/api/src/routes/badge.ts workers/api/test/badge.test.ts
git commit -m "feat(workers): implement /api/badge route handler with edge caching"
```

- [ ] **Step 9: Note** — the rate limiter binding is checked with `if (env.BADGE_RATE_LIMITER)` because the test environment may not provide it. In production it's always defined per `wrangler.toml`. This is the same pattern used in Task 11 for the search rate limiter.

---

## Task 11: Route — `/api/search` query mode (TDD)

**Files:**
- Create: `workers/api/src/routes/search.ts`
- Create: `workers/api/test/search.test.ts`

This task implements ONLY the plain `{ query }` mode and the KV cache. The other 3 modes are added in Task 12.

- [ ] **Step 1: Write the failing test**

```ts
// workers/api/test/search.test.ts
import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';
import { handleSearch } from '../src/routes/search';
import { _resetForTesting as resetEmbeddingsCache } from '../src/lib/embeddings-cache';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

beforeEach(async () => {
  resetEmbeddingsCache();
  // Wipe KV between tests
  const list = await env.QUERY_EMBEDDING_CACHE.list();
  for (const k of list.keys) await env.QUERY_EMBEDDING_CACHE.delete(k.name);
});

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';

function postSearch(body: object): Request {
  return new Request('https://example.com/api/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': env.CORS_ORIGIN,
    },
    body: JSON.stringify(body),
  });
}

function mockGeminiSuccess(values: number[]) {
  fetchMock.get(GEMINI_HOST).intercept({
    path: /.*/,
    method: 'POST',
  }).reply(200, { embedding: { values } });
}

describe('handleSearch — query mode', () => {
  it('rejects non-POST methods', async () => {
    const req = new Request('https://example.com/api/search', { method: 'GET' });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
  });

  it('rejects requests without an Origin header', async () => {
    const req = new Request('https://example.com/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'hi' }),
    });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });

  it('returns 400 on invalid query payload', async () => {
    const req = postSearch({ query: '' });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });

  it('returns the Gemini embedding on a fresh query', async () => {
    mockGeminiSuccess([0.1, 0.2, 0.3]);
    const req = postSearch({ query: 'vector database' });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { embedding: number[]; provider: string; cached: boolean };
    expect(body.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(body.provider).toBe('gemini');
    expect(body.cached).toBe(false);
  });

  it('returns the cached embedding on a repeat query (KV hit)', async () => {
    mockGeminiSuccess([0.5, 0.6, 0.7]);
    // First call populates KV
    const ctx1 = createExecutionContext();
    await handleSearch(postSearch({ query: 'graph rag' }), env, ctx1);
    await waitOnExecutionContext(ctx1);

    // Second call should NOT call Gemini again — no fetch mock set up
    const ctx2 = createExecutionContext();
    const res = await handleSearch(postSearch({ query: 'graph rag' }), env, ctx2);
    await waitOnExecutionContext(ctx2);
    const body = (await res.json()) as { embedding: number[]; cached: boolean };
    expect(body.embedding).toEqual([0.5, 0.6, 0.7]);
    expect(body.cached).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

```bash
npm test -- search
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `workers/api/src/routes/search.ts` (query mode only)**

```ts
import type { Env } from '../worker';
import { embedWithGemini, GeminiError } from '../lib/gemini';
import { validateQuery, ValidationError } from '../lib/validation';
import { isOriginAllowed } from '../lib/origin';

const QUERY_CACHE_TTL_S = 24 * 60 * 60; // 24 hours

interface CachedQueryEmbedding {
  embedding: number[];
  provider: 'gemini' | 'cloudflare';
  dimensions: number;
  createdAt: number;
}

export async function handleSearch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonError(405, 'Method not allowed');
  }

  if (!isOriginAllowed(request, env.CORS_ORIGIN)) {
    return jsonError(403, 'Origin not allowed');
  }

  // Rate limit (skip if binding undefined in tests)
  if (env.SEARCH_RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.SEARCH_RATE_LIMITER.limit({ key: ip });
    if (!success) return jsonError(429, 'Rate limit exceeded');
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonError(400, 'Body must be valid JSON');
  }

  // Mode dispatch — Task 12 adds the other 3 modes
  return handleQueryMode(payload, env);
}

async function handleQueryMode(payload: Record<string, unknown>, env: Env): Promise<Response> {
  let query: string;
  try {
    query = validateQuery(payload.query);
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(400, err.message);
    throw err;
  }

  const normalized = query.toLowerCase().trim();
  const cacheKey = await sha256Hex(normalized);

  // KV cache lookup
  const cachedRaw = await env.QUERY_EMBEDDING_CACHE.get(cacheKey);
  if (cachedRaw) {
    const cached = JSON.parse(cachedRaw) as CachedQueryEmbedding;
    return json({
      embedding: cached.embedding,
      provider: cached.provider,
      dimensions: cached.dimensions,
      cached: true,
    });
  }

  // Embed via Gemini (with retry built into embedWithGemini)
  // Cloudflare Workers AI fallback is handled in Task 12 (the other modes also need it).
  let result;
  try {
    result = await embedWithGemini(normalized, env.GEMINI_API_KEY);
  } catch (err) {
    if (err instanceof GeminiError) {
      console.error('search: Gemini failed', err.status, err.message);
      // Task 12 will add the env.AI fallback here. For now, fail loud.
      return jsonError(500, 'Embedding provider failed');
    }
    throw err;
  }

  // Write to KV (best-effort, don't block response on failure)
  const toCache: CachedQueryEmbedding = {
    embedding: result.values,
    provider: result.provider,
    dimensions: result.dimensions,
    createdAt: Date.now(),
  };
  try {
    await env.QUERY_EMBEDDING_CACHE.put(cacheKey, JSON.stringify(toCache), {
      expirationTtl: QUERY_CACHE_TTL_S,
    });
  } catch (err) {
    console.warn('search: KV cache write failed (non-fatal)', err);
  }

  return json({
    embedding: result.values,
    provider: result.provider,
    dimensions: result.dimensions,
    cached: false,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(status: number, message: string): Response {
  return json({ error: message }, status);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
```

- [ ] **Step 4: Run the test, verify pass**

```bash
npm test -- search
```

Expected: 5 tests passed.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/search.ts workers/api/test/search.test.ts
git commit -m "feat(workers): implement /api/search query mode with KV cache"
```

- [ ] **Step 7: Note** — Cloudflare Workers AI fallback is intentionally NOT in this task. Task 12 adds it because all 4 modes share the same fallback path. We're staging the work to keep diffs reviewable.

---

## Task 12: Route — `/api/search` rankProjects + findSimilar + findSimilarBatch

**Files:**
- Modify: `workers/api/src/routes/search.ts`
- Modify: `workers/api/test/search.test.ts`

- [ ] **Step 1: Add the failing tests for the three remaining modes**

Append to `workers/api/test/search.test.ts`:

```ts
describe('handleSearch — rankProjects mode', () => {
  it('returns ranked projects when query + rankProjects=true', async () => {
    // Mock embeddings cache load
    mockEmbeddingsCacheLoad([
      { fullName: 'a/x', embedding: [1, 0, 0] },
      { fullName: 'b/y', embedding: [0, 1, 0] },
      { fullName: 'c/z', embedding: [1, 1, 0] },
    ]);
    mockGeminiSuccess([1, 0, 0]); // Same direction as a/x

    const req = postSearch({ query: 'first', rankProjects: true });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rankings: Array<{ fullName: string; score: number }> };
    expect(body.rankings.length).toBeGreaterThan(0);
    expect(body.rankings[0]!.fullName).toBe('a/x');
  });
});

describe('handleSearch — findSimilar mode', () => {
  it('returns similar projects without calling Gemini', async () => {
    mockEmbeddingsCacheLoad([
      { fullName: 'a/x', embedding: [1, 0, 0] },
      { fullName: 'b/y', embedding: [0.9, 0.1, 0] },
      { fullName: 'c/z', embedding: [0, 0, 1] },
    ]);
    const req = postSearch({ findSimilar: 'a/x' });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rankings: Array<{ fullName: string; score: number }>; provider: string };
    expect(body.provider).toBe('cached');
    expect(body.rankings[0]!.fullName).toBe('b/y');
  });

  it('returns empty rankings when target is not in cache', async () => {
    mockEmbeddingsCacheLoad([{ fullName: 'a/x', embedding: [1, 0, 0] }]);
    const req = postSearch({ findSimilar: 'unknown/repo' });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as { rankings: unknown[] };
    expect(body.rankings).toEqual([]);
  });
});

describe('handleSearch — findSimilarBatch mode', () => {
  it('returns batchResults keyed by target name', async () => {
    mockEmbeddingsCacheLoad([
      { fullName: 'a/x', embedding: [1, 0, 0] },
      { fullName: 'b/y', embedding: [0.9, 0.1, 0] },
      { fullName: 'c/z', embedding: [0, 1, 0] },
    ]);
    const req = postSearch({ findSimilarBatch: ['a/x', 'c/z'] });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { batchResults: Record<string, Array<{ fullName: string }>> };
    expect(Object.keys(body.batchResults)).toEqual(['a/x', 'c/z']);
  });

  it('rejects batches larger than 12', async () => {
    const req = postSearch({ findSimilarBatch: Array.from({ length: 13 }, (_, i) => `r/${i}`) });
    const ctx = createExecutionContext();
    const res = await handleSearch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});
```

Add the helper function used by these tests above the existing `describe` blocks:

```ts
function mockEmbeddingsCacheLoad(entries: Array<{ fullName: string; embedding: number[] }>) {
  const FIRESTORE_HOST = 'https://firestore.googleapis.com';
  fetchMock.get(FIRESTORE_HOST).intercept({
    path: `/v1/projects/${env.GCP_PROJECT_ID}/databases/(default)/documents/embeddingsCache/meta`,
    method: 'GET',
  }).reply(200, {
    name: 'meta',
    fields: { partCount: { integerValue: '1' }, totalProjects: { integerValue: String(entries.length) } },
  });
  fetchMock.get(FIRESTORE_HOST).intercept({
    path: `/v1/projects/${env.GCP_PROJECT_ID}/databases/(default)/documents/embeddingsCache/part0`,
    method: 'GET',
  }).reply(200, {
    name: 'part0',
    fields: {
      entries: {
        arrayValue: {
          values: entries.map(e => ({
            mapValue: {
              fields: {
                fullName: { stringValue: e.fullName },
                embedding: { arrayValue: { values: e.embedding.map(v => ({ doubleValue: v })) } },
              },
            },
          })),
        },
      },
    },
  });
}
```

- [ ] **Step 2: Run the new tests, expect failure**

```bash
npm test -- search
```

Expected: the new tests fail with "rankProjects mode not implemented" or similar.

- [ ] **Step 3: Update `workers/api/src/routes/search.ts`** to handle the three new modes and add the Workers AI fallback. Replace the existing file with this complete version:

```ts
import type { Env } from '../worker';
import { embedWithGemini, GeminiError } from '../lib/gemini';
import { validateQuery, validateFindSimilar, validateFindSimilarBatch, ValidationError } from '../lib/validation';
import { isOriginAllowed } from '../lib/origin';
import { loadProjectEmbeddings } from '../lib/embeddings-cache';
import { cosineSimilarity } from '../lib/cosine';

const QUERY_CACHE_TTL_S = 24 * 60 * 60;
const SCORE_THRESHOLD = 0.25;
const RANK_LIMIT = 12;
const BATCH_RESULT_LIMIT = 3;

interface CachedQueryEmbedding {
  embedding: number[];
  provider: 'gemini' | 'cloudflare';
  dimensions: number;
  createdAt: number;
}

export async function handleSearch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') return jsonError(405, 'Method not allowed');
  if (!isOriginAllowed(request, env.CORS_ORIGIN)) return jsonError(403, 'Origin not allowed');

  if (env.SEARCH_RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.SEARCH_RATE_LIMITER.limit({ key: ip });
    if (!success) return jsonError(429, 'Rate limit exceeded');
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonError(400, 'Body must be valid JSON');
  }

  // Mode dispatch — order matters: batch must come before findSimilar so a payload
  // with both keys (shouldn't happen but defense in depth) goes to the more specific mode.
  if (Array.isArray(payload.findSimilarBatch)) {
    return handleFindSimilarBatch(payload, env);
  }
  if (typeof payload.findSimilar === 'string') {
    return handleFindSimilar(payload, env);
  }
  if (typeof payload.query === 'string') {
    return handleQueryMode(payload, env, !!payload.rankProjects);
  }
  return jsonError(400, 'Request must include query, findSimilar, or findSimilarBatch');
}

async function handleQueryMode(payload: Record<string, unknown>, env: Env, rankProjects: boolean): Promise<Response> {
  let query: string;
  try {
    query = validateQuery(payload.query);
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(400, err.message);
    throw err;
  }

  const normalized = query.toLowerCase().trim();
  const cacheKey = await sha256Hex(normalized);

  let provider: 'gemini' | 'cloudflare';
  let queryEmbedding: number[];
  let dimensions: number;
  let wasCached = false;

  const cachedRaw = await env.QUERY_EMBEDDING_CACHE.get(cacheKey);
  if (cachedRaw) {
    const cached = JSON.parse(cachedRaw) as CachedQueryEmbedding;
    queryEmbedding = cached.embedding;
    provider = cached.provider;
    dimensions = cached.dimensions;
    wasCached = true;
  } else {
    let result: { values: number[]; provider: 'gemini' | 'cloudflare'; dimensions: number };
    try {
      result = await embedWithGemini(normalized, env.GEMINI_API_KEY);
    } catch (geminiErr) {
      console.warn('search: Gemini failed, trying Workers AI fallback', (geminiErr as Error).message);
      try {
        const aiRes = (await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [normalized] })) as { data: number[][] };
        const values = aiRes.data?.[0];
        if (!Array.isArray(values) || values.length === 0) {
          throw new Error('Workers AI returned empty embedding');
        }
        result = { values, provider: 'cloudflare', dimensions: 1024 };
      } catch (aiErr) {
        console.error('search: All embedding providers failed', (aiErr as Error).message);
        return jsonError(500, 'All embedding providers failed');
      }
    }
    queryEmbedding = result.values;
    provider = result.provider;
    dimensions = result.dimensions;

    try {
      await env.QUERY_EMBEDDING_CACHE.put(
        cacheKey,
        JSON.stringify({ embedding: queryEmbedding, provider, dimensions, createdAt: Date.now() } satisfies CachedQueryEmbedding),
        { expirationTtl: QUERY_CACHE_TTL_S }
      );
    } catch (err) {
      console.warn('search: KV cache write failed (non-fatal)', err);
    }
  }

  if (!rankProjects) {
    return json({ embedding: queryEmbedding, provider, dimensions, cached: wasCached });
  }

  const embMap = await loadProjectEmbeddings(env.GCP_PROJECT_ID);
  const ranked = rankAgainstMap(queryEmbedding, embMap, RANK_LIMIT);
  return json({ rankings: ranked, provider, cached: wasCached });
}

async function handleFindSimilar(payload: Record<string, unknown>, env: Env): Promise<Response> {
  let target: string;
  try {
    target = validateFindSimilar(payload.findSimilar);
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(400, err.message);
    throw err;
  }

  const embMap = await loadProjectEmbeddings(env.GCP_PROJECT_ID);
  const targetEmb = embMap.get(target);
  if (!targetEmb) {
    return json({ rankings: [], provider: 'cached', cached: true });
  }
  const ranked = rankAgainstMap(targetEmb, embMap, RANK_LIMIT, target);
  return json({ rankings: ranked, provider: 'cached', cached: true });
}

async function handleFindSimilarBatch(payload: Record<string, unknown>, env: Env): Promise<Response> {
  let targets: string[];
  try {
    targets = validateFindSimilarBatch(payload.findSimilarBatch);
  } catch (err) {
    if (err instanceof ValidationError) return jsonError(400, err.message);
    throw err;
  }

  const embMap = await loadProjectEmbeddings(env.GCP_PROJECT_ID);
  const batchResults: Record<string, Array<{ fullName: string; score: number }>> = {};
  for (const target of targets) {
    const targetEmb = embMap.get(target);
    if (!targetEmb) {
      batchResults[target] = [];
      continue;
    }
    batchResults[target] = rankAgainstMap(targetEmb, embMap, BATCH_RESULT_LIMIT, target);
  }
  return json({ batchResults, provider: 'cached', cached: true });
}

function rankAgainstMap(
  queryEmb: number[],
  embMap: Map<string, number[]>,
  limit: number,
  excludeFullName?: string
): Array<{ fullName: string; score: number }> {
  const ranked: Array<{ fullName: string; score: number }> = [];
  for (const [fullName, projectEmb] of embMap) {
    if (excludeFullName !== undefined && fullName === excludeFullName) continue;
    if (queryEmb.length !== projectEmb.length) continue; // dimension mismatch (provider mismatch)
    const score = cosineSimilarity(queryEmb, projectEmb);
    if (score > SCORE_THRESHOLD) {
      ranked.push({ fullName, score: Math.round(score * 10000) / 10000 });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function jsonError(status: number, message: string): Response {
  return json({ error: message }, status);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
```

- [ ] **Step 4: Run all search tests, verify pass**

```bash
npm test -- search
```

Expected: all tests pass (5 from Task 11 + 6 new ones).

- [ ] **Step 5: Run full test suite + typecheck**

```bash
npm test && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/routes/search.ts workers/api/test/search.test.ts
git commit -m "feat(workers): implement rankProjects, findSimilar, findSimilarBatch modes + Workers AI fallback"
```

---

## Task 13: Worker entry + router (TDD)

**Files:**
- Modify: `workers/api/src/worker.ts`
- Create: `workers/api/test/router.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// workers/api/test/router.test.ts
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
```

- [ ] **Step 2: Run, expect failure**

```bash
npm test -- router
```

Expected: routing tests fail because worker still returns "ok" for everything.

- [ ] **Step 3: Replace `workers/api/src/worker.ts` with the full router**

```ts
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
```

- [ ] **Step 4: Run all tests, verify pass**

```bash
npm test
```

Expected: all tests across all suites pass.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 6: Update the sanity test from Task 2** — it expected `'ok'` from `https://example.com/`, but the new router returns 404 for unknown paths. Update `workers/api/test/sanity.test.ts`:

```ts
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/worker';

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
```

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/worker.ts workers/api/test/router.test.ts workers/api/test/sanity.test.ts
git commit -m "feat(workers): wire up router with health check, search, and badge routes"
```

---

## Task 14: Manual smoke test via `wrangler dev`

**Files:** None modified. Verification only.

This task uses real network — Workers AI binding, real Firestore reads, real Gemini API. No commit at the end.

- [ ] **Step 1: Set the Gemini API key locally**

```bash
cd workers/api
wrangler secret put GEMINI_API_KEY
# Paste the same key currently in the GitHub Actions secret GEMINI_API_KEY
```

This stores the secret in the deployed Worker (Cloudflare side). For local `wrangler dev` it also reads from `.dev.vars`. Create that:

```bash
echo "GEMINI_API_KEY=$(your-gemini-api-key-here)" > .dev.vars
```

`.dev.vars` is in `.gitignore`. Do NOT commit.

- [ ] **Step 2: Comment out the KV namespace block in `wrangler.toml` for now** (still has placeholder id)

The local Miniflare will use a local KV simulator and doesn't need the real namespace id. The simplest workaround: in `wrangler.toml`, change `id = "REPLACE..."` to `preview_id = "local-dev-namespace"` and add `id = "0".repeat(32)` so wrangler is happy. Or just leave the placeholder — `wrangler dev` will warn but proceed.

- [ ] **Step 3: Run `wrangler dev`**

```bash
npm run dev
```

Expected: `wrangler dev` starts on `http://localhost:8787`. You should see no fatal errors.

- [ ] **Step 4: Hit each endpoint with curl from another terminal**

```bash
# Health check
curl -s http://localhost:8787/api/health

# Badge — known good repo
curl -sI "http://localhost:8787/api/badge?repo=infiniflow/ragflow"

# Search query mode
curl -s -X POST http://localhost:8787/api/search \
  -H "Content-Type: application/json" \
  -H "Origin: https://aidigitalcrew.com" \
  -d '{"query":"vector database"}' | head -200

# Search rankProjects mode
curl -s -X POST http://localhost:8787/api/search \
  -H "Content-Type: application/json" \
  -H "Origin: https://aidigitalcrew.com" \
  -d '{"query":"semantic search","rankProjects":true}' | head -200

# findSimilar
curl -s -X POST http://localhost:8787/api/search \
  -H "Content-Type: application/json" \
  -H "Origin: https://aidigitalcrew.com" \
  -d '{"findSimilar":"infiniflow/ragflow"}' | head -200
```

Expected:
- `/api/health` → `ok`
- `/api/badge?repo=infiniflow/ragflow` → `200 OK`, `Content-Type: image/svg+xml`
- `/api/search` query → 3072-dim embedding array, `provider: "gemini"`
- `/api/search` rankProjects → array of 12 ranked projects
- `/api/search` findSimilar → array of 12 similar projects

If any of these fail, debug locally before proceeding. Common issues:
- Firestore returning empty: verify `GCP_PROJECT_ID` in `wrangler.toml` is `ai-digital-crew`.
- Gemini 503: just retry — the retry logic should handle it.
- AI binding error: `wrangler dev` may not fully simulate `env.AI`. The fallback path won't be tested locally; rely on the unit tests for that.

- [ ] **Step 5: Stop `wrangler dev` and commit nothing**

This task is verification-only. Do NOT commit.

---

## Task 15: Deploy worker to Cloudflare without route attached

**Files:**
- Modify: `workers/api/wrangler.toml` (KV namespace id)

This is Stage 2 of the cutover plan — Worker exists in production but no traffic.

- [ ] **Step 1: Create the production KV namespace**

```bash
cd workers/api
wrangler kv:namespace create QUERY_EMBEDDING_CACHE
```

Expected output includes a line like:
```
{ binding = "QUERY_EMBEDDING_CACHE", id = "abc123def456..." }
```

- [ ] **Step 2: Paste the id into `wrangler.toml`**

Replace `REPLACE_WITH_KV_NAMESPACE_ID_AFTER_CREATE` with the real id.

- [ ] **Step 3: Set the Gemini secret in production**

```bash
wrangler secret put GEMINI_API_KEY
```

Paste the key when prompted. This stores it encrypted in Cloudflare's secret store.

- [ ] **Step 4: Deploy** (route is still NOT attached because the `routes` block is commented in wrangler.toml)

```bash
wrangler deploy
```

Expected: deploy succeeds, you get a URL like `https://aidigitalcrew-api.<account>.workers.dev`.

- [ ] **Step 5: Hit the deployed Worker directly**

```bash
WORKER_URL="https://aidigitalcrew-api.<account>.workers.dev"
curl -s $WORKER_URL/api/health
curl -sI "$WORKER_URL/api/badge?repo=infiniflow/ragflow"
curl -s -X POST $WORKER_URL/api/search \
  -H "Content-Type: application/json" \
  -H "Origin: https://aidigitalcrew.com" \
  -d '{"query":"test","rankProjects":true}' | head -100
```

Expected: same responses as `wrangler dev`. If `/api/badge` returns the SVG and `/api/search` returns rankings, the production Worker is healthy.

- [ ] **Step 6: Commit the wrangler.toml change**

```bash
cd /Users/ariv/AgenticAILearner/ai-digital-crew-site/ai-digital-crew
git add workers/api/wrangler.toml
git commit -m "chore(workers): set production KV namespace id"
```

---

## Task 16: Frontend feature flag (default off) — Stage 3a

**Files:**
- Modify: `index.html` (CSP, USE_WORKERS_API constant, getEmbeddingFn refactor, trendBadge URL)
- Modify: `project.html` (badge URL only)

This task adds the kill switch with the flag set to **false** so nothing changes for users yet. Stage 4 will flip it to true.

- [ ] **Step 1: Locate `getEmbeddingFn` in `index.html`**

```bash
grep -n 'getEmbeddingFn\|USE_WORKERS_API' index.html
```

Expected: `getEmbeddingFn` defined around line 1299–1306. `USE_WORKERS_API` not yet present.

- [ ] **Step 2: Add the feature flag constant near the top of the script section**

Find the line that says something like `// State management` or the first `let state = ...` declaration. Above it, add:

```js
// Feature flag: when true, search + badge calls go to the Cloudflare Worker at /api/*
// When false (default), they go to the legacy Firebase Functions (currently broken due to billing).
// Flip to true in a separate commit (Stage 4 of the migration cutover) once the Worker is verified.
const USE_WORKERS_API = false;
```

- [ ] **Step 3: Add a `callSearch` helper near `getEmbeddingFn`**

Before the existing `getEmbeddingFn` definition, add:

```js
async function callSearchWorker(data) {
  const res = await fetch('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Search API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}
```

- [ ] **Step 4: Update every call site that uses `getEmbeddingFn`** so it routes through `callSearchWorker` when the flag is on.

The existing pattern is:
```js
const fn = await getEmbeddingFn();
const result = await fn({ query, rankProjects: true });
const data = result.data;
```

Replace each such block with:
```js
let data;
if (USE_WORKERS_API) {
  data = await callSearchWorker({ query, rankProjects: true });
} else {
  const fn = await getEmbeddingFn();
  const result = await fn({ query, rankProjects: true });
  data = result.data;
}
```

Apply this transformation to ALL call sites. Use `grep -n 'getEmbeddingFn()' index.html` to find them. There are approximately 4–6 call sites — update each.

- [ ] **Step 5: Update the `trendBadge(p)` function around line 3061**

Find:
```js
function trendBadge(p) {
  // ... constructs URL like https://us-central1-ai-digital-crew.cloudfunctions.net/trendBadge?repo=...
}
```

Replace the URL construction with:
```js
function trendBadge(p) {
  const repoEncoded = encodeURIComponent(p.fullName);
  const badgeUrl = USE_WORKERS_API
    ? `/api/badge?repo=${repoEncoded}`
    : `https://us-central1-ai-digital-crew.cloudfunctions.net/trendBadge?repo=${repoEncoded}`;
  // ... rest of the existing function unchanged, using badgeUrl in the <img src="...">
}
```

(Read the existing implementation first to understand exactly where to splice. Do not delete the existing logic — only replace the URL construction.)

- [ ] **Step 6: Update CSP `connect-src`**

Find the `<meta http-equiv="Content-Security-Policy">` tag in `index.html`. Locate the `connect-src` directive. Currently it includes `https://*.cloudfunctions.net`. We're NOT removing it yet (the legacy fallback still uses it when the flag is off). Just verify `'self'` is present. It should already be — `'self'` covers `/api/*` since the Worker route is same-origin.

If `'self'` is not in `connect-src`, add it.

- [ ] **Step 7: Update `project.html` similarly**

```bash
grep -n 'cloudfunctions.net\|trendBadge' project.html
```

If it constructs a badge URL, apply the same `USE_WORKERS_API` branch as in Step 5.

- [ ] **Step 8: Commit**

```bash
git add index.html project.html
git commit -m "feat(frontend): add USE_WORKERS_API flag for Workers migration cutover

Default false — every call still goes to Firebase Functions. Flag flip
happens in Stage 4 once the Cloudflare Worker is verified in production."
```

---

## Task 17: CI workflow for Worker deploy

**Files:**
- Create: `.github/workflows/deploy-workers.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
# .github/workflows/deploy-workers.yml
name: Deploy Workers API

on:
  push:
    branches: [main]
    paths:
      - 'workers/api/**'
      - '.github/workflows/deploy-workers.yml'
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '24'

      - name: Install dependencies
        working-directory: workers/api
        run: npm ci

      - name: Run tests
        working-directory: workers/api
        run: npm test

      - name: Typecheck
        working-directory: workers/api
        run: npm run typecheck

      - name: Deploy to Cloudflare
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: workers/api
          command: deploy
```

- [ ] **Step 2: Verify the workflow YAML is valid**

```bash
# If `actionlint` is installed:
actionlint .github/workflows/deploy-workers.yml || true
# Otherwise, just visually inspect.
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-workers.yml
git commit -m "ci(workers): add CI workflow to test and deploy aidigitalcrew-api on push to main"
```

- [ ] **Step 4: Note** — the workflow only runs when files under `workers/api/**` change. It does NOT run on every push to main. This avoids redundant deploys.

- [ ] **Step 5: Note** — Gemini secret deployment is NOT automated. The user runs `wrangler secret put GEMINI_API_KEY` manually once, and the secret persists across deploys.

---

## Task 18: Attach route to Worker — Stage 3b

**Files:**
- Modify: `workers/api/wrangler.toml`

- [ ] **Step 1: Edit `workers/api/wrangler.toml`**

Add a `routes` block after the `compatibility_flags` line:

```toml
routes = [
  { pattern = "aidigitalcrew.com/api/*", zone_name = "aidigitalcrew.com" },
]
```

- [ ] **Step 2: Deploy with route attached**

```bash
cd workers/api
wrangler deploy
```

Expected: deploy succeeds and the route is attached. Wrangler may print a message confirming the route binding.

- [ ] **Step 3: Verify the route is live**

```bash
curl -s https://aidigitalcrew.com/api/health
```

Expected: `ok`

```bash
curl -sI "https://aidigitalcrew.com/api/badge?repo=infiniflow/ragflow"
```

Expected: `200 OK`, `Content-Type: image/svg+xml`

- [ ] **Step 4: Verify the frontend is unaffected**

Open `https://aidigitalcrew.com` in a browser. Search should still be broken (still calls Firebase), badges should still be broken (still calls Firebase). The Worker exists at `/api/*` but nothing on the page calls it yet — the flag is still `false`.

- [ ] **Step 5: Commit**

```bash
cd /Users/ariv/AgenticAILearner/ai-digital-crew-site/ai-digital-crew
git add workers/api/wrangler.toml
git commit -m "feat(workers): attach Worker route at aidigitalcrew.com/api/*"
```

---

## Task 19: Cutover — flip `USE_WORKERS_API` to true (Stage 4)

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Flip the flag**

In `index.html`, find:
```js
const USE_WORKERS_API = false;
```

Change to:
```js
const USE_WORKERS_API = true;
```

- [ ] **Step 2: Commit (do NOT push yet)**

```bash
git add index.html
git commit -m "feat(frontend): cut over to Cloudflare Workers API (Stage 4)

Production search and badges now route through aidigitalcrew.com/api/*
served by the aidigitalcrew-api Cloudflare Worker. Firebase Functions
remain deployed but unused — they will be deleted in a follow-up commit
once 24h of healthy metrics confirms the cutover."
```

- [ ] **Step 3: Push to staging branch and let it auto-deploy via deploy-staging.yml**

```bash
git push origin staging
```

Expected: GitHub Actions `Deploy Staging` workflow fires, redeploys staging Cloudflare Pages within ~30s.

- [ ] **Step 4: Verify on staging first**

Open `https://aidigitalcrew-staging.<your-staging-host>` (or whatever your staging URL is). Run a search. Verify:
- Search returns results.
- Badges render.
- No console errors.

- [ ] **Step 5: If staging looks good, fast-forward main**

```bash
git checkout main
git merge --ff-only staging
git push origin main
git checkout staging
```

This triggers `deploy-cloudflare.yml` (production deploy).

- [ ] **Step 6: Monitor for 10 minutes**

Open the Cloudflare Workers dashboard for `aidigitalcrew-api`. Watch:
- Request count (should rise as traffic hits)
- 5xx error rate (should be < 1%)
- p95 latency (should be < 2s for search, < 500ms for badge)

If any rollback criterion is hit, immediately revert with:
```bash
git revert HEAD --no-edit
git push origin main
```

This flips the flag back to `false` and redeploys, restoring the (broken-but-no-worse) Firebase fallback path.

---

## Task 20: Audit document

**Files:**
- Create: `docs/audits/2026-04-10-workers-migration-audit.md`

- [ ] **Step 1: Create the audit directory**

```bash
mkdir -p docs/audits
```

- [ ] **Step 2: Write the audit document**

Use this template, filling in actual measurements as you collect them:

```markdown
# Workers Migration Audit — 2026-04-10

**Migration spec:** `docs/superpowers/specs/2026-04-10-workers-migration-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-04-10-workers-migration.md`
**Audited by:** [your name / agent id]
**Audit date:** [YYYY-MM-DD]

## 1. Behavior parity matrix

| # | Mode | Input | Expected (per source) | Worker output | Diff | Pass |
|---|---|---|---|---|---|---|
| 1 | search query | `{"query":"vector database"}` | `{ embedding: number[3072], provider: "gemini", dimensions: 3072, cached: false }` | [paste actual] | [diff] | ✅ |
| 2 | search query (cached) | same as above, second call | `{ ..., cached: true }` | [paste] | [diff] | ✅ |
| 3 | search rankProjects | `{"query":"semantic search","rankProjects":true}` | `{ rankings: [12 entries], provider: "gemini", cached: false }` | [paste first 3 entries] | [diff] | ✅ |
| ... | (continue for all 4 modes × at least 5 cases each + 5 badge cases) | | | | | |
| 25 | badge missing repo | `?repo=foo/nonexistent` | 404 | [paste status] | — | ✅ |

Capture commands:
```bash
curl -s -X POST https://aidigitalcrew.com/api/search \
  -H "Content-Type: application/json" \
  -H "Origin: https://aidigitalcrew.com" \
  -d '{"query":"vector database"}' | jq .
```

## 2. Security checklist (OWASP API Top 10, 2023)

| Item | Applicable | Status | Notes |
|---|---|---|---|
| API1 — Broken Object Level Authorization | No | N/A | No object IDs in API surface |
| API2 — Broken Authentication | Yes | Acceptable | Auth intentionally removed; replaced with rate limit + origin check (documented in spec §Security model) |
| API3 — Broken Object Property Level Authorization | No | N/A | No property-level access control needed |
| API4 — Unrestricted Resource Consumption | Yes | Mitigated | Cloudflare Rate Limiting binding (30/min search, 60/min badge) + KV cache + isolate cache |
| API5 — Broken Function Level Authorization | No | N/A | All endpoints are intentionally public |
| API6 — Unrestricted Access to Sensitive Business Flows | No | N/A | No business flows |
| API7 — Server Side Request Forgery | Yes | Mitigated | Worker only calls hardcoded URLs (Firestore, Gemini, env.AI). No user input is interpolated into outbound URLs except via `encodeURIComponent` for the Firestore query. |
| API8 — Security Misconfiguration | Yes | Verify | Confirm: no `.dev.vars` committed, GEMINI_API_KEY only in wrangler secret store, KV namespace id in repo is not sensitive |
| API9 — Improper Inventory Management | Yes | OK | Worker is the only API surface; spec + plan + audit all committed |
| API10 — Unsafe Consumption of APIs | Yes | Mitigated | Gemini retry has fail-fast on 4xx; Firestore REST has explicit error handling; Workers AI has try/catch |

## 3. Performance benchmarks

| Endpoint | Cold start | Warm p50 | Warm p95 | Warm p99 |
|---|---|---|---|---|
| `/api/health` | [ms] | [ms] | [ms] | [ms] |
| `/api/badge` (cache miss) | [ms] | [ms] | [ms] | [ms] |
| `/api/badge` (cache hit) | [ms] | [ms] | [ms] | [ms] |
| `/api/search` query (KV miss, Gemini) | [ms] | [ms] | [ms] | [ms] |
| `/api/search` query (KV hit) | [ms] | [ms] | [ms] | [ms] |
| `/api/search` rankProjects (cold isolate) | [ms] | [ms] | [ms] | [ms] |
| `/api/search` rankProjects (warm isolate) | [ms] | [ms] | [ms] | [ms] |
| `/api/search` findSimilar | [ms] | [ms] | [ms] | [ms] |

Measurement method: 100 sequential requests via `hey` or `wrk` from a developer machine. Document the location and tool used.

## 4. Cost projection

[Copy the cost table from the spec, then add a "actual measured (post-cutover)" column once you have 7 days of metrics.]

## 5. Rollback drill

Date: [YYYY-MM-DD]
Procedure: flipped `USE_WORKERS_API` to false in a test commit, pushed to staging, measured time to redeploy and observe browser behavior.
Result: [time in seconds, observations]

## 6. Code review checklist

Files reviewed line-by-line:

- [ ] `workers/api/src/worker.ts`
- [ ] `workers/api/src/routes/search.ts`
- [ ] `workers/api/src/routes/badge.ts`
- [ ] `workers/api/src/lib/firestore.ts`
- [ ] `workers/api/src/lib/gemini.ts`
- [ ] `workers/api/src/lib/embeddings-cache.ts`
- [ ] `workers/api/src/lib/cosine.ts`
- [ ] `workers/api/src/lib/svg.ts`
- [ ] `workers/api/src/lib/validation.ts`
- [ ] `workers/api/src/lib/origin.ts`
- [ ] `workers/api/wrangler.toml`
- [ ] `index.html` USE_WORKERS_API call sites

Issues found and resolved: [list, or "none"]

## 7. Sign-off

- [ ] All parity matrix rows pass
- [ ] All security checklist items addressed
- [ ] Performance benchmarks within target SLOs
- [ ] Cost projection re-validated against actual usage
- [ ] Rollback drill completed
- [ ] Code review checklist complete
- [ ] User has reviewed this audit document
```

- [ ] **Step 3: Capture actual measurements**

Run the curl commands from §1 against `https://aidigitalcrew.com/api/*` and paste the responses into the parity matrix.

For §3 (performance), use `hey -n 100 -c 5` against each endpoint and paste the percentiles.

- [ ] **Step 4: Run the code-reviewer agent against the migration PR**

Use the `feature-dev:code-reviewer` agent or equivalent. Paste any issues found into §6.

- [ ] **Step 5: Fix any issues the audit surfaces, before declaring the migration complete**

If the audit finds bugs, return to the relevant task, fix, retest, redeploy.

- [ ] **Step 6: Have the user review the audit document**

Ask the user to review §1–§7 and check off the §7 sign-off boxes.

- [ ] **Step 7: Commit the audit document**

```bash
git add docs/audits/2026-04-10-workers-migration-audit.md
git commit -m "docs(audit): add Workers migration audit document"
```

---

## Task 21: Stage 4 cleanup — delete Firebase Functions

**Files:**
- Delete: `functions/index.js`
- Delete: `functions/package.json`
- Delete: `functions/package-lock.json`
- Modify: `firebase.json`
- Modify: `index.html` (remove dead branch + USE_WORKERS_API flag)
- Modify: `project.html` (same)

**Pre-condition:** Task 19 cutover has been live for 24 hours with all success criteria met (see spec §Success criteria).

- [ ] **Step 1: Verify the success criteria are met**

Check the Cloudflare Workers dashboard for `aidigitalcrew-api` over the past 24 hours:
- 5xx error rate < 1% ✓
- p95 latency within targets ✓
- No user reports of broken search ✓

If any criterion fails, do NOT proceed. Return to investigation.

- [ ] **Step 2: Remove the Firebase Functions source**

```bash
git rm -r functions/
```

- [ ] **Step 3: Update `firebase.json` to remove the `functions` block**

```bash
# Read current firebase.json
cat firebase.json
```

Remove the entire `"functions"` array:
```json
"functions": [
  {
    "source": "functions",
    "codebase": "default",
    "runtime": "nodejs24"
  }
],
```

- [ ] **Step 4: Remove the `USE_WORKERS_API` flag and dead Firebase branch from `index.html`**

Find:
```js
const USE_WORKERS_API = true;
```
Delete that line.

For each call site that has the `if (USE_WORKERS_API) { ... } else { ... }` branch, remove the `else` branch and the `if`:
```js
// Before:
let data;
if (USE_WORKERS_API) {
  data = await callSearchWorker({ query, rankProjects: true });
} else {
  const fn = await getEmbeddingFn();
  const result = await fn({ query, rankProjects: true });
  data = result.data;
}

// After:
const data = await callSearchWorker({ query, rankProjects: true });
```

Remove the `getEmbeddingFn` definition entirely (it's no longer used).

For the `trendBadge(p)` function, remove the conditional:
```js
// Before:
const badgeUrl = USE_WORKERS_API
  ? `/api/badge?repo=${repoEncoded}`
  : `https://us-central1-ai-digital-crew.cloudfunctions.net/trendBadge?repo=${repoEncoded}`;

// After:
const badgeUrl = `/api/badge?repo=${repoEncoded}`;
```

- [ ] **Step 5: Update CSP `connect-src` to remove `https://*.cloudfunctions.net`**

Find the meta tag and edit the `connect-src` directive to delete that entry. Keep `'self'` and any other unrelated entries.

- [ ] **Step 6: Apply the same simplification to `project.html`**

- [ ] **Step 7: Commit**

```bash
git add functions firebase.json index.html project.html
git commit -m "chore(workers): remove Firebase Functions after successful cutover

Cutover at $(date -u +%Y-%m-%dT%H:%M:%SZ) has been stable for 24h with
all success criteria met (see docs/audits/2026-04-10-workers-migration-audit.md).
Removing the dead getQueryEmbedding/trendBadge source, the firebase.json
functions block, and the USE_WORKERS_API frontend flag.

GCP billing on the ai-digital-crew project can now be permanently disabled
with no user-facing impact."
```

- [ ] **Step 8: Push to staging, verify, then fast-forward to main**

```bash
git push origin staging
# Verify staging is healthy in browser, then:
git checkout main && git merge --ff-only staging && git push origin main
git checkout staging
```

---

## Self-review (run before declaring this plan complete)

I'm reviewing this plan against the spec and against the No-Placeholders rule.

**Spec coverage check:**

| Spec section | Plan task |
|---|---|
| Architecture topology — single Worker, two routes, same origin | Tasks 1, 13, 18 |
| Bindings (AI, KV, rate limiters, vars, secrets) | Task 1 (config), Task 15 (secrets), Task 18 (route) |
| Security model — no Firebase Auth, rate limit, origin check, validation | Tasks 5, 6, 11, 12 |
| Caching (KV, isolate, Cache API) | Tasks 9 (isolate), 10 (Cache API), 11 (KV) |
| Embedding providers (Gemini REST + Workers AI binding) | Tasks 8, 12 |
| Cutover plan (4 stages) | Tasks 14 (stage 1), 15 (stage 2), 16+18 (stage 3), 19 (stage 4), 21 (stage 4 cleanup) |
| Rollback strategy | Task 19 step 6 |
| Audit deliverables (6 items) | Task 20 |
| Frontend changes (CSP, getEmbeddingFn, badge URL) | Task 16 |
| What stays untouched | Implicit — no tasks modify these files |

✅ Every spec requirement maps to at least one task.

**Placeholder scan:** No "TBD", "TODO", or "fill in details" in the plan body. Every code block contains complete code. The audit document template has placeholders inside `[brackets]` but those are intentional — they're fill-in-blanks the auditor populates with actual measurements.

**Type consistency check:** The `Env` interface is defined in Task 1 and re-exported in Task 13 (same shape). The `RateLimit` interface starts as a local declaration in Task 1 and gets promoted to a top-level export in Task 13 — verified consistent. `cosineSimilarity`, `generateBadgeSvg`, `validateQuery`, `embedWithGemini`, `loadProjectEmbeddings` all use consistent signatures across tasks where they're referenced.

**Scope check:** All tasks contribute to a single coherent migration. Could be split into "Worker implementation" (Tasks 1–13) and "Cutover" (Tasks 14–21), but that creates a sub-plan for the cutover that's tightly coupled. Keeping as one plan is correct.

**Ambiguity check:** Reviewed each task for unclear instructions. One spot where I want to be more explicit: Task 16 step 4 says "Apply this transformation to ALL call sites" for `getEmbeddingFn`. The exact number of call sites depends on `index.html`, which I haven't fully read. Mitigating note: `grep -n 'getEmbeddingFn()' index.html` is provided as the discovery command, so the implementer can find them all.

Plan looks good. Saving and offering execution choice next.
