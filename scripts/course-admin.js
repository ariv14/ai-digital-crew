/**
 * course-admin.js — the owner's tool for paid courses.
 *
 *   node scripts/course-admin.js publish <ai-ready.json>      upload the lessons
 *   node scripts/course-admin.js codes <courseId> <count> [--uses N] [--note "text"]
 *   node scripts/course-admin.js grant <courseId> <email-or-uid>
 *   node scripts/course-admin.js revoke <courseId> <email-or-uid>
 *   node scripts/course-admin.js list <courseId>              who has access, and code use
 *
 * The lessons file comes from `npm run course:export` in ai-digital-crew-next.
 * Which Firebase project is written to is decided by the service account:
 * use the staging account to test, the production one to sell.
 *
 * Env var: FIREBASE_SERVICE_ACCOUNT (the service-account JSON, as for the other scripts)
 */
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const [command, ...args] = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT env var');
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
console.log(`Project: ${serviceAccount.project_id}`);

// No 0/O or 1/I/L: codes get read aloud and typed by hand.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const block = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

async function uidFor(who) {
  if (!who) throw new Error('Give an email address or a uid.');
  return who.includes('@') ? (await getAuth().getUserByEmail(who)).uid : who;
}

const commands = {
  async publish(file) {
    const { courseId, lessons } = JSON.parse(readFileSync(file, 'utf8'));
    const collection = db.collection('courses').doc(courseId).collection('lessons');
    const keep = new Set(lessons.map((l) => l.id));
    const stale = (await collection.listDocuments()).filter((ref) => !keep.has(ref.id));
    const batch = db.batch();
    // Firestore has no `undefined`; a JSON round trip has already dropped any.
    lessons.forEach((lesson) => batch.set(collection.doc(lesson.id), lesson));
    stale.forEach((ref) => batch.delete(ref));
    batch.set(db.collection('courses').doc(courseId), { lessons: lessons.length, publishedAt: FieldValue.serverTimestamp() });
    await batch.commit();
    console.log(`Published ${lessons.length} lessons to courses/${courseId}/lessons${stale.length ? `, removed ${stale.length} old` : ''}.`);
  },

  async codes(courseId, count = '1') {
    const maxUses = Number(flag('uses') ?? 1);
    const note = flag('note') ?? '';
    const batch = db.batch();
    const made = [];
    for (let i = 0; i < Number(count); i++) {
      const shown = `AIR-${block()}-${block()}`;
      // Stored without dashes, which is how redeemAccessCode looks a code up.
      batch.create(db.collection('accessCodes').doc(shown.replace(/-/g, '')), {
        courseId, maxUses, note, redeemedBy: [], createdAt: FieldValue.serverTimestamp(),
      });
      made.push(shown);
    }
    await batch.commit();
    console.log(`${made.length} code${made.length === 1 ? '' : 's'} for ${courseId}, ${maxUses} use${maxUses === 1 ? '' : 's'} each:`);
    made.forEach((code) => console.log(`  ${code}`));
  },

  async grant(courseId, who) {
    const uid = await uidFor(who);
    await db.collection('entitlements').doc(uid).set(
      { courses: FieldValue.arrayUnion(courseId), grants: FieldValue.arrayUnion({ courseId, source: 'admin', at: Date.now() }) },
      { merge: true },
    );
    console.log(`Granted ${courseId} to ${who} (${uid}).`);
  },

  async revoke(courseId, who) {
    const uid = await uidFor(who);
    await db.collection('entitlements').doc(uid).set({ courses: FieldValue.arrayRemove(courseId) }, { merge: true });
    console.log(`Revoked ${courseId} from ${who} (${uid}).`);
  },

  async list(courseId) {
    const holders = await db.collection('entitlements').where('courses', 'array-contains', courseId).get();
    console.log(`${holders.size} account${holders.size === 1 ? '' : 's'} with access:`);
    holders.forEach((doc) => console.log(`  ${doc.id}  ${doc.data().email ?? ''}`));
    const codes = await db.collection('accessCodes').where('courseId', '==', courseId).get();
    const used = codes.docs.filter((d) => (d.data().redeemedBy ?? []).length > 0).length;
    console.log(`${codes.size} codes issued, ${used} used.`);
  },
};

if (!commands[command]) {
  console.error('Usage: node scripts/course-admin.js publish|codes|grant|revoke|list ...  (see the top of this file)');
  process.exit(1);
}
await commands[command](...args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')));
