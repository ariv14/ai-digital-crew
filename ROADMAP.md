# AI Digital Crew — Roadmap

> **Vision:** The CoinMarketCap of AI — a real-time intelligence platform for discovering, tracking, and comparing open-source AI projects.

> Just as CoinMarketCap became the go-to dashboard for crypto markets, AI Digital Crew aims to be the definitive dashboard for the AI open-source ecosystem: **discover → track → compare → stay informed.**

---

## Phase 1: Foundation — SHIPPED

### 1a. AI Tool Finder (Semantic Search)

> **Status:** Shipped 2026-02-21.

- **Keyword search:** Fuse.js fuzzy matching across project name, description, writeup, topics, category
- **Semantic search:** Gemini embeddings (3072 dims) with Cloudflare Workers AI fallback (1024 dims), cosine similarity scoring
- **Cloud Function:** `getQueryEmbedding` generates and caches query embeddings (24h TTL in Firestore)
- **GitHub Discovery:** Live GitHub API search (stars:>100, 10 results) for projects not yet in the catalog
- **Features:** autocomplete, "did you mean?" suggestions, trending queries, recent searches, match badges, similar projects

### 1b. AI Project Radar (Trend Tracking)

> **Status:** Core pipeline and UI shipped 2026-02-22.

- Historical star/fork snapshots in Firestore (`projects/{id}/snapshots`)
- Week-over-week momentum scores computed by daily scrape pipeline
- Trending page (`/#trending`) with AI Projects and Global tabs, inline filters, pagination
- Project detail page (`/project?repo=...`) with star history chart, trend badges, embeddable badges
- Trend labels: Hot, Rising, Steady, Declining, New — with momentum bar visualization

### 1c. Newsletter Pipeline

> **Status:** Daily auto-publish shipped. Weekly curation remaining.

- Daily scrape pipeline: GitHub Actions cron → GitHub API + Gemini AI → Firestore
- Substack auto-publish via Pipedream webhook

### 1d. Lighthouse & Quality

> **Status:** Shipped 2026-02-22.

- CSP header, 0 axe-core violations, modal focus trap, aria-labels
- SEO: 100 — canonical URLs, JSON-LD structured data, sitemap
- Best Practices: 100 — zero console errors, GitHub API rate-limit guard
- Performance: ~80-85 (Firebase SDK overhead; would need build step + SSR for higher)

---

## Phase 2: Leaderboards & Rankings — NEXT UP

Make the trending page feel like a real-time market dashboard.

- **Category leaderboards** — "Top NLP projects", "Fastest growing Agents", "Hot in Computer Vision"
- **Global rankings** — sortable table by stars, growth rate, momentum, forks
- **Time range selectors** — 24h, 7d, 30d, all-time views
- **Gainers & Losers** — biggest movers up/down in the last 24h/7d (like CoinMarketCap's top gainers)
- **Weekly recap banner** — "This week: 12 new Hot projects, 3 crossed 10k stars"

---

## Phase 3: Watchlists & Alerts

Let users personalize their experience — the "portfolio" equivalent.

- **Watchlist** — authenticated users can star/bookmark projects into a personal watchlist
- **Watchlist dashboard** — see all tracked projects with latest trend data at a glance
- **Category alerts** — "notify me when a new Hot project appears in NLP"
- **Milestone alerts** — "notify me when project X crosses 10k stars"
- **Delivery:** in-app notifications + optional email digest

---

## Phase 4: Compare & Analyze

Side-by-side intelligence for decision-making.

- **Head-to-head comparison** — pick 2-3 projects, compare stars, growth, momentum, language, topics
- **Overlay star history charts** — multiple projects on one timeline
- **Richer data signals** — commit frequency, contributor count, issue velocity, release cadence, download stats (npm/PyPI)
- **Health score** — composite metric combining activity, community, growth, and maintenance signals
- **Category market share** — pie/bar charts showing dominance within a category

---

## Phase 5: Weekly Curated Digest

Turn data into narrative — the "research report" layer.

- Aggregate weekly picks with Gemini-assisted editorial blurbs
- "Project of the Week" spotlight with deep-dive writeup
- Category-specific digests (e.g. "This week in AI Agents")
- Build subscriber audience via Substack
- Archive past digests on the site

---

## Phase 6: Ecosystem Utilities

Lower the barrier from discovery to action.

- **"Deploy This" one-click templates** — detect project type (Dockerfile, package.json, requirements.txt), link to Railway/Render/Vercel deploy
- **Contributor matchmaking** — "looking for contributors" tags, skill/language filters, interest notifications
- **API access** — public REST API for trend data, embeddable widgets, badges
- **Browser extension** — show AI Digital Crew trend data on any GitHub repo page

---

## The CoinMarketCap Analogy

| CoinMarketCap | AI Digital Crew |
|---|---|
| Token listings | GitHub project listings |
| Price charts | Star history charts |
| Market cap / volume | Stars, forks, momentum scores |
| Trending coins | Hot / Rising / New trend labels |
| Top gainers / losers | Biggest movers (planned) |
| Watchlists | Personal watchlists (planned) |
| Price alerts | Category & milestone alerts (planned) |
| Token comparison | Project comparison (planned) |
| Weekly reports | Substack newsletter |
| CoinMarketCap API | Public trend data API (planned) |

---

## Notes
- Phase 1 is the foundation — search, trending, newsletter, and quality are live
- Phase 2 (leaderboards) is the highest-impact next step — makes the site feel like a real dashboard
- Phase 3 (watchlists) drives retention and repeat visits
- Phase 4 (compare) adds depth for power users making technology decisions
- Phase 5 (digest) builds audience and authority over time
- Phase 6 (utilities) extends reach beyond the site itself
