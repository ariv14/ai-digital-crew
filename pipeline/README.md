# Daily POTD pipeline — CF Worker cron → Pipedream scraper

Replaces the GitHub Actions cron runner (blocked by the account-level `$0`
Actions budget that cannot be removed without a payment method on file).

## Architecture

```
Cloudflare Worker (cron: 0 8 * * *)
  └─ POST → Pipedream webhook (daily-scrape workflow)
       └─ runs pipedream-daily-scrape.js
            ├─ GitHub search + README fetch
            ├─ Gemini writeup + embeddings
            ├─ Firestore writes (projects, snapshots, projectsCache, embeddingsCache)
            ├─ GitHub issue on POTD repo (owner notification)
            └─ POST → Pipedream webhook (existing Substack publisher)
```

The existing Substack publisher Pipedream workflow (`pipenode.txt` source) stays
as-is — the new scraper calls it the same way the old `scripts/daily-scrape.js`
did via `PIPEDREAM_WEBHOOK_URL`.

## Files

| Path | Purpose |
|---|---|
| `pipedream-daily-scrape.js` | Paste into a new Pipedream HTTP-triggered workflow as a single Node.js step. |
| `cf-worker/wrangler.toml` | Cron trigger config (`0 8 * * *`). |
| `cf-worker/src/worker.ts` | Scheduled handler; POSTs to Pipedream webhook. Also exposes `POST /run` for manual dispatch. |

## One-time setup

### 1. Create the Pipedream scraper workflow

1. Pipedream → **New workflow** → choose **HTTP / Webhook** as trigger.
2. Delete the default trigger response step; set the trigger's "HTTP response"
   to **Return a custom response** (or the workflow will wait for the whole
   ~5 min scraper to finish before responding to Cloudflare — fine but wastes
   the Worker's time).
3. Add a **Run Node.js code** step. Paste the entire contents of
   `pipedream-daily-scrape.js` into it.
4. In the workflow's **Environment Variables** tab, set:

   | Var | Value |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT` | The full JSON contents of `ai-digital-crew-firebase-adminsdk-*.json` |
   | `GITHUB_TOKEN` | GitHub PAT, `public_repo` scope |
   | `GEMINI_API_KEY` | Google AI Studio key |
   | `PIPEDREAM_WEBHOOK_URL` | The webhook URL of the **existing** Substack publisher workflow |
   | `NOTIFY_TOKEN` | (optional) separate GitHub PAT for owner-notify issues |
   | `CLOUDFLARE_ACCOUNT_ID` | (optional) for fallback embeddings |
   | `CLOUDFLARE_API_TOKEN` | (optional) for fallback embeddings |
   | `CRON_SHARED_SECRET` | Random string — also set on the Worker (below) |
   | `SKIP_PUBLISH` | (optional) `true` to skip Substack publish |
   | `SKIP_NOTIFY` | (optional) `true` to skip owner notification issue |

   These are the exact same vars that were on GitHub Actions. `CRON_SHARED_SECRET`
   is new — generate with `openssl rand -hex 32`.
5. Deploy the workflow. Copy the trigger's webhook URL (e.g.
   `https://eoxxxx.m.pipedream.net`).
6. Sanity test: `curl -X POST <webhook> -H 'X-Cron-Secret: <secret>'` —
   should kick off a run visible in Pipedream's "Event History".

### 2. Deploy the Cloudflare Worker

From `pipeline/cf-worker/`:

```bash
npm install
npx wrangler login                                    # one-time
npx wrangler secret put PIPEDREAM_SCRAPE_WEBHOOK_URL  # paste URL from step 1.5
npx wrangler secret put CRON_SHARED_SECRET            # paste the same secret from step 1.4
npx wrangler deploy
```

That's it. Wrangler will show the cron schedule it registered (`0 8 * * *` UTC).

### 3. Verify end-to-end

- **Manual dispatch** via the Worker's `/run` endpoint:
  ```bash
  curl -X POST https://aidc-cron-trigger.<your-cf-subdomain>.workers.dev/run \
    -H "X-Cron-Secret: <secret>"
  ```
  Expect a `200` with the Pipedream response body, and a new run in Pipedream.
- **Scheduled dispatch**: wait for 08:00 UTC or use Cloudflare's dashboard
  → Workers → your worker → **Triggers** → **Run trigger** button.
- Check the site at https://aidigitalcrew.com the next morning — the homepage
  should have today's new POTD and `projectsCache/home.updatedAt` should be fresh.

## Shutdown of the old Actions runner

Once the above is working:
- The `.github/workflows/daily-scrape.yml` and `daily-scrape-staging.yml`
  schedules have been removed in this PR. `workflow_dispatch` stays, so the
  workflow is still there as a break-glass fallback *if* the Actions budget
  is lifted later (i.e. a card is added to the GitHub account).

## Runtime budget

Pipedream free tier: 10k invocations/month, 750s step timeout. The scraper
historically ran in 2–5 min, well under the limit. Monitor the step duration
in Pipedream's "Event History" — if a run ever approaches 600s, split
`collectSnapshots` into a second workflow triggered at the end of the first.

## Monitoring

Pipedream sends email on step failure by default. If you want richer
monitoring, add a second step after the scraper that posts a summary to
Slack/Discord.

## Troubleshooting

| Symptom | Check |
|---|---|
| Worker logs "PIPEDREAM_SCRAPE_WEBHOOK_URL not set" | `npx wrangler secret list` — the secret is missing or on wrong env |
| Pipedream run errors "Unauthorized: X-Cron-Secret..." | Secrets on Worker and Pipedream don't match; re-put both |
| Firestore 1MB error (`projectsCache/home exceeds...`) | Same 1 MB cap as before; revisit trimming logic in `writeProjectsCache` |
| Gemini 429s in Pipedream logs | Retries are already wired (`callGeminiWithRetry`) — if persistent, rotate the key |
| Substack publish fails | Non-fatal by design; check the existing Substack Pipedream workflow's session cookie hasn't rotated |
