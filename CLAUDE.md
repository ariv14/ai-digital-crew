# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**AI Digital Crew** (`aidigitalcrew.com`) is a community showcase for AI-powered GitHub projects. Users authenticate via OAuth, submit GitHub repositories, and browse curated projects.

## Architecture

> **Full details:** See [ARCHITECTURE.md](./ARCHITECTURE.md) for system diagrams, data flows, external services, error handling, security model, and observability.

This is a **single-file vanilla JS SPA** — all source code lives in `index.html`. There is no build step and no framework. Changes to `index.html` are the deployed changes. The `scripts/` directory contains a Node.js automation pipeline (daily scrape + Substack newsletter) with its own `package.json`.

**Backend:** Firebase (Auth + Firestore) — no server-side code in this repo.

**Daily pipeline:** GitHub Actions cron → `daily-scrape.js` → GitHub API + Gemini AI + Firestore + Pipedream → Substack newsletter.

## Branching

- **`staging`** — default branch. All development happens here. Auto-deploys to `ai-digital-crew-staging.web.app` via Firebase Hosting.
- **`main`** — production branch. Auto-deploys to `aidigitalcrew.com` via GitHub Pages. Only merge from `staging` when changes are tested and ready.

## Deployment

```bash
# Deploy Firestore rules to production
firebase deploy --only firestore:rules --project ai-digital-crew

# Deploy Firestore rules to staging
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
| `firebase.json` | Firebase hosting + Firestore config |
| `firestore.rules` | Firestore security rules |
| `_headers` | HTTP security headers (CSP, cache, etc.) |
| `ARCHITECTURE.md` | Full system architecture, data flows, security, observability |
| `ROADMAP.md` | Future feature directions |
| `.gitignore` | Protects secrets & vendor files from accidental commit |
| `scripts/daily-scrape.js` | Daily pipeline orchestrator (GitHub → Gemini → Firestore → Substack) |
| `scripts/substack-publish.js` | Builds ProseMirror payload, POSTs to Pipedream webhook |
| `pipenode.txt` | Pipedream script for Substack API calls (runs on Pipedream, not in CI) |

## Application Architecture (inside index.html)

**State management:** Single `state` object — `{ user, isLoggedIn, projects, isLoading, repoPreview }`. All UI updates flow from state mutations.

**Firestore collections:**
- `projects/` — submitted repos. Fields: `fullName`, `name`, `owner`, `ownerAvatar`, `description`, `stars`, `forks`, `language`, `topics`, `url`, `submittedBy` (uid), `submittedByName`, `createdAt`

**Auth flow:** OAuth (GitHub / Google / Apple) → account linking if email collision → account deletion removes user + their projects.

**GitHub API:** `GET /repos/{owner}/{repo}` — called on URL input (600ms debounce) to preview repo metadata before submission.

**Key JS patterns in the file:**
- `esc()` — HTML escape helper, used everywhere to prevent XSS
- Intersection Observer — lazy-animates project cards on scroll
- `Promise.all` — parallel GitHub API fetches
- Event delegation — used for dynamically rendered project cards

## Firestore Rules Summary

- `projects`: public read, authenticated write only
- Duplicate detection: query by `fullName` before insert
- User's projects: query by `submittedBy == uid`
