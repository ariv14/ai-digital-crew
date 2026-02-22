# AI Digital Crew — Roadmap

> Ideas to evolve from a passive showcase into an actively useful platform.

---

## Direction 1: AI Tool Finder (Semantic Search) — SHIPPED

> **Status:** Shipped 2026-02-21.

Implemented as a hybrid keyword + semantic search system:

- **Keyword search:** Fuse.js fuzzy matching across project name, description, writeup, topics, category
- **Semantic search:** Gemini embeddings (3072 dims) with Cloudflare Workers AI fallback (1024 dims), cosine similarity scoring
- **Cloud Function:** `getQueryEmbedding` generates and caches query embeddings (24h TTL in Firestore)
- **GitHub Discovery:** Live GitHub API search (stars:>100, 10 results) for projects not yet in the catalog
- **Features:** autocomplete, "did you mean?" suggestions, trending queries, recent searches, match badges, similar projects
- **Architecture:** Dedicated search page (SPA view via `/#search`), results in own grid

---

## Direction 2: AI Project Radar (Trend Tracking) — PARTIALLY SHIPPED

> **Status:** Core pipeline and UI shipped 2026-02-22. Category alerts remaining.

### Shipped
- Historical star/fork snapshots stored in Firestore (`projects/{id}/snapshots`)
- Week-over-week momentum scores computed by daily scrape pipeline
- Trending page merged into SPA (`/#trending`) with AI Projects and Global tabs
- Inline filters by category, language, and search with pagination
- Project detail page (`/project?repo=...`) with star history chart, trend badges, and embeddable badges
- Trend labels: Hot, Rising, Steady, Declining, New — with momentum bar visualization

### Remaining
- Let users subscribe to category alerts (e.g. "notify me when a new Hot project appears in NLP")

---

## Direction 3: Weekly AI Digest Newsletter — PARTIALLY SHIPPED

> **Status:** Daily pipeline and Substack integration shipped. Weekly curation remaining.

### Shipped
- Daily scrape pipeline: GitHub Actions cron → GitHub API + Gemini AI → Firestore
- Substack auto-publish via Pipedream webhook (`scripts/substack-publish.js`)
- ProseMirror payload builder for newsletter formatting

### Remaining
- Aggregate daily picks into a curated weekly digest with editorial blurbs
- Gemini-assisted commentary per featured project
- Build subscriber audience and optimize newsletter format

---

## Direction 4: "Deploy This" One-Click Templates — NOT STARTED

For each featured project, add a one-click deploy button (Railway, Render, Vercel, etc.).

- Detect project type (Node, Python, Docker, etc.) from repo metadata
- Map to appropriate hosting platform
- Lower the barrier from "discovery" to "running it"

---

## Direction 5: Contributor Matchmaking — NOT STARTED

Connect developers who want to contribute with projects that need help.

- Add "looking for contributors" tag to projects
- Let devs filter by language, skill, or project type
- Optional: notify project owners when someone expresses interest

---

## Lighthouse & Quality — SHIPPED

> **Status:** Shipped 2026-02-22.

- Content-Security-Policy header with full allowlist for Firebase, GitHub, Cloudflare
- Accessibility: 0 axe-core violations, aria-labels, modal focus trap
- SEO: 100 — canonical URLs, JSON-LD structured data on project pages, sitemap with all routes
- Best Practices: 100 — zero console errors, GitHub API rate-limit pre-check
- Performance: ~80-85 (limited by Firebase SDK size and Firestore long-polling; would need build step + SSR to improve further)

---

## Notes
- Directions 1 and 2 are the core product — search + trending are live
- Direction 3 is low effort, high compounding value (audience building) — daily pipeline exists, weekly curation is the gap
- Directions 4 + 5 require more UX thinking and potentially owner opt-in
- Inspiration: openclaw.ai (active utility vs passive browsing)
