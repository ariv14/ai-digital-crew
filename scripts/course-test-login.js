/**
 * course-test-login.js — a throwaway reader for checking a paid course in a
 * real browser, without using a real account or a real buyer's code.
 *
 *   node scripts/course-test-login.js create [courseId]   prints a sign-in token and a one-use code
 *   node scripts/course-test-login.js cleanup <uid> <code>
 *
 * The token signs in as a new account with no access; the code unlocks the
 * course for it. Both last an hour at most. Always run cleanup afterwards.
 *
 * Env: FIREBASE_SERVICE_ACCOUNT
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const [command, ...args] = process.argv.slice(2);
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

if (command === 'create') {
  const courseId = args[0] ?? 'ai-ready';
  const stamp = Date.now();
  const uid = `ui-test-${stamp}`;
  const code = `UITEST${stamp}`.slice(0, 16);
  await db.doc(`accessCodes/${code}`).set({ courseId, maxUses: 1, note: 'ui test', redeemedBy: [] });
  console.log(`UID=${uid}`);
  console.log(`CODE=${code}`);
  console.log(`TOKEN=${await getAuth().createCustomToken(uid)}`);
} else if (command === 'cleanup') {
  const [uid, code] = args;
  if (!/^ui-test-\d+$/.test(uid ?? '') || !/^UITEST\d+$/.test(code ?? '')) throw new Error('cleanup only removes ui-test accounts and UITEST codes');
  await Promise.allSettled([
    db.doc(`accessCodes/${code}`).delete(),
    db.doc(`entitlements/${uid}`).delete(),
    db.doc(`redeemAttempts/${uid}`).delete(),
    db.doc(`tutorUsage/${uid}`).delete(),
    getAuth().deleteUser(uid),
  ]);
  console.log(`Removed ${uid} and ${code}.`);
} else {
  console.error('Usage: course-test-login.js create [courseId] | cleanup <uid> <code>');
  process.exit(1);
}
