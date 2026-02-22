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
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const q = `topic:${topic}+created:>${sevenDaysAgo}+stars:>${MIN_STARS}`;
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`;

  const res = await fetch(url, { headers: ghHeaders });
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

  const stars7d = latest.stars - weekAgo.stars;
  const forks7d = latest.forks - weekAgo.forks;
  const starsPct7d = weekAgo.stars > 0 ? (stars7d / weekAgo.stars) * 100 : 0;

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

  return {
    trend_stars7d: stars7d,
    trend_starsPct7d: Math.round(starsPct7d * 100) / 100,
    trend_forks7d: forks7d,
    trend_momentum: Math.round(momentum * 10) / 10,
    trend_label: label,
    trend_sparkline: sparkline,
  };
}

async function collectSnapshots(db) {
  console.log('Collecting daily snapshots for trend tracking...');
  const allProjects = await db.collection('projects').get();
  const projects = allProjects.docs;
  console.log(`Processing ${projects.length} projects for snapshots`);

  const BATCH_SIZE = 30;
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

        // Write today's snapshot
        const snapshotData = {
          date: TODAY,
          stars: ghData.stargazers_count || 0,
          forks: ghData.forks_count || 0,
          openIssues: ghData.open_issues_count || 0,
          capturedAt: new Date(),
        };
        await doc.ref.collection('snapshots').doc(TODAY).set(snapshotData);

        // Query last 8 snapshots for momentum calculation
        const snapQuery = await doc.ref.collection('snapshots')
          .orderBy('date', 'desc')
          .limit(8)
          .get();
        const snapshots = snapQuery.docs.map(d => d.data());

        // Compute momentum and update parent doc
        const trendFields = computeMomentum(snapshots);
        await doc.ref.update({
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

  // Prune snapshots older than 90 days
  const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let pruned = 0;
  for (const doc of projects) {
    const oldSnaps = await doc.ref.collection('snapshots')
      .where('date', '<', cutoffDate)
      .get();
    for (const snap of oldSnaps.docs) {
      await snap.ref.delete();
      pruned++;
    }
  }

  console.log(`Snapshots complete: ${processed} updated, ${failed} failed, ${pruned} pruned`);
}

// ── Firestore ─────────────────────────────────────────────────────────────────

function initFirestore() {
  const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
  initializeApp({ credential: cert(serviceAccount) });
  return getFirestore();
}

async function isAlreadyInFirestore(db, fullName) {
  const snap = await db
    .collection('projects')
    .where('fullName', '==', fullName)
    .limit(1)
    .get();
  return !snap.empty;
}

async function writeProjectToFirestore(db, project) {
  await db.collection('projects').add(project);
  console.log(`Wrote project to Firestore: ${project.fullName}`);
}

// ── Gemini ────────────────────────────────────────────────────────────────────

async function generateWriteup(repoMeta, readme) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = `You are a technical writer for AI developers. Given a GitHub repository, produce a JSON response with exactly two fields:
- "writeup": 2-3 paragraph summary for AI developers explaining what the project does and why it matters
- "quickStart": array of 3-5 strings, each a concise step to get started (install, configure, run)

Repository name: ${repoMeta.full_name}
Description: ${repoMeta.description || 'No description'}
Stars: ${repoMeta.stargazers_count}
Language: ${repoMeta.language || 'Unknown'}
Topics: ${(repoMeta.topics || []).join(', ') || 'none'}
README (truncated):
${readme}

Respond with ONLY valid JSON, no markdown fences, no extra text.`;

  const result = await model.generateContent(prompt);
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

// ── Trending discovery: AI + Global pools ────────────────────────────────────

async function searchReposRaw(query, perPage = 100) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}`;
  const res = await fetch(url, { headers: ghHeaders });
  if (!res.ok) {
    console.warn(`GitHub search failed (${res.status}): ${query.slice(0, 60)}...`);
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

async function discoverTrendingRepos(db) {
  console.log('Discovering trending repos (AI + Global)...');
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const seen = new Set();
  let aiAdded = 0, globalAdded = 0;

  // Check existing fullNames to avoid duplicates
  const existingSnap = await db.collection('projects').select('fullName').get();
  const existingNames = new Set(existingSnap.docs.map(d => d.data().fullName));

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

  // 2. Init Firestore and find the first repo not already stored
  const db = initFirestore();
  let chosen = null;
  for (const repo of candidates) {
    const exists = await isAlreadyInFirestore(db, repo.full_name);
    if (!exists) {
      chosen = repo;
      break;
    }
    console.log(`Skipping ${repo.full_name} — already in Firestore`);
  }

  if (!chosen) {
    console.log('All candidates already in Firestore. Exiting.');
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
    const allProjects = await db.collection('projects').get();
    let backfilled = 0;
    for (const d of allProjects.docs) {
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
    await discoverTrendingRepos(db);
  } catch (discoverErr) {
    console.warn('Trending discovery failed (non-fatal):', discoverErr.message);
  }

  // 7. Collect daily snapshots for trend tracking
  try {
    await collectSnapshots(db);
  } catch (snapErr) {
    console.warn('Snapshot collection failed (non-fatal):', snapErr.message);
  }

  // 8. Notify the repo owner via a GitHub issue
  if (process.env.SKIP_NOTIFY === 'true') {
    console.log('Skipping owner notification (SKIP_NOTIFY=true)');
  } else {
    console.log('Notifying repo owner...');
    await notifyOwner(owner, repo, chosen.full_name);
  }

  // 9. Publish to Substack
  if (process.env.SKIP_PUBLISH === 'true') {
    console.log('Skipping Substack publish (SKIP_PUBLISH=true)');
  } else {
    console.log('Publishing to Substack...');
    await publishToSubstack({ repoMeta: chosen, writeup, quickStart });
  }
  console.log('Done!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
