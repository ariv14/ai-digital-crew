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

  // 6. Notify the repo owner via a GitHub issue
  if (process.env.SKIP_NOTIFY === 'true') {
    console.log('Skipping owner notification (SKIP_NOTIFY=true)');
  } else {
    console.log('Notifying repo owner...');
    await notifyOwner(owner, repo, chosen.full_name);
  }

  // 7. Publish to Substack
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
