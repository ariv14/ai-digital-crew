# AI Digital Crew — Architecture Document

> **Domain:** [aidigitalcrew.com](https://aidigitalcrew.com)
> **Last updated:** 2026-02-19 | **Version:** 1.0.0

---

## 1. System Overview

AI Digital Crew is a community-driven showcase for AI-powered open-source GitHub projects. Users authenticate via OAuth, submit repositories, and browse curated projects. A daily automation pipeline discovers trending repos, generates AI summaries, and publishes a newsletter.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USERS (Browser)                             │
│                                                                     │
│   index.html (Single-file Vanilla JS SPA — no build step)          │
│   ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌──────────────────┐ │
│   │ Auth UI  │  │ Submit   │  │ Project   │  │ Featured "Pick   │ │
│   │ (OAuth)  │  │ Modal    │  │ Grid      │  │  of the Day"     │ │
│   └────┬─────┘  └────┬─────┘  └─────┬─────┘  └───────┬──────────┘ │
└────────┼─────────────┼───────────────┼────────────────┼─────────────┘
         │             │               │                │
         ▼             ▼               ▼                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        FIREBASE                                     │
│   ┌──────────────────┐   ┌────────────────────────────────────┐    │
│   │   Auth            │   │   Firestore                        │    │
│   │ - GitHub OAuth    │   │   projects/ collection             │    │
│   │ - Google OAuth    │   │   (public read, auth write)        │    │
│   │ - Apple OAuth     │   │                                    │    │
│   └──────────────────┘   └────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
         │                             ▲
         │                             │ writes
         │         ┌───────────────────┘
         │         │
┌────────┼─────────┼──────────────────────────────────────────────────┐
│        │  DAILY AUTOMATION PIPELINE (GitHub Actions cron)           │
│        │         │                                                  │
│  ┌─────▼─────────┴───────┐                                         │
│  │   daily-scrape.js     │                                         │
│  │                       │                                         │
│  │  1. Search GitHub API ─────────────► GitHub REST API            │
│  │  2. Fetch README      ─────────────► GitHub REST API            │
│  │  3. Generate writeup  ─────────────► Google Gemini 2.5 Flash    │
│  │  4. Write to Firestore│                                         │
│  │  5. Notify repo owner ─────────────► GitHub Issues API          │
│  │  6. Publish newsletter│                                         │
│  │         │              │                                         │
│  └─────────┼──────────────┘                                         │
│            ▼                                                        │
│  ┌─────────────────────┐     ┌──────────────────┐                  │
│  │ substack-publish.js │────►│ Pipedream        │                  │
│  │ (build payload)     │     │ (webhook proxy)  │                  │
│  └─────────────────────┘     └────────┬─────────┘                  │
│                                       │                             │
│                                       ▼                             │
│                              ┌──────────────────┐                  │
│                              │ Substack API     │                  │
│                              │ (draft + publish)│                  │
│                              └──────────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | Vanilla JS + HTML + CSS | Single-file SPA (`index.html`), no framework, no build step |
| Hosting | GitHub Pages | Auto-deploys on push to `main` via GitHub Actions |
| Auth | Firebase Auth v10.12 | GitHub, Google, Apple OAuth providers |
| Database | Cloud Firestore | Single `projects` collection |
| Automation | GitHub Actions | Cron job (`daily-scrape.yml`) at 6 AM UTC |
| AI Content | Google Gemini 2.5 Flash | Generates project writeups + quick-start guides |
| Newsletter | Substack | Published via Pipedream webhook bridge |
| Webhook Proxy | Pipedream | Bypasses Cloudflare restrictions on Substack API |
| Icons | Lucide Icons (CDN) | SVG icon library |
| Fonts | Google Fonts | Inter (body), Space Grotesk (headings) |
| Animations | canvas-confetti (CDN) | Submission success animation |

---

## 3. External Services

### 3.1 Firebase

- **Project ID:** `ai-digital-crew`
- **Auth domain:** `ai-digital-crew.firebaseapp.com`
- **Services used:** Authentication, Cloud Firestore
- **Frontend SDK:** Firebase JS SDK v10.12.0 (loaded via CDN)
- **Backend SDK:** `firebase-admin ^12.0.0` (used in daily scrape)

### 3.2 GitHub REST API

| Endpoint | Used By | Purpose |
|----------|---------|---------|
| `GET /repos/{owner}/{repo}` | Frontend + scraper | Fetch repo metadata, live stats |
| `GET /search/repositories` | Scraper | Discover trending AI repos |
| `GET /repos/{owner}/{repo}/readme` | Scraper | Raw README for AI summarization |
| `POST /repos/{owner}/{repo}/issues` | Scraper | Notify owners of featured projects |

### 3.3 Google Gemini

- **Model:** `gemini-2.5-flash`
- **SDK:** `@google/generative-ai ^0.21.0`
- **Input:** Repo metadata + README (max 4000 chars)
- **Output:** JSON `{ writeup: string, quickStart: string[] }`

### 3.4 Pipedream

- **Role:** Webhook proxy between GitHub Actions and Substack API
- **Why needed:** Substack API sits behind Cloudflare; Pipedream runs from trusted IPs
- **Flow:** `daily-scrape.js` → POST payload → Pipedream webhook → Substack draft → publish
- **Pipedream script:** `pipenode.txt` (creates draft via `/api/v1/drafts`, publishes via `/api/v1/drafts/{id}/publish`)

### 3.5 Substack

- **Publication:** `aidigitalcrew.substack.com`
- **Post format:** ProseMirror JSON (rich text)
- **Auth:** Session cookie (`substack.sid`) stored in Pipedream environment
- **Audience:** Public posts sent to all subscribers + email

---

## 4. Data Model

### 4.1 Firestore Collection: `projects`

```
projects/{projectId}
├── fullName: string          # "owner/repo" (unique identifier, used for dedup)
├── name: string              # repo name
├── owner: string             # GitHub username
├── ownerAvatar: string       # avatar URL
├── description: string       # GitHub repo description
├── stars: number             # stargazers_count
├── forks: number             # forks_count
├── language: string          # primary language
├── topics: string[]          # GitHub topics array
├── url: string               # GitHub html_url
├── submittedBy: string       # Firebase UID or "auto"
├── submittedByName: string   # display name or "AI Digital Crew Bot"
├── createdAt: timestamp      # server timestamp
├── source: string            # "user" | "auto"
├── category: string          # inferred from topics
│
│  (Auto-featured projects only)
├── writeup: string           # Gemini-generated summary
├── quickStart: string[]      # Gemini-generated steps
└── autoAddedDate: string     # "YYYY-MM-DD"
```

### 4.2 Security Rules

```
projects: public read, authenticated create only
```

No update/delete rules exposed — defaults to deny. Daily bot writes via Firebase Admin SDK (bypasses rules).

---

## 5. Data Flows

### 5.1 User Submission

```
User → OAuth Login → Enter GitHub URL
  → Debounce 600ms → GET /repos/{owner}/{repo} → Preview card
  → Submit → Query Firestore (dedup check by fullName)
  → Write to Firestore → Confetti + success toast → Re-render grid
```

### 5.2 Daily "Project of the Day" Pipeline

```
GitHub Actions cron (6 AM UTC)
  │
  ├─ 1. Search GitHub API
  │     For each topic in CATEGORY_TOPICS:
  │       query: "topic:{t} created:>7daysAgo stars:>30"
  │     Merge, dedup, sort by stars desc
  │
  ├─ 2. Find new repo (not already in Firestore)
  │     Loop candidates, query Firestore WHERE fullName == candidate
  │     Pick first unmatched repo
  │
  ├─ 3. Fetch README (raw, truncate to 4000 chars)
  │
  ├─ 4. Generate writeup via Gemini 2.5 Flash
  │     Input: metadata + README → Output: { writeup, quickStart }
  │
  ├─ 5. Write to Firestore (source: "auto", submittedBy: "auto")
  │
  ├─ 6. Notify repo owner via GitHub Issue
  │     "Your project was featured on AI Digital Crew"
  │
  └─ 7. Publish to Substack
        substack-publish.js → Build ProseMirror payload
          → POST to Pipedream webhook
          → Pipedream: create draft + publish
          → Return published post URL
```

### 5.3 Page Load & Display

```
Browser loads index.html
  → Firebase Auth state listener fires
  → Firestore query: get all projects
  → For each project: fetch live stats from GitHub API (parallel)
  → Merge live stats with stored data (writeup, quickStart preserved)
  → Infer categories from topics
  → Render grid with category filter tabs
  → Intersection Observer animates cards on scroll
```

---

## 6. Authentication

### 6.1 Providers

| Provider | Firebase Class | Notes |
|----------|---------------|-------|
| GitHub | `GithubAuthProvider()` | Primary, aligns with project theme |
| Google | `GoogleAuthProvider()` | Broad reach fallback |
| Apple | `OAuthProvider('apple.com')` | iOS/Safari users |

### 6.2 Account Linking

When a user signs in with Provider A but the email already exists on Provider B:

1. `signInWithPopup()` throws `auth/account-exists-with-different-credential`
2. Store pending credential in `state.pendingLinkCred`
3. Prompt user to sign in with existing provider
4. On success, call `linkWithCredential()` to merge accounts

### 6.3 Account Deletion

1. Confirmation dialog
2. Delete all user's projects from Firestore (`WHERE submittedBy == uid`)
3. `deleteUser(auth.currentUser)`
4. Handle `auth/requires-recent-login` by prompting re-auth

---

## 7. Frontend Architecture

### 7.1 State Management

Single global object — all UI updates flow from state mutations:

```js
state = {
  user,             // FirebaseUser | null
  isLoggedIn,       // boolean
  projects,         // array of project objects
  isLoading,        // boolean
  repoPreview,      // temp preview data during submission
  activeCategory,   // current filter tab
  pendingLinkCred,  // for OAuth account linking
  pendingLinkProvider
}
```

### 7.2 Key UI Sections

| Section | Description |
|---------|-------------|
| Navbar | Sticky, blur-on-scroll, avatar dropdown, mobile hamburger |
| Hero | Headline, CTA, animated stats pills (project count, total stars) |
| Featured | "Today's Pick" spotlight card with writeup + quick start |
| Project Grid | 3-col responsive grid, category filter tabs, lazy animation |
| Submit Modal | URL input → debounced preview → submit |
| Login Modal | OAuth provider buttons (GitHub, Google, Apple) |
| Footer | About, newsletter CTA (Substack link), social links |

### 7.3 Key Patterns

- **`esc()`** — HTML escape helper, prevents XSS in all dynamic content
- **Intersection Observer** — lazy-animates project cards on scroll
- **Event delegation** — handles clicks on dynamically rendered cards
- **600ms debounce** — on GitHub URL input for preview fetching
- **`Promise.all`** — parallel GitHub API fetches for live stats

### 7.4 Category System

Categories are inferred from GitHub topics at render time:

```
AI Agents, LLM / GenAI, Data Science, Big Data, DevTools,
Web / Frontend, Backend / APIs, Mobile, Security,
Cloud / Infra, Blockchain / Web3, Database, Other
```

Only categories with matching projects appear as filter tabs.

---

## 8. Deployment & CI/CD

### 8.1 Web Hosting

- **Provider:** GitHub Pages (auto-deploys on push to `main`)
- **Domain:** `aidigitalcrew.com` (via CNAME)
- **No build step** — `index.html` is the deployed artifact

### 8.2 Firestore Rules

Deployed manually only when `firestore.rules` changes:

```bash
firebase deploy --only firestore:rules --project ai-digital-crew
```

### 8.3 GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `daily-scrape.yml` | Cron `0 6 * * *` + manual | Daily project discovery + newsletter |

### 8.4 Environment Variables (GitHub Secrets)

| Secret | Used By | Purpose |
|--------|---------|---------|
| `FIREBASE_SERVICE_ACCOUNT` | daily-scrape.js | Admin Firestore access |
| `GITHUB_TOKEN` | daily-scrape.js | Search repos, fetch README |
| `NOTIFY_TOKEN` | daily-scrape.js | Create GitHub issues (owner notification) |
| `GEMINI_API_KEY` | daily-scrape.js | AI writeup generation |
| `PIPEDREAM_WEBHOOK_URL` | substack-publish.js | Trigger Substack publication |

---

## 9. Security

### 9.1 Frontend

- All dynamic content escaped via `esc()` helper (XSS prevention)
- GitHub URL validated via regex before API call
- Firebase config is public (safe by design — security enforced by rules)

### 9.2 Firestore Rules

- Public read on `projects` — intentional, it's a public showcase
- Authenticated create only — prevents anonymous spam
- No update/delete — users cannot modify or remove submissions via client
- Admin operations (daily bot) use Firebase Admin SDK (bypasses rules)

### 9.3 HTTP Headers (`_headers`)

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

Static assets cached for 7 days (`Cache-Control: public, max-age=604800`).

### 9.4 `.gitignore` Protection

Prevents accidental commit of secrets and vendor files:

| Pattern | Protects Against |
|---------|-----------------|
| `ai-digital-crew-firebase-adminsdk-*.json` | Firebase Admin SDK service account keys |
| `scripts/node_modules/` | Vendor dependencies |
| `.env` / `.env.*` | Environment variable files |
| `.DS_Store`, `Thumbs.db` | OS artifacts |
| `.idea/`, `.vscode/`, `*.swp` | Editor artifacts |

### 9.5 API Key Hardening (Cloud Console)

The Firebase Web API key in `index.html` is public by design but should be restricted:

- **Application restrictions:** HTTP referrers limited to `aidigitalcrew.com/*` and `localhost/*`
- **API restrictions:** Only Identity Toolkit API, Cloud Firestore API, Firebase Auth API

---

## 10. Project Structure

```
ai-digital-crew/
├── index.html                  # Entire SPA (HTML + CSS + JS)
├── firebase.json               # Firebase project config
├── firestore.rules             # Firestore security rules
├── _headers                    # HTTP security headers
├── CNAME                       # Custom domain: aidigitalcrew.com
├── CLAUDE.md                   # AI assistant project guidelines
├── ROADMAP.md                  # Future feature directions
├── ARCHITECTURE.md             # This file
├── .gitignore                  # Protects secrets & vendor files from commit
│
├── scripts/
│   ├── daily-scrape.js         # Daily pipeline orchestrator
│   ├── substack-publish.js     # Pipedream/Substack payload builder
│   ├── package.json            # Node deps (firebase-admin, generative-ai)
│   └── package-lock.json
│
├── .github/
│   └── workflows/
│       └── daily-scrape.yml    # Cron + manual trigger
│
└── pipenode.txt                # Pipedream script (Substack API calls)
```

---

## Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2026-02-19 | 1.0.0 | Initial architecture document |
| 2026-02-20 | 1.1.0 | Added `.gitignore`, API key hardening, security sections 9.4–9.5 |
