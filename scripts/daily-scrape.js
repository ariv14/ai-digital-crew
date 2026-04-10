#!/usr/bin/env node
/**
 * daily-scrape.js — AI Project of the Day orchestrator
 *
 * Steps:
 *  1. Search GitHub for top new AI repos
 *  2. Skip any already in Firestore
 *  3. Fetch README
 *  4. Generate writeup + quickStart via Gemini Flash
 *  5. Write project to Firestore
 *  6. Publish newsletter post to Substack
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { publishToSubstack } from './substack-publish.js';
import { generateAllEmbeddings, projectToEmbeddingText } from './embedding-provider.js';

// ── Config ────────────────────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const NOTIFY_TOKEN = process.env.NOTIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!GITHUB_TOKEN || !GEMINI_API_KEY || !FIREBASE_SERVICE_ACCOUNT) {
  console.error('Missing required env vars: GITHUB_TOKEN, GEMINI_API_KEY, FIREBASE_SERVICE_ACCOUNT');
  process.exit(1);
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
const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// ── Discovery topics (grouped for OR queries) ────────────────────────────────

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

// ── GitHub helpers ────────────────────────────────────────────────────────────

const ghHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function searchRepos(topic) {
  await waitForSearchQuota();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const q = `topic:${topic}+created:>${sevenDaysAgo}+stars:>${MIN_STARS}`;
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`;

  const res = await fetch(url, { headers: ghHeaders });
  updateSearchRateLimit(res);
  if (!res.ok) {
    console.warn(`GitHub search failed for topic ${topic}: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.items || [];
}

async function fetchReadme(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/readme`;
  const res = await fetch(url, {
    headers: { ...ghHeaders, Accept: 'application/vnd.github.raw' },
  });
  if (!res.ok) return '';
  const text = await res.text();
  return text.slice(0, README_MAX_CHARS);
}

async function fetchRepoMeta(owner, repo) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: ghHeaders,
  });
  if (!res.ok) return null;
  return res.json();
}

// ── Trend tracking: rate-limited fetch + momentum scoring ────────────────────

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

  // 7-day metrics
  const stars7d = latest.stars - weekAgo.stars;
  const forks7d = latest.forks - weekAgo.forks;
  const starsPct7d = weekAgo.stars > 0 ? (stars7d / weekAgo.stars) * 100 : 0;

  // 1-day metrics (yesterday vs today)
  const yesterday = sorted.length >= 2 ? sorted[sorted.length - 2] : sorted[0];
  const stars1d = latest.stars - yesterday.stars;
  const starsPct1d = yesterday.stars > 0 ? (stars1d / yesterday.stars) * 100 : 0;
  const forks1d = latest.forks - yesterday.forks;

  // 30-day metrics
  const monthAgo = sorted.length >= 30 ? sorted[sorted.length - 30] : sorted[0];
  const stars30d = latest.stars - monthAgo.stars;
  const starsPct30d = monthAgo.stars > 0 ? (stars30d / monthAgo.stars) * 100 : 0;
  const forks30d = latest.forks - monthAgo.forks;

  // Relative growth: log2(1 + pct) normalized, cap at 100
  const relGrowth = Math.min(100, (Math.log2(1 + Math.abs(starsPct7d)) / Math.log2(1 + 50)) * 100);
  const relScore = starsPct7d >= 0 ? relGrowth : -relGrowth;

  // Absolute growth: log10(1 + stars7d) normalized, cap at 100
  const absGrowth = Math.min(100, (Math.log10(1 + Math.abs(stars7d)) / Math.log10(1 + 1000)) * 100);
  const absScore = stars7d >= 0 ? absGrowth : -absGrowth;

  // Acceleration: recent 3-day rate vs older 3-day rate
  let accelScore = 50; // neutral default
  if (sorted.length >= 4) {
    const mid = sorted.length >= 7 ? sorted[sorted.length - 4] : sorted[Math.floor(sorted.length / 2)];
    const recentRate = (latest.stars - mid.stars) / Math.max(1, sorted.length - sorted.indexOf(mid));
    const olderRate = (mid.stars - weekAgo.stars) / Math.max(1, sorted.indexOf(mid) - (sorted.length >= 7 ? sorted.length - 7 : 0));
    if (olderRate > 0) {
      accelScore = Math.min(100, Math.max(0, 50 + (recentRate / olderRate - 1) * 50));
    } else if (recentRate > 0) {
      accelScore = 80;
    }
  }

  const momentum = Math.max(0, Math.min(100,
    relScore * 0.50 + absScore * 0.30 + accelScore * 0.20
  ));

  let label;
  if (momentum >= 75) label = 'hot';
  else if (momentum >= 45) label = 'rising';
  else if (momentum >= 15) label = 'steady';
  else label = 'declining';

  const sparkline = sorted.slice(-7).map(s => s.stars);
  const sparkline30d = sorted.slice(-30).map(s => s.stars);

  return {
    trend_stars7d: stars7d,
    trend_starsPct7d: Math.round(starsPct7d * 100) / 100,
    trend_forks7d: forks7d,
    trend_stars1d: stars1d,
    trend_starsPct1d: Math.round(starsPct1d * 100) / 100,
    trend_forks1d: forks1d,
    trend_stars30d: stars30d,
    trend_starsPct30d: Math.round(starsPct30d * 100) / 100,
    trend_forks30d: forks30d,
    trend_momentum: Math.round(momentum * 10) / 10,
    trend_label: label,
    trend_sparkline: sparkline,
    trend_sparkline30d: sparkline30d,
  };
}

async function collectSnapshots(db, allDocs) {
  console.log('Collecting daily snapshots for trend tracking...');
  const projects = allDocs;
  console.log(`Processing ${projects.length} projects for snapshots`);

  const BATCH_SIZE = 30;
  const MAX_SNAPSHOTS = 31; // Keep last 31 entries (supports 30d metrics)
  let processed = 0, failed = 0;

  for (let i = 0; i < projects.length; i += BATCH_SIZE) {
    const batch = projects.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(batch.map(async (doc) => {
      const p = doc.data();
      const [owner, repo] = (p.fullName || '').split('/');
      if (!owner || !repo) return null;

      try {
        const ghData = await fetchWithRateLimit(owner, repo);
        if (!ghData) return null;

        // Build today's snapshot
        const todaySnapshot = {
          date: TODAY,
          stars: ghData.stargazers_count || 0,
          forks: ghData.forks_count || 0,
          openIssues: ghData.open_issues_count || 0,
        };

        // Read existing inline snapshots array (already in memory from allDocs)
        let snapshots = Array.isArray(p.snapshots) ? [...p.snapshots] : [];

        // Replace today's entry if it exists, otherwise append
        const todayIdx = snapshots.findIndex(s => s.date === TODAY);
        if (todayIdx >= 0) {
          snapshots[todayIdx] = todaySnapshot;
        } else {
          snapshots.push(todaySnapshot);
        }

        // Sort by date and trim to last MAX_SNAPSHOTS entries
        snapshots.sort((a, b) => a.date.localeCompare(b.date));
        if (snapshots.length > MAX_SNAPSHOTS) {
          snapshots = snapshots.slice(-MAX_SNAPSHOTS);
        }

        // Compute momentum from inline array
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

    // Courtesy delay between batches
    if (i + BATCH_SIZE < projects.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`Snapshots complete: ${processed} updated, ${failed} failed`);
}

// ── Projects cache: split into home + trending docs ──────────────────────

// Home cache: core display fields only (no trend data)
const HOME_FIELDS = [
  'fullName', 'name', 'owner', 'ownerAvatar', 'description',
  'stars', 'forks', 'language', 'topics', 'url', 'category', 'source', 'autoAddedDate',
  'submittedBy', 'createdAt',
];

// Trending cache: trend metrics keyed by fullName (loaded separately by trending view)
const TREND_FIELDS = [
  'trend_momentum', 'trend_label', 'trend_stars7d', 'trend_starsPct7d', 'trend_forks7d',
  'trend_stars1d', 'trend_starsPct1d', 'trend_forks1d',
  'trend_stars30d', 'trend_starsPct30d', 'trend_forks30d',
  'trend_sparkline', 'trend_sparkline30d', 'trend_updatedAt',
];

const POTD_EXTRA_FIELDS = ['writeup', 'quickStart'];
const MAX_CACHE_BYTES = 1_048_576;
const CACHE_WARN_BYTES = 900_000;

async function writeProjectsCache(db, allDocs, expectedFullName) {
  // Assert the expected new project is present before writing cache
  if (expectedFullName) {
    const found = allDocs.some(d => d.data().fullName === expectedFullName);
    if (!found) {
      throw new Error(`Consistency error: expected project ${expectedFullName} not found in allDocs`);
    }
  }

  const now = new Date().toISOString();

  // ── Home cache (projectsCache/home) ──────────────────────────────────
  console.log('Writing projectsCache/home...');

  const projectMap = new Map();
  const homeProjects = allDocs.map(d => {
    const raw = d.data();
    const obj = {};
    for (const key of HOME_FIELDS) {
      if (raw[key] === undefined) continue;
      if (raw[key] && typeof raw[key].toDate === 'function') {
        obj[key] = raw[key].toDate().toISOString();
      } else {
        obj[key] = raw[key];
      }
    }
    projectMap.set(raw.fullName, { obj, raw });
    return obj;
  });

  const homePayload = { projects: homeProjects, updatedAt: now };
  const homeBytes = Buffer.byteLength(JSON.stringify(homePayload), 'utf8');
  console.log(`projectsCache/home payload: ${homeBytes} bytes (${homeProjects.length} projects, limit: ${MAX_CACHE_BYTES})`);
  if (homeBytes > MAX_CACHE_BYTES) {
    throw new Error(`projectsCache/home exceeds Firestore 1MB limit: ${homeBytes} bytes`);
  }
  await db.collection('projectsCache').doc('home').set(homePayload);
  console.log(`projectsCache/home written (${homeBytes} bytes)`);

  // ── Trending cache (projectsCache/trending) ──────────────────────────
  // Stored as a JSON string to avoid Firestore's 40,000 index entry limit
  // (a nested map with 1,150 keys × 13 fields exceeds this)
  console.log('Writing projectsCache/trending...');

  const trendData = {};
  for (const d of allDocs) {
    const raw = d.data();
    if (!raw.fullName) continue;
    const tObj = {};
    let hasTrend = false;
    for (const key of TREND_FIELDS) {
      if (raw[key] === undefined) continue;
      if (raw[key] && typeof raw[key].toDate === 'function') {
        tObj[key] = raw[key].toDate().toISOString();
      } else {
        tObj[key] = raw[key];
      }
      hasTrend = true;
    }
    if (hasTrend) trendData[raw.fullName] = tObj;
  }

  const trendJson = JSON.stringify(trendData);
  const trendPayload = { json: trendJson, updatedAt: now };
  const trendBytes = Buffer.byteLength(JSON.stringify(trendPayload), 'utf8');
  console.log(`projectsCache/trending payload: ${trendBytes} bytes (${Object.keys(trendData).length} entries, limit: ${MAX_CACHE_BYTES})`);
  if (trendBytes > MAX_CACHE_BYTES) {
    throw new Error(`projectsCache/trending exceeds Firestore 1MB limit: ${trendBytes} bytes`);
  }
  await db.collection('projectsCache').doc('trending').set(trendPayload);
  console.log(`projectsCache/trending written (${trendBytes} bytes)`);

  // ── Featured POTD writeup (projectsCache/featured) ───────────────────
  const cutoff = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dailyPicks = [];
  for (const d of allDocs) {
    const raw = d.data();
    if (raw.source === 'auto' && (raw.autoAddedDate || '') >= cutoff) {
      const createdAt = raw.createdAt?.toDate?.() || new Date(raw.createdAt || 0);
      dailyPicks.push({ fullName: raw.fullName, date: raw.autoAddedDate || '', createdAt });
    }
  }
  // Sort by autoAddedDate desc, then createdAt desc (matches frontend tiebreaker)
  dailyPicks.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt - a.createdAt));

  if (dailyPicks.length > 0) {
    const topPick = dailyPicks[0];
    const topEntry = projectMap.get(topPick.fullName);
    if (topEntry && topEntry.raw.writeup) {
      const featuredDoc = {
        fullName: topPick.fullName,
        writeup: topEntry.raw.writeup,
        quickStart: topEntry.raw.quickStart || [],
        updatedAt: now,
      };
      await db.collection('projectsCache').doc('featured').set(featuredDoc);
      console.log(`projectsCache/featured written for ${topPick.fullName}`);
    } else {
      console.log(`No writeup found for top pick ${topPick.fullName} — skipping featured doc`);
    }
  }
}

// ── Embeddings cache: chunked for Cloud Function ──────────────────────────────

async function writeEmbeddingsCache(db, allDocs) {
  console.log('Writing embeddingsCache...');
  const entries = [];
  for (const doc of allDocs) {
    const p = doc.data();
    if (p.fullName && p.embedding_gemini) {
      entries.push({ fullName: p.fullName, embedding: p.embedding_gemini });
    }
  }

  if (entries.length === 0) {
    console.log('No embeddings to cache');
    return;
  }

  // Split into chunks of 30 per doc (~900KB each, under 1MB Firestore limit)
  const CHUNK_SIZE = 30;
  const chunks = [];
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    chunks.push(entries.slice(i, i + CHUNK_SIZE));
  }

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

// ── Firestore ─────────────────────────────────────────────────────────────────

function initFirestore() {
  const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
  return getFirestore();
}

async function writeProjectToFirestore(db, project) {
  await db.collection('projects').add(project);
  console.log(`Wrote project to Firestore: ${project.fullName}`);
}

// ── Gemini ────────────────────────────────────────────────────────────────────

// Retry model.generateContent on transient Google API failures (5xx, 429).
// Leaves 4xx (other than 429) to fail fast — those are prompt/auth bugs, not flaky infra.
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
      const waitMs = Math.min(30000, 2000 * Math.pow(2, attempt - 1)); // 2s, 4s, 8s, cap 30s
      console.warn(`Gemini attempt ${attempt}/${MAX_ATTEMPTS} failed (${status} ${err?.statusText || ''}) — retrying in ${waitMs / 1000}s...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr; // unreachable, guards against accidental fallthrough
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

  // Strip markdown code fences if Gemini wraps the JSON
  const jsonText = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed.writeup !== 'string' || !Array.isArray(parsed.quickStart)) {
      throw new Error('Unexpected JSON shape');
    }
    return parsed;
  } catch (e) {
    console.error('Failed to parse Gemini response:', text);
    throw e;
  }
}

// ── Owner notification ────────────────────────────────────────────────────────

async function notifyOwner(owner, repo, repoFullName) {
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

  const url = `https://api.github.com/repos/${owner}/${repo}/issues`;
  const token = NOTIFY_TOKEN || GITHUB_TOKEN;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `Your project was featured on AI Digital Crew 🎉`,
      body,
      labels: [],
    }),
  });

  if (res.ok) {
    const issue = await res.json();
    console.log(`Opened notification issue: ${issue.html_url}`);
  } else {
    // Non-fatal: repo may have issues disabled or we lack permission
    const text = await res.text();
    console.warn(`Could not open notification issue (${res.status}): ${text}`);
  }
}

// ── Search rate limiter (GitHub Search API: 30 req/min) ──────────────────────

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

// ── Trending discovery: AI + Global pools ────────────────────────────────────

async function searchReposRaw(query, perPage = 100) {
  await waitForSearchQuota();
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}`;
  const res = await fetch(url, { headers: ghHeaders });
  updateSearchRateLimit(res);
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      console.warn(`Search rate-limited (${res.status}), waiting for reset...`);
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (searchRateLimit.resetAt - Date.now() / 1000 + 2) * 1000;
      if (waitMs > 0 && waitMs < 120000) {
        await new Promise(r => setTimeout(r, waitMs));
        // Retry once
        const res2 = await fetch(url, { headers: ghHeaders });
        updateSearchRateLimit(res2);
        if (res2.ok) {
          const data = await res2.json();
          return data.items || [];
        }
      }
    }
    console.warn(`GitHub search failed (${res.status}): ${query.slice(0, 80)}...`);
    return [];
  }
  const data = await res.json();
  return data.items || [];
}

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

    const doc = {
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
    };

    await db.collection('projects').add(doc);
    return true;
  }

  // AI Discovery — 8 OR-grouped queries
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

  // Global Discovery — 4 queries, no topic filter
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== AI Project of the Day — ${TODAY} ===`);

  // 1. Search GitHub across all categories/topics, deduplicate by full_name
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

  // Sort by stars descending
  candidates.sort((a, b) => b.stargazers_count - a.stargazers_count);
  console.log(`Found ${candidates.length} unique candidates`);

  if (candidates.length === 0) {
    console.log('No candidates found. Exiting.');
    return;
  }

  // 2. Init Firestore, single read of all projects for the entire pipeline
  const db = initFirestore();
  let allDocsSnap = await db.collection('projects').get();
  let allDocs = allDocsSnap.docs;
  const existingNames = new Set(allDocs.map(d => d.data().fullName));
  console.log(`Loaded ${allDocs.length} projects from Firestore (single read for entire pipeline)`);

  let chosen = null;
  for (const repo of candidates) {
    if (!existingNames.has(repo.full_name)) {
      chosen = repo;
      break;
    }
    console.log(`Skipping ${repo.full_name} — already in Firestore`);
  }

  if (!chosen) {
    console.log('All candidates already in Firestore.');
    // Still rebuild the cache so the website stays up-to-date
    console.log('Rebuilding cache with existing projects...');
    const MAX_CACHE_RETRIES = 3;
    let cacheWritten = false;
    for (let attempt = 1; attempt <= MAX_CACHE_RETRIES; attempt++) {
      try {
        await writeProjectsCache(db, allDocs);
        cacheWritten = true;
        break;
      } catch (cacheErr) {
        console.error(`Cache write failed (attempt ${attempt}/${MAX_CACHE_RETRIES}): ${cacheErr.message}`);
        if (attempt < MAX_CACHE_RETRIES) {
          await new Promise(r => setTimeout(r, 3000 * attempt));
        }
      }
    }
    if (cacheWritten) console.log('Cache rebuilt successfully.');
    else console.warn('Cache rebuild failed — website may show stale data.');
    return;
  }

  console.log(`Selected: ${chosen.full_name} (⭐ ${chosen.stargazers_count}) [${topicCategory[chosen.full_name] || 'AI Agents'}]`);

  // 3. Fetch README
  const [owner, repo] = chosen.full_name.split('/');
  const readme = await fetchReadme(owner, repo);
  console.log(`README fetched (${readme.length} chars)`);

  // 4. Generate writeup with Gemini
  const repoMeta = await fetchRepoMeta(owner, repo);
  console.log('Generating writeup with Gemini Flash...');
  const { writeup, quickStart } = await generateWriteup(repoMeta || chosen, readme);
  console.log('Writeup generated.');

  // 5. Write to Firestore
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

  await writeProjectToFirestore(db, projectDoc);
  existingNames.add(chosen.full_name); // prevent duplicate in trending discovery

  // 5b. Generate embeddings for the new project
  console.log('Generating embeddings...');
  try {
    const embText = projectToEmbeddingText(projectDoc);
    const embeddings = await generateAllEmbeddings(embText);
    if (Object.keys(embeddings).length > 0) {
      // Find the doc we just wrote and update with embeddings
      const newSnap = await db.collection('projects').where('fullName', '==', projectDoc.fullName).limit(1).get();
      if (!newSnap.empty) {
        await newSnap.docs[0].ref.update(embeddings);
        console.log(`Embeddings stored: ${Object.keys(embeddings).join(', ')}`);
      }
    }
  } catch (embErr) {
    console.warn('Embedding generation failed (non-fatal):', embErr.message);
  }

  // 5c. Backfill embeddings for user-submitted projects missing them
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

  // 6. Discover trending repos (AI + Global pools)
  try {
    await discoverTrendingRepos(db, existingNames);
  } catch (discoverErr) {
    console.warn('Trending discovery failed (non-fatal):', discoverErr.message);
  }

  // 7. Collect daily snapshots for trend tracking
  //    Re-read allDocs since discovery may have added new projects
  try {
    allDocsSnap = await db.collection('projects').get();
    allDocs = allDocsSnap.docs;
    await collectSnapshots(db, allDocs);
  } catch (snapErr) {
    console.warn('Snapshot collection failed (non-fatal):', snapErr.message);
  }

  // 7b. Write split projects cache (home + trending + featured)
  //     Re-read after snapshots since trend fields were just updated
  //     FATAL: the website depends on this — retry up to 3 times before failing
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
      if (attempt < MAX_CACHE_RETRIES) {
        await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }
  }
  if (!cacheWritten) {
    throw new Error('FATAL: Could not write projectsCache after all retries. Website will not show new project.');
  }

  // 7c. Write embeddings cache for Cloud Function (server-side semantic search)
  try {
    await writeEmbeddingsCache(db, allDocs);
  } catch (embCacheErr) {
    console.warn('Embeddings cache write failed (non-fatal):', embCacheErr.message);
  }

  // 8. Notify the repo owner via a GitHub issue
  if (process.env.SKIP_NOTIFY === 'true') {
    console.log('Skipping owner notification (SKIP_NOTIFY=true)');
  } else {
    console.log('Notifying repo owner...');
    await notifyOwner(owner, repo, chosen.full_name);
  }

  // 9. Publish to Substack
  //     Non-fatal: the website is already updated via projectsCache above. If the
  //     Pipedream webhook or Substack session is down, log loudly but do not fail
  //     the whole pipeline — otherwise a rotated Substack cookie would zombie the
  //     daily run indefinitely and mask legitimate pipeline errors.
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
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
