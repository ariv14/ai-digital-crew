# AI Digital Crew — Roadmap

> Ideas to evolve from a passive showcase into an actively useful platform.

---

## Direction 1: AI Tool Finder (Semantic Search) — SHIPPED

> **Status:** Shipped 2026-02-21. Dedicated search page at `/` → "Search" nav link.

Implemented as a hybrid keyword + semantic search system:

- **Keyword search:** Fuse.js fuzzy matching across project name, description, writeup, topics, category
- **Semantic search:** Gemini embeddings (3072 dims) with Cloudflare Workers AI fallback (1024 dims), cosine similarity scoring
- **Cloud Function:** `getQueryEmbedding` generates and caches query embeddings (24h TTL in Firestore)
- **GitHub Discovery:** Live GitHub API search (stars:>100, 10 results) for projects not yet in the catalog
- **Features:** autocomplete, "did you mean?" suggestions, trending queries, recent searches, match badges, similar projects
- **Architecture:** Dedicated search page (separate from landing hero), results in own grid (`#search-result-grid`)

---

## Direction 2: AI Project Radar (Trend Tracking)
Track momentum over time — stars, forks, commit activity. Surface rising, trending, and declining projects.

- Store historical star/fork snapshots in Firestore
- Compute week-over-week momentum scores
- Add "Trending", "Rising", "Hot this week" filters to the UI
- Let users subscribe to category alerts

---

## Direction 3: Weekly AI Digest Newsletter
Package the best discoveries of the week into a curated newsletter with commentary.

- Already have daily scrape pipeline — aggregate into weekly picks
- Write short editorial blurbs per project (Gemini-assisted)
- Publish via Substack or email
- Build a subscriber audience

---

## Direction 4: "Deploy This" One-Click Templates
For each featured project, add a one-click deploy button (Railway, Render, Vercel, etc.).

- Detect project type (Node, Python, Docker, etc.) from repo metadata
- Map to appropriate hosting platform
- Lower the barrier from "discovery" to "running it"

---

## Direction 5: Contributor Matchmaking
Connect developers who want to contribute with projects that need help.

- Add "looking for contributors" tag to projects
- Let devs filter by language, skill, or project type
- Optional: notify project owners when someone expresses interest

---

## Notes
- Direction 1 is shipped — semantic search is live with dedicated search page
- Direction 2 is the strongest near-term bet — data pipeline already exists
- Direction 3 is low effort, high compounding value (audience building)
- Directions 4 + 5 require more UX thinking and potentially owner opt-in
- Inspiration: openclaw.ai (active utility vs passive browsing)
