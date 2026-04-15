/**
 * pipedream-daily-scrape.js — Pipedream component for the daily POTD pipeline
 *
 * Paste this into a new Pipedream HTTP-triggered workflow as a single Node.js
 * code step. The Cloudflare Worker at pipeline/cf-worker/ POSTs to the
 * workflow's webhook URL on cron and that fires this step.
 *
 * This replaces the GitHub Actions cron runner (blocked by the account-level
 * $0 Actions budget that cannot be removed without a payment method).
 *
 * Ports three files into one component:
 *   - scripts/daily-scrape.js       (orchestration)
 *   - scripts/embedding-provider.js (Gemini + Cloudflare embeddings)
 *   - scripts/substack-publish.js   (ProseMirror + Pipedream substack webhook)
 *
 * Required Pipedream environment variables:
 *   FIREBASE_SERVICE_ACCOUNT  — JSON string of the Firebase Admin SDK key
 *   GITHUB_TOKEN              — GitHub PAT (public_repo scope)
 *   GEMINI_API_KEY            — Google AI Studio API key
 *   PIPEDREAM_WEBHOOK_URL     — URL of the existing Substack publisher workflow
 *   NOTIFY_TOKEN              — (optional) GitHub PAT for owner-notification issues
 *   CLOUDFLARE_ACCOUNT_ID     — (optional) for secondary embedding provider
 *   CLOUDFLARE_API_TOKEN      — (optional) for secondary embedding provider
 *   CRON_SHARED_SECRET        — (optional) shared secret to validate the CF Worker call
 *   SKIP_PUBLISH              — (optional) "true" to skip Substack publishing
 *   SKIP_NOTIFY               — (optional) "true" to skip owner issue
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';

export default defineComponent({
  async run({ steps, $ }) {
    // ── Optional shared-secret check from Cloudflare Worker ──────────────────
    const expectedSecret = process.env.CRON_SHARED_SECRET;
    if (expectedSecret) {
      const got = steps.trigger?.event?.headers?.['x-cron-secret']
        || steps.trigger?.event?.headers?.['X-Cron-Secret'];
      if (got !== expectedSecret) {
        throw new Error('Unauthorized: X-Cron-Secret missing or mismatched');
      }
    }

    // ── Config ─────────────────────────────────────────────────────────────
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const NOTIFY_TOKEN = process.env.NOTIFY_TOKEN;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
    const PIPEDREAM_WEBHOOK_URL = process.env.PIPEDREAM_WEBHOOK_URL;

    if (!GITHUB_TOKEN || !GEMINI_API_KEY || !FIREBASE_SERVICE_ACCOUNT) {
      throw new Error('Missing required env vars: GITHUB_TOKEN, GEMINI_API_KEY, FIREBASE_SERVICE_ACCOUNT');
    }

    const CATEGORY_TOPICS = {
      'AI Agents':         ['ai-agents', 'llm-agent', 'autonomous-agents', 'multi-agent', 'mcp', 'computer-use'],
      'LLM / GenAI':       ['llm', 'generative-ai', 'large-language-model', 'rag', 'fine-tuning', 'prompt-engineering'],
      'Data Science':      ['data-science', 'machine-learning', 'deep-learning', 'neural-network', 'mlops'],
      'Big Data':          ['big-data', 'data-engineering', 'data-pipeline', 'apache-spark', 'dbt', 'streaming'],
      'DevTools':          ['developer-tools', 'cli', 'devops', 'platform-engineering', 'observability'],
      'Web / Frontend':    ['react', 'nextjs', 'svelte', 'vue', 'typescript', 'tailwindcss', 'webassembly'],
      'Backend / APIs':    ['fastapi', 'rest-api', 'graphql', 'microservices', 'nodejs', 'grpc', 'api'],
      'Mobile':            ['react-native', 'flutter', 'ios', 'android', 'swift', 'kotlin'],
      'Security':          ['security', 'cybersecurity', 'privacy', 'zero-trust', 'pentesting', 'devsecops'],
      'Cloud / Infra':     ['kubernetes', 'docker', 'terraform', 'cloud-native', 'serverless', 'infrastructure'],
      'Blockchain / Web3': ['blockchain', 'web3', 'defi', 'smart-contracts', 'ethereum', 'solidity'],
      'Database':          ['postgresql', 'mongodb', 'redis', 'vector-database', 'sqlite', 'nosql'],
    };
    const MIN_STARS = 30;
    const README_MAX_CHARS = 4000;
    const TODAY = new Date().toISOString().slice(0, 10);

    const AI_TOPIC_GROUPS = [
      ['ai-agents', 'llm-agent', 'autonomous-agents', 'multi-agent'],
      ['mcp', 'computer-use', 'prompt-engineering', 'fine-tuning'],
      ['llm', 'generative-ai', 'large-language-model', 'rag'],
      ['machine-learning', 'deep-learning', 'neural-network', 'mlops'],
      ['stable-diffusion', 'diffusion', 'image-generation', 'text-generation'],
      ['langchain', 'huggingface', 'openai', 'chatgpt'],
      ['computer-vision', 'speech-recognition', 'nlp', 'reinforcement-learning'],
      ['ai', 'artificial-intelligence', 'pytorch', 'tensorflow'],
    ];

    const ghHeaders = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    // ── Embedding helpers (ported from embedding-provider.js) ──────────────
    const EMBEDDING_PROVIDERS = {
      gemini: {
        name: 'gemini',
        async generate(text) {
          const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
          const result = await model.embedContent(text);
          return result.embedding.values;
        },
      },
      cloudflare: {
        name: 'cloudflare',
        async generate(text) {
          const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
          const apiToken = process.env.CLOUDFLARE_API_TOKEN;
          if (!accountId || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN not set');
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-large-en-v1.5`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
              body: JSON.stringify({ text: [text] }),
            },
          );
          if (!res.ok) throw new Error(`Cloudflare AI error ${res.status}: ${await res.text()}`);
          const data = await res.json();
          if (!data.success) throw new Error(`Cloudflare AI error: ${JSON.stringify(data.errors)}`);
          return data.result.data[0];
        },
      },
    };

    async function generateAllEmbeddings(text) {
      const results = {};
      await Promise.all(Object.entries(EMBEDDING_PROVIDERS).map(async ([name, p]) => {
        try {
          results[`embedding_${name}`] = await p.generate(text);
        } catch (err) {
          console.warn(`Skipping ${name} embedding: ${err.message}`);
        }
      }));
      return results;
    }

    function projectToEmbeddingText(project) {
      return [
        project.name || '',
        project.description || '',
        project.writeup || '',
        (project.topics || []).join(' '),
        project.language || '',
        project.category || '',
      ].filter(Boolean).join('. ');
    }

    // ── GitHub helpers ─────────────────────────────────────────────────────
    const searchRateLimit = { remaining: 30, resetAt: 0 };

    async function waitForSearchQuota() {
      if (searchRateLimit.remaining < 3 && Date.now() / 1000 < searchRateLimit.resetAt) {
        const waitMs = (searchRateLimit.resetAt - Date.now() / 1000 + 2) * 1000;
        console.log(`Search rate limit low (${searchRateLimit.remaining}), waiting ${Math.round(waitMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    function updateSearchRateLimit(res) {
      const rem = res.headers.get('X-RateLimit-Remaining');
      const reset = res.headers.get('X-RateLimit-Reset');
      if (rem !== null) searchRateLimit.remaining = parseInt(rem, 10);
      if (reset !== null) searchRateLimit.resetAt = parseInt(reset, 10);
    }

    async function searchRepos(topic) {
      await waitForSearchQuota();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const q = `topic:${topic}+created:>${sevenDaysAgo}+stars:>${MIN_STARS}`;
      const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`;
      const res = await fetch(url, { headers: ghHeaders });
      updateSearchRateLimit(res);
      if (!res.ok) {
        console.warn(`GitHub search failed for topic ${topic}: ${res.status}`);
        return [];
      }
      return (await res.json()).items || [];
    }

    async function searchReposRaw(query, perPage = 100) {
      await waitForSearchQuota();
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}`;
      const res = await fetch(url, { headers: ghHeaders });
      updateSearchRateLimit(res);
      if (!res.ok) {
        if (res.status === 403 || res.status === 429) {
          const retryAfter = res.headers.get('Retry-After');
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (searchRateLimit.resetAt - Date.now() / 1000 + 2) * 1000;
          if (waitMs > 0 && waitMs < 120000) {
            await new Promise(r => setTimeout(r, waitMs));
            const res2 = await fetch(url, { headers: ghHeaders });
            updateSearchRateLimit(res2);
            if (res2.ok) return (await res2.json()).items || [];
          }
        }
        console.warn(`GitHub search failed (${res.status}): ${query.slice(0, 80)}...`);
        return [];
      }
      return (await res.json()).items || [];
    }

    async function fetchReadme(owner, repo) {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
        headers: { ...ghHeaders, Accept: 'application/vnd.github.raw' },
      });
      if (!res.ok) return '';
      return (await res.text()).slice(0, README_MAX_CHARS);
    }

    async function fetchRepoMeta(owner, repo) {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders });
      if (!res.ok) return null;
      return res.json();
    }

    // ── Snapshot / trend helpers ───────────────────────────────────────────
    const rateLimitState = { remaining: 5000, resetAt: 0 };

    async function fetchWithRateLimit(owner, repo) {
      if (rateLimitState.remaining < 100 && Date.now() / 1000 < rateLimitState.resetAt) {
        const waitMs = (rateLimitState.resetAt - Date.now() / 1000 + 2) * 1000;
        console.log(`Rate limit low (${rateLimitState.remaining}), waiting ${Math.round(waitMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders });
      rateLimitState.remaining = parseInt(res.headers.get('X-RateLimit-Remaining') || '5000', 10);
      rateLimitState.resetAt = parseInt(res.headers.get('X-RateLimit-Reset') || '0', 10);
      if (!res.ok) return null;
      return res.json();
    }

    function computeMomentum(snapshots) {
      if (snapshots.length < 2) return { trend_momentum: 0, trend_label: 'new' };
      const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
      const latest = sorted[sorted.length - 1];
      const weekAgo = sorted.length >= 7 ? sorted[sorted.length - 7] : sorted[0];

      const stars7d = latest.stars - weekAgo.stars;
      const forks7d = latest.forks - weekAgo.forks;
      const starsPct7d = weekAgo.stars > 0 ? (stars7d / weekAgo.stars) * 100 : 0;

      const yesterday = sorted.length >= 2 ? sorted[sorted.length - 2] : sorted[0];
      const stars1d = latest.stars - yesterday.stars;
      const starsPct1d = yesterday.stars > 0 ? (stars1d / yesterday.stars) * 100 : 0;
      const forks1d = latest.forks - yesterday.forks;

      const monthAgo = sorted.length >= 30 ? sorted[sorted.length - 30] : sorted[0];
      const stars30d = latest.stars - monthAgo.stars;
      const starsPct30d = monthAgo.stars > 0 ? (stars30d / monthAgo.stars) * 100 : 0;
      const forks30d = latest.forks - monthAgo.forks;

      const relGrowth = Math.min(100, (Math.log2(1 + Math.abs(starsPct7d)) / Math.log2(1 + 50)) * 100);
      const relScore = starsPct7d >= 0 ? relGrowth : -relGrowth;
      const absGrowth = Math.min(100, (Math.log10(1 + Math.abs(stars7d)) / Math.log10(1 + 1000)) * 100);
      const absScore = stars7d >= 0 ? absGrowth : -absGrowth;

      let accelScore = 50;
      if (sorted.length >= 4) {
        const mid = sorted.length >= 7 ? sorted[sorted.length - 4] : sorted[Math.floor(sorted.length / 2)];
        const recentRate = (latest.stars - mid.stars) / Math.max(1, sorted.length - sorted.indexOf(mid));
        const olderRate = (mid.stars - weekAgo.stars) / Math.max(1, sorted.indexOf(mid) - (sorted.length >= 7 ? sorted.length - 7 : 0));
        if (olderRate > 0) accelScore = Math.min(100, Math.max(0, 50 + (recentRate / olderRate - 1) * 50));
        else if (recentRate > 0) accelScore = 80;
      }

      const momentum = Math.max(0, Math.min(100, relScore * 0.50 + absScore * 0.30 + accelScore * 0.20));
      let label;
      if (momentum >= 75) label = 'hot';
      else if (momentum >= 45) label = 'rising';
      else if (momentum >= 15) label = 'steady';
      else label = 'declining';

      return {
        trend_stars7d: stars7d, trend_starsPct7d: Math.round(starsPct7d * 100) / 100, trend_forks7d: forks7d,
        trend_stars1d: stars1d, trend_starsPct1d: Math.round(starsPct1d * 100) / 100, trend_forks1d: forks1d,
        trend_stars30d: stars30d, trend_starsPct30d: Math.round(starsPct30d * 100) / 100, trend_forks30d: forks30d,
        trend_momentum: Math.round(momentum * 10) / 10,
        trend_label: label,
        trend_sparkline: sorted.slice(-7).map(s => s.stars),
        trend_sparkline30d: sorted.slice(-30).map(s => s.stars),
      };
    }

    async function collectSnapshots(db, allDocs) {
      console.log('Collecting daily snapshots for trend tracking...');
      console.log(`Processing ${allDocs.length} projects for snapshots`);
      const BATCH_SIZE = 30;
      const MAX_SNAPSHOTS = 31;
      let processed = 0, failed = 0;

      for (let i = 0; i < allDocs.length; i += BATCH_SIZE) {
        const batch = allDocs.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async (doc) => {
          const p = doc.data();
          const [owner, repo] = (p.fullName || '').split('/');
          if (!owner || !repo) return null;
          try {
            const ghData = await fetchWithRateLimit(owner, repo);
            if (!ghData) return null;
            const todaySnapshot = {
              date: TODAY,
              stars: ghData.stargazers_count || 0,
              forks: ghData.forks_count || 0,
              openIssues: ghData.open_issues_count || 0,
            };
            let snapshots = Array.isArray(p.snapshots) ? [...p.snapshots] : [];
            const todayIdx = snapshots.findIndex(s => s.date === TODAY);
            if (todayIdx >= 0) snapshots[todayIdx] = todaySnapshot;
            else snapshots.push(todaySnapshot);
            snapshots.sort((a, b) => a.date.localeCompare(b.date));
            if (snapshots.length > MAX_SNAPSHOTS) snapshots = snapshots.slice(-MAX_SNAPSHOTS);

            const trendFields = computeMomentum(snapshots);
            await doc.ref.update({
              snapshots,
              ...trendFields,
              stars: ghData.stargazers_count || p.stars,
              forks: ghData.forks_count || p.forks,
              trend_updatedAt: new Date(),
            });
            return true;
          } catch (err) {
            console.warn(`Snapshot failed for ${p.fullName}: ${err.message}`);
            return null;
          }
        }));
        processed += results.filter(Boolean).length;
        failed += results.filter(r => r === null).length;
        if (i + BATCH_SIZE < allDocs.length) await new Promise(r => setTimeout(r, 1000));
      }
      console.log(`Snapshots complete: ${processed} updated, ${failed} failed`);
    }

    // ── Cache writers ──────────────────────────────────────────────────────
    const HOME_FIELDS = [
      'fullName', 'name', 'owner', 'ownerAvatar', 'description',
      'stars', 'forks', 'language', 'topics', 'url', 'category', 'source', 'autoAddedDate',
      'submittedBy', 'createdAt',
    ];
    const TREND_FIELDS = [
      'trend_momentum', 'trend_label', 'trend_stars7d', 'trend_starsPct7d', 'trend_forks7d',
      'trend_stars1d', 'trend_starsPct1d', 'trend_forks1d',
      'trend_stars30d', 'trend_starsPct30d', 'trend_forks30d',
      'trend_sparkline', 'trend_sparkline30d', 'trend_updatedAt',
    ];
    const MAX_CACHE_BYTES = 1_048_576;

    async function writeProjectsCache(db, allDocs, expectedFullName) {
      if (expectedFullName) {
        const found = allDocs.some(d => d.data().fullName === expectedFullName);
        if (!found) throw new Error(`Consistency error: expected project ${expectedFullName} not found in allDocs`);
      }

      const now = new Date().toISOString();
      console.log('Writing projectsCache/home...');
      const projectMap = new Map();
      const homeProjects = allDocs.map(d => {
        const raw = d.data();
        const obj = {};
        for (const key of HOME_FIELDS) {
          if (raw[key] === undefined) continue;
          if (raw[key] && typeof raw[key].toDate === 'function') obj[key] = raw[key].toDate().toISOString();
          else obj[key] = raw[key];
        }
        projectMap.set(raw.fullName, { obj, raw });
        return obj;
      });

      const homePayload = { projects: homeProjects, updatedAt: now };
      const homeBytes = Buffer.byteLength(JSON.stringify(homePayload), 'utf8');
      console.log(`projectsCache/home payload: ${homeBytes} bytes (${homeProjects.length} projects)`);
      if (homeBytes > MAX_CACHE_BYTES) throw new Error(`projectsCache/home exceeds Firestore 1MB limit: ${homeBytes} bytes`);
      await db.collection('projectsCache').doc('home').set(homePayload);
      console.log(`projectsCache/home written (${homeBytes} bytes)`);

      console.log('Writing projectsCache/trending...');
      const trendData = {};
      for (const d of allDocs) {
        const raw = d.data();
        if (!raw.fullName) continue;
        const tObj = {};
        let hasTrend = false;
        for (const key of TREND_FIELDS) {
          if (raw[key] === undefined) continue;
          if (raw[key] && typeof raw[key].toDate === 'function') tObj[key] = raw[key].toDate().toISOString();
          else tObj[key] = raw[key];
          hasTrend = true;
        }
        if (hasTrend) trendData[raw.fullName] = tObj;
      }
      const trendJson = JSON.stringify(trendData);
      const trendPayload = { json: trendJson, updatedAt: now };
      const trendBytes = Buffer.byteLength(JSON.stringify(trendPayload), 'utf8');
      console.log(`projectsCache/trending payload: ${trendBytes} bytes (${Object.keys(trendData).length} entries)`);
      if (trendBytes > MAX_CACHE_BYTES) throw new Error(`projectsCache/trending exceeds Firestore 1MB limit: ${trendBytes} bytes`);
      await db.collection('projectsCache').doc('trending').set(trendPayload);
      console.log(`projectsCache/trending written (${trendBytes} bytes)`);

      const cutoff = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const dailyPicks = [];
      for (const d of allDocs) {
        const raw = d.data();
        if (raw.source === 'auto' && (raw.autoAddedDate || '') >= cutoff) {
          const createdAt = raw.createdAt?.toDate?.() || new Date(raw.createdAt || 0);
          dailyPicks.push({ fullName: raw.fullName, date: raw.autoAddedDate || '', createdAt });
        }
      }
      dailyPicks.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt - a.createdAt));

      if (dailyPicks.length > 0) {
        const topPick = dailyPicks[0];
        const topEntry = projectMap.get(topPick.fullName);
        if (topEntry && topEntry.raw.writeup) {
          await db.collection('projectsCache').doc('featured').set({
            fullName: topPick.fullName,
            writeup: topEntry.raw.writeup,
            quickStart: topEntry.raw.quickStart || [],
            updatedAt: now,
          });
          console.log(`projectsCache/featured written for ${topPick.fullName}`);
        } else {
          console.log(`No writeup found for top pick ${topPick.fullName} — skipping featured doc`);
        }
      }
    }

    async function writeEmbeddingsCache(db, allDocs) {
      console.log('Writing embeddingsCache...');
      const entries = [];
      for (const doc of allDocs) {
        const p = doc.data();
        if (p.fullName && p.embedding_gemini) entries.push({ fullName: p.fullName, embedding: p.embedding_gemini });
      }
      if (entries.length === 0) {
        console.log('No embeddings to cache');
        return;
      }
      const CHUNK_SIZE = 30;
      const chunks = [];
      for (let i = 0; i < entries.length; i += CHUNK_SIZE) chunks.push(entries.slice(i, i + CHUNK_SIZE));

      for (let i = 0; i < chunks.length; i++) {
        await db.collection('embeddingsCache').doc(`part${i}`).set({
          entries: chunks[i],
          updatedAt: new Date().toISOString(),
        });
      }
      await db.collection('embeddingsCache').doc('meta').set({
        partCount: chunks.length,
        totalProjects: entries.length,
        updatedAt: new Date().toISOString(),
      });
      console.log(`embeddingsCache written: ${chunks.length} parts, ${entries.length} projects`);
    }

    // ── Firestore ──────────────────────────────────────────────────────────
    function initFirestore() {
      const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
      // Guard against Pipedream reusing the Node process across runs
      if (getApps().length === 0) initializeApp({ credential: cert(serviceAccount) });
      return getFirestore();
    }

    // ── Gemini writeup ─────────────────────────────────────────────────────
    async function callGeminiWithRetry(model, prompt) {
      const MAX_ATTEMPTS = 4;
      let lastErr;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          return await model.generateContent(prompt);
        } catch (err) {
          lastErr = err;
          const status = err?.status;
          const transient = status === 429 || (status >= 500 && status <= 599);
          if (!transient || attempt === MAX_ATTEMPTS) throw err;
          const waitMs = Math.min(30000, 2000 * Math.pow(2, attempt - 1));
          console.warn(`Gemini attempt ${attempt}/${MAX_ATTEMPTS} failed (${status} ${err?.statusText || ''}) — retrying in ${waitMs / 1000}s...`);
          await new Promise(r => setTimeout(r, waitMs));
        }
      }
      throw lastErr;
    }

    async function generateWriteup(repoMeta, readme) {
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const prompt = `You are a technical writer for AI developers. Given a GitHub repository, produce a JSON response with exactly two fields:
- "writeup": A detailed 3-4 paragraph writeup for AI developers. Paragraph 1: What the project does, its core value proposition, and the problem it solves. Paragraph 2: Key technical features, architecture highlights, and what makes it unique compared to alternatives. Paragraph 3: Real-world use cases, who benefits most, and community traction (stars, contributors). Paragraph 4 (optional): Notable integrations, roadmap highlights, or why it matters for the AI ecosystem. Separate each paragraph with two newlines (\\n\\n). Write in an engaging, informative tone — not generic marketing fluff.
- "quickStart": array of 3-5 strings, each a concise step to get started (install, configure, run)

Repository name: ${repoMeta.full_name}
Description: ${repoMeta.description || 'No description'}
Stars: ${repoMeta.stargazers_count}
Language: ${repoMeta.language || 'Unknown'}
Topics: ${(repoMeta.topics || []).join(', ') || 'none'}
README (truncated):
${readme}

Respond with ONLY valid JSON, no markdown fences, no extra text.`;

      const result = await callGeminiWithRetry(model, prompt);
      const text = result.response.text().trim();
      const jsonText = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      try {
        const parsed = JSON.parse(jsonText);
        if (typeof parsed.writeup !== 'string' || !Array.isArray(parsed.quickStart)) throw new Error('Unexpected JSON shape');
        return parsed;
      } catch (e) {
        console.error('Failed to parse Gemini response:', text);
        throw e;
      }
    }

    // ── Owner notification ─────────────────────────────────────────────────
    async function notifyOwner(owner, repo) {
      const body = [
        `Hi @${owner} 👋`,
        '',
        `I wanted to personally let you know — **${repo}** was hand-picked as today's **Project of the Day** by [AI Digital Crew](https://aidigitalcrew.com).`,
        '',
        'We think what you\'ve built is genuinely cool and worth sharing with the community.',
        '',
        '**Here\'s what we did:**',
        `- ✨ Featured it on [aidigitalcrew.com](https://aidigitalcrew.com) with an AI-generated writeup and Quick Start guide`,
        `- 📬 Sent a newsletter post to our subscribers at [aidigitalcrew.substack.com](https://aidigitalcrew.substack.com)`,
        `- 🤖 Added a "Daily Pick" badge to your project card on the showcase`,
        '',
        '**Want to be removed?**',
        'No problem at all — just reply here or email [newsletter@aidigitalcrew.com](mailto:newsletter@aidigitalcrew.com) and we\'ll take it down immediately, no questions asked.',
        '',
        '**Want to showcase your other projects?**',
        'You\'re welcome to list them directly at [aidigitalcrew.com](https://aidigitalcrew.com) — it\'s free and open to the community.',
        '',
        '**Stay in the loop?**',
        'We feature a new innovative, high-momentum open-source project every day. If you\'d like to follow along, subscribe at [aidigitalcrew.substack.com](https://aidigitalcrew.substack.com) — free, no spam.',
        '',
        '**Discover AI Agents**',
        'We just launched the [AI Agent Marketplace](https://marketplace.aidigitalcrew.com/) — discover, compare, and deploy AI agents for your workflows. Check it out!',
        '',
        'Feel free to close this issue — it\'s just a heads-up, not a support request.',
        '',
        '— Arivoli, AI Digital Crew',
      ].join('\n');

      const token = NOTIFY_TOKEN || GITHUB_TOKEN;
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: `Your project was featured on AI Digital Crew 🎉`, body, labels: [] }),
      });
      if (res.ok) {
        const issue = await res.json();
        console.log(`Opened notification issue: ${issue.html_url}`);
      } else {
        console.warn(`Could not open notification issue (${res.status}): ${await res.text()}`);
      }
    }

    // ── Substack publish (inlined from substack-publish.js) ────────────────
    function buildProseMirrorDoc(writeup, quickStart, repoUrl, repoFullName) {
      const content = [];
      content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: '📥 Found this in Promotions? Move it to Primary so you never miss a pick.', marks: [{ type: 'italic' }] }],
      });
      content.push({ type: 'paragraph' });
      for (const line of writeup.split('\n')) {
        if (line.trim()) content.push({ type: 'paragraph', content: [{ type: 'text', text: line }] });
        else content.push({ type: 'paragraph' });
      }
      content.push({ type: 'paragraph' });
      content.push({ type: 'paragraph', content: [{ type: 'text', text: '⚡ Quick Start', marks: [{ type: 'bold' }] }] });
      content.push({
        type: 'orderedList',
        content: quickStart.map(step => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: step }] }],
        })),
      });
      content.push({ type: 'paragraph' });
      content.push({
        type: 'paragraph',
        content: [
          { type: 'text', text: '🔗 ' },
          { type: 'text', text: `View ${repoFullName} on GitHub`, marks: [{ type: 'link', attrs: { href: repoUrl, target: '_blank' } }] },
        ],
      });
      content.push({ type: 'paragraph' });
      content.push({
        type: 'paragraph',
        content: [
          { type: 'text', text: '🤖 ' },
          { type: 'text', text: 'NEW: AI Agent Marketplace', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' — Discover, compare, and deploy AI agents for your workflows. ' },
          { type: 'text', text: 'Explore now →', marks: [{ type: 'link', attrs: { href: 'https://marketplace.aidigitalcrew.com/', target: '_blank' } }] },
        ],
      });
      content.push({ type: 'paragraph' });
      content.push({ type: 'paragraph', content: [{ type: 'text', text: '— Auto-discovered by AI Digital Crew • aidigitalcrew.com' }] });
      return JSON.stringify({ type: 'doc', content });
    }

    async function publishToSubstack({ repoMeta, writeup, quickStart }) {
      if (!PIPEDREAM_WEBHOOK_URL) {
        console.warn('PIPEDREAM_WEBHOOK_URL not set — skipping Substack publish');
        return;
      }
      const payload = {
        title: `🤖 Project of the Day: ${repoMeta.name}`,
        subtitle: `Today's featured AI project: ${repoMeta.full_name} ⭐ ${repoMeta.stargazers_count}`,
        draftBody: buildProseMirrorDoc(writeup, quickStart, repoMeta.html_url, repoMeta.full_name),
        repoUrl: repoMeta.html_url,
        repoFullName: repoMeta.full_name,
      };
      console.log('Sending to Pipedream substack publisher...');
      const res = await fetch(PIPEDREAM_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Pipedream webhook failed (${res.status}): ${await res.text()}`);
      console.log('Substack publish triggered via Pipedream ✓');
    }

    // ── Trending discovery ─────────────────────────────────────────────────
    function inferCategoryFromTopics(topics) {
      const lower = (topics || []).map(t => t.toLowerCase());
      for (const [cat, keywords] of Object.entries(CATEGORY_TOPICS)) {
        if (keywords.some(kw => lower.includes(kw))) return cat;
      }
      return 'Other';
    }

    async function discoverTrendingRepos(db, existingNames) {
      console.log('Discovering trending repos (AI + Global)...');
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const seen = new Set();
      let aiAdded = 0, globalAdded = 0;

      async function maybeAdd(repo, source) {
        if (seen.has(repo.full_name) || existingNames.has(repo.full_name)) return false;
        if (repo.fork || !repo.description) return false;
        seen.add(repo.full_name);
        await db.collection('projects').add({
          fullName: repo.full_name,
          name: repo.name,
          owner: repo.owner.login,
          ownerAvatar: repo.owner.avatar_url,
          description: repo.description || '',
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          language: repo.language || '',
          topics: repo.topics || [],
          url: repo.html_url,
          category: inferCategoryFromTopics(repo.topics),
          submittedBy: 'auto-discovery',
          submittedByName: 'AI Digital Crew Bot',
          source,
          autoAddedDate: TODAY,
          createdAt: new Date(),
        });
        return true;
      }

      for (const group of AI_TOPIC_GROUPS) {
        const topicQ = group.map(t => `topic:${t}`).join(' OR ');
        const query = `${topicQ} stars:>200 pushed:>${sevenDaysAgo}`;
        const repos = await searchReposRaw(query);
        for (const r of repos) {
          if (await maybeAdd(r, 'trending-ai')) aiAdded++;
          if (aiAdded >= 100) break;
        }
        if (aiAdded >= 100) break;
        await new Promise(r => setTimeout(r, 2000));
      }

      const globalQueries = [
        `stars:>5000 pushed:>${threeDaysAgo}`,
        `stars:1000..5000 pushed:>${threeDaysAgo}`,
        `stars:500..1000 created:>${thirtyDaysAgo}`,
        `stars:>10000 pushed:>${sevenDaysAgo}`,
      ];
      for (const query of globalQueries) {
        const repos = await searchReposRaw(query);
        for (const r of repos) {
          if (await maybeAdd(r, 'trending-global')) globalAdded++;
          if (globalAdded >= 100) break;
        }
        if (globalAdded >= 100) break;
        await new Promise(r => setTimeout(r, 2000));
      }
      console.log(`Discovery complete: ${aiAdded} AI repos, ${globalAdded} Global repos added`);
    }

    // ── Main ───────────────────────────────────────────────────────────────
    console.log(`=== AI Project of the Day — ${TODAY} ===`);

    const seen = new Set();
    const candidates = [];
    const topicCategory = {};
    for (const [category, topics] of Object.entries(CATEGORY_TOPICS)) {
      for (const topic of topics) {
        const repos = await searchRepos(topic);
        for (const r of repos) {
          if (r.fork || !r.description) continue;
          if (!seen.has(r.full_name)) {
            seen.add(r.full_name);
            topicCategory[r.full_name] = category;
            candidates.push(r);
          }
        }
      }
    }
    candidates.sort((a, b) => b.stargazers_count - a.stargazers_count);
    console.log(`Found ${candidates.length} unique candidates`);

    if (candidates.length === 0) {
      console.log('No candidates found. Exiting.');
      return { status: 'no-candidates' };
    }

    const db = initFirestore();
    let allDocsSnap = await db.collection('projects').get();
    let allDocs = allDocsSnap.docs;
    const existingNames = new Set(allDocs.map(d => d.data().fullName));
    console.log(`Loaded ${allDocs.length} projects from Firestore`);

    let chosen = null;
    for (const repo of candidates) {
      if (!existingNames.has(repo.full_name)) { chosen = repo; break; }
      console.log(`Skipping ${repo.full_name} — already in Firestore`);
    }

    if (!chosen) {
      console.log('All candidates already in Firestore. Rebuilding cache only...');
      const MAX_CACHE_RETRIES = 3;
      let cacheWritten = false;
      for (let attempt = 1; attempt <= MAX_CACHE_RETRIES; attempt++) {
        try {
          await writeProjectsCache(db, allDocs);
          cacheWritten = true;
          break;
        } catch (cacheErr) {
          console.error(`Cache write failed (attempt ${attempt}/${MAX_CACHE_RETRIES}): ${cacheErr.message}`);
          if (attempt < MAX_CACHE_RETRIES) await new Promise(r => setTimeout(r, 3000 * attempt));
        }
      }
      if (cacheWritten) console.log('Cache rebuilt successfully.');
      else console.warn('Cache rebuild failed — website may show stale data.');
      return { status: 'cache-only', cacheWritten };
    }

    console.log(`Selected: ${chosen.full_name} (⭐ ${chosen.stargazers_count}) [${topicCategory[chosen.full_name] || 'AI Agents'}]`);

    const [owner, repo] = chosen.full_name.split('/');
    const readme = await fetchReadme(owner, repo);
    console.log(`README fetched (${readme.length} chars)`);

    const repoMeta = await fetchRepoMeta(owner, repo);
    console.log('Generating writeup with Gemini Flash...');
    const { writeup, quickStart } = await generateWriteup(repoMeta || chosen, readme);
    console.log('Writeup generated.');

    const projectDoc = {
      fullName: chosen.full_name,
      name: chosen.name,
      owner: chosen.owner.login,
      ownerAvatar: chosen.owner.avatar_url,
      description: chosen.description || '',
      stars: chosen.stargazers_count,
      forks: chosen.forks_count,
      language: chosen.language || '',
      topics: chosen.topics || [],
      url: chosen.html_url,
      category: topicCategory[chosen.full_name] || 'AI Agents',
      submittedBy: 'auto',
      submittedByName: 'AI Digital Crew Bot',
      source: 'auto',
      autoAddedDate: TODAY,
      writeup,
      quickStart,
      createdAt: new Date(),
    };

    await db.collection('projects').add(projectDoc);
    console.log(`Wrote project to Firestore: ${projectDoc.fullName}`);
    existingNames.add(chosen.full_name);

    console.log('Generating embeddings...');
    try {
      const embText = projectToEmbeddingText(projectDoc);
      const embeddings = await generateAllEmbeddings(embText);
      if (Object.keys(embeddings).length > 0) {
        const newSnap = await db.collection('projects').where('fullName', '==', projectDoc.fullName).limit(1).get();
        if (!newSnap.empty) {
          await newSnap.docs[0].ref.update(embeddings);
          console.log(`Embeddings stored: ${Object.keys(embeddings).join(', ')}`);
        }
      }
    } catch (embErr) {
      console.warn('Embedding generation failed (non-fatal):', embErr.message);
    }

    console.log('Checking for projects missing embeddings...');
    try {
      let backfilled = 0;
      for (const d of allDocs) {
        const p = d.data();
        if (p.embedding_gemini && p.embedding_cloudflare) continue;
        const text = projectToEmbeddingText(p);
        if (!text.trim()) continue;
        try {
          const embs = await generateAllEmbeddings(text);
          if (Object.keys(embs).length > 0) {
            await d.ref.update(embs);
            backfilled++;
          }
        } catch {}
      }
      if (backfilled > 0) console.log(`Backfilled embeddings for ${backfilled} projects`);
    } catch (bfErr) {
      console.warn('Backfill pass failed (non-fatal):', bfErr.message);
    }

    try {
      await discoverTrendingRepos(db, existingNames);
    } catch (discoverErr) {
      console.warn('Trending discovery failed (non-fatal):', discoverErr.message);
    }

    try {
      allDocsSnap = await db.collection('projects').get();
      allDocs = allDocsSnap.docs;
      await collectSnapshots(db, allDocs);
    } catch (snapErr) {
      console.warn('Snapshot collection failed (non-fatal):', snapErr.message);
    }

    allDocsSnap = await db.collection('projects').get();
    allDocs = allDocsSnap.docs;
    const MAX_CACHE_RETRIES = 3;
    let cacheWritten = false;
    for (let attempt = 1; attempt <= MAX_CACHE_RETRIES; attempt++) {
      try {
        await writeProjectsCache(db, allDocs, chosen.full_name);
        cacheWritten = true;
        break;
      } catch (cacheErr) {
        console.error(`Cache write failed (attempt ${attempt}/${MAX_CACHE_RETRIES}): ${cacheErr.message}`);
        if (attempt < MAX_CACHE_RETRIES) await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }
    if (!cacheWritten) throw new Error('FATAL: Could not write projectsCache after all retries.');

    try {
      await writeEmbeddingsCache(db, allDocs);
    } catch (embCacheErr) {
      console.warn('Embeddings cache write failed (non-fatal):', embCacheErr.message);
    }

    if (process.env.SKIP_NOTIFY === 'true') {
      console.log('Skipping owner notification (SKIP_NOTIFY=true)');
    } else {
      console.log('Notifying repo owner...');
      await notifyOwner(owner, repo);
    }

    if (process.env.SKIP_PUBLISH === 'true') {
      console.log('Skipping Substack publish (SKIP_PUBLISH=true)');
    } else {
      console.log('Publishing to Substack...');
      try {
        await publishToSubstack({ repoMeta: chosen, writeup, quickStart });
      } catch (pubErr) {
        console.error('Substack publish failed (non-fatal, website already updated):', pubErr.message);
      }
    }

    console.log('Done!');
    return {
      status: 'ok',
      chosen: chosen.full_name,
      stars: chosen.stargazers_count,
      today: TODAY,
    };
  },
});
