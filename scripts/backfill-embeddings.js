#!/usr/bin/env node
/**
 * backfill-embeddings.js — Generate embeddings for existing projects
 *
 * Usage:
 *   node scripts/backfill-embeddings.js              # only projects missing embeddings
 *   node scripts/backfill-embeddings.js --force       # regenerate all
 *
 * Env vars: GEMINI_API_KEY, JINA_API_KEY, FIREBASE_SERVICE_ACCOUNT
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { generateAllEmbeddings, projectToEmbeddingText } from './embedding-provider.js';

const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!FIREBASE_SERVICE_ACCOUNT) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT env var');
  process.exit(1);
}

const force = process.argv.includes('--force');

const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function main() {
  console.log(`=== Backfill Embeddings${force ? ' (--force)' : ''} ===`);

  const snap = await db.collection('projects').get();
  console.log(`Found ${snap.size} projects`);

  let updated = 0;
  let skipped = 0;

  for (const docSnap of snap.docs) {
    const project = docSnap.data();
    const id = docSnap.id;

    // Skip if already has embeddings (unless --force)
    if (!force && project.embedding_gemini && project.embedding_cloudflare) {
      skipped++;
      continue;
    }

    const text = projectToEmbeddingText(project);
    if (!text.trim()) {
      console.warn(`Skipping ${project.fullName || id}: no text to embed`);
      skipped++;
      continue;
    }

    console.log(`Embedding ${project.fullName || id}...`);
    try {
      const embeddings = await generateAllEmbeddings(text);
      if (Object.keys(embeddings).length === 0) {
        console.warn(`  No embeddings generated for ${project.fullName || id}`);
        skipped++;
        continue;
      }
      await db.collection('projects').doc(id).update(embeddings);
      updated++;
      console.log(`  Updated with ${Object.keys(embeddings).join(', ')}`);
    } catch (err) {
      console.error(`  Error embedding ${project.fullName || id}: ${err.message}`);
    }
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
