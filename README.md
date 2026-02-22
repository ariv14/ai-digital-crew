# AI Digital Crew

A community showcase for AI-powered GitHub projects. Browse, search, and submit repositories — all in one place.

**Live site:** [aidigitalcrew.com](https://aidigitalcrew.com)

## How to Use

1. **Browse** — Scroll the homepage to explore featured and community-submitted AI projects
2. **Search** — Use keyword, semantic, or GitHub discovery search to find projects by topic, description, or technology
3. **Submit a project** — Sign in with GitHub, Google, or Facebook → paste a GitHub repo URL → submit
4. **Explore trending** — Check out AI Trending, Global Trending, Gainers & Cooling, and Developers tabs
5. **Stay updated** — Subscribe to the [daily newsletter on Substack](https://aidigitalcrew.substack.com) for curated AI project highlights

## Tech Stack

- **Frontend:** Vanilla JS single-page app (no framework, no build step)
- **Backend:** Firebase (Auth, Firestore, Cloud Functions)
- **AI:** Gemini embeddings for semantic search
- **Hosting:** Cloudflare Pages (production + staging)
- **Pipeline:** GitHub Actions daily scrape → Gemini summarization → Substack newsletter

## Project Structure

| Path | What it does |
|------|-------------|
| `index.html` | The entire app — HTML, CSS, and JS in one file |
| `functions/` | Cloud Functions (embedding generation) |
| `scripts/` | Daily scrape + newsletter pipeline |
| `firebase.json` | Firebase hosting and functions config |
| `firestore.rules` | Firestore security rules |
| `_headers` | HTTP security headers (CSP, cache) |

## Local Development

No build step required. Either:

```bash
firebase serve
```

or open `index.html` directly in a browser (connects to staging Firebase by default on localhost).

## Links

- [Live site](https://aidigitalcrew.com)
- [Staging](https://staging.aidigitalcrew.com)
- [Architecture docs](./ARCHITECTURE.md)
- [Roadmap](./ROADMAP.md)
