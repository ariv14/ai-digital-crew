# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AI Digital Crew** (`aidigitalcrew.com`) is a community showcase for AI-powered GitHub projects. Users authenticate via OAuth, submit GitHub repositories, and browse curated projects.

## Architecture

> **Full details:** See [ARCHITECTURE.md](./ARCHITECTURE.md) for system diagrams, data flows, external services, error handling, security model, and observability.

This is a **single-file vanilla JS SPA** — all source code lives in `index.html`. There is no build step and no framework. Changes to `index.html` are the deployed changes. The `scripts/` directory contains a Node.js automation pipeline (daily scrape + Substack newsletter) with its own `package.json`.

**Backend:** Firebase (Auth + Firestore + Cloud Functions). Cloud Function `getQueryEmbedding` handles embedding generation for semantic search.

**Daily pipeline:** GitHub Actions cron → `daily-scrape.js` → GitHub API + Gemini AI + Firestore + Pipedream → Substack newsletter.

## Branching

- **`staging`** — default branch. All development happens here. Auto-deploys to `ai-digital-crew-staging.web.app` via Firebase Hosting.
- **`main`** — production branch. Auto-deploys to `aidigitalcrew.com` via GitHub Pages. Only merge from `staging` when changes are tested and ready.

## Deployment

```bash
# Deploy Cloud Functions to production / staging
firebase deploy --only functions --project ai-digital-crew
firebase deploy --only functions --project ai-digital-crew-staging

# Deploy Firestore rules to production / staging
firebase deploy --only firestore:rules --project ai-digital-crew
firebase deploy --only firestore:rules --project ai-digital-crew-staging
```

There is no dev server. Open `index.html` directly in a browser for local testing (connects to staging Firebase), or use:
```bash
firebase serve
```

## Key File Map

| File | Purpose |
|------|---------|
| `index.html` | Entire application (HTML + CSS + JS in one file) |
| `firebase.json` | Firebase hosting + functions + Firestore config |
| `firestore.rules` | Firestore security rules |
| `_headers` | HTTP security headers (CSP, cache, etc.) |
| `ARCHITECTURE.md` | Full system architecture, data flows, security, observability |
| `ROADMAP.md` | Future feature directions |
| `.gitignore` | Protects secrets & vendor files from accidental commit |
| `functions/index.js` | Cloud Function: `getQueryEmbedding` (Gemini + Cloudflare fallback) |
| `functions/package.json` | Cloud Functions dependencies |
| `scripts/daily-scrape.js` | Daily pipeline orchestrator (GitHub → Gemini → Firestore → Substack) |
| `scripts/substack-publish.js` | Builds ProseMirror payload, POSTs to Pipedream webhook |
| `scripts/embedding-provider.js` | Shared embedding logic for backfill script |
| `scripts/backfill-embeddings.js` | One-time script to generate embeddings for existing projects |
| `pipenode.txt` | Pipedream script for Substack API calls (runs on Pipedream, not in CI) |

## Application Architecture (inside index.html)

**State management:** Single `state` object — `{ user, isLoggedIn, projects, isLoading, repoPreview, currentView, searchQuery, searchResults, isSearching, githubResults, searchCache, githubResultsCache }`. All UI updates flow from state mutations.

**Navigation:** Two views controlled by `navigateTo(view)` — `home` (hero + featured + projects) and `search` (dedicated search page). Toggled via nav links.

**Firestore collections:**
- `projects/` — submitted repos. Fields: `fullName`, `name`, `owner`, `ownerAvatar`, `description`, `stars`, `forks`, `language`, `topics`, `url`, `submittedBy` (uid), `submittedByName`, `createdAt`, `embedding_gemini`, `embedding_cloudflare`
- `searchCache/` — cached query embeddings (24h TTL, written by Cloud Functions only)
- `searchAnalytics/` — search query logs (authenticated write-only)

**Auth flow:** OAuth (GitHub / Google / Facebook) → account linking if email collision → account deletion removes user + their projects.

**GitHub API:** `GET /repos/{owner}/{repo}` — called on URL input (600ms debounce) to preview repo metadata before submission.

**Search system:** Hybrid keyword (Fuse.js) + semantic (embeddings via Cloud Function) search. GitHub discovery fetches live results from GitHub API (stars:>100, 10 per page). Dedicated search page with autocomplete, trending pills, match badges, and similar projects.

**Key JS patterns in the file:**
- `esc()` — HTML escape helper, used everywhere to prevent XSS
- `navigateTo(view)` — toggles between home and search views
- Intersection Observer — lazy-animates project cards on scroll
- `Promise.all` — parallel GitHub API fetches
- Event delegation — used for dynamically rendered project cards
- `handleSearch()` — orchestrates intent classification, keyword + semantic scoring, and result rendering

## Firestore Rules Summary

- `projects`: public read, authenticated create only
- `searchCache`: public read, no client write (Cloud Functions only via Admin SDK)
- `searchAnalytics`: authenticated create/update, no read
- Duplicate detection: query by `fullName` before insert
- User's projects: query by `submittedBy == uid`
