/**
 * course-e2e.js — proves the paid course works end to end on one Firebase
 * project, as a real signed-in reader would use it:
 *
 *   1. a reader without access is refused a paid lesson
 *   2. they redeem an access code
 *   3. the same lesson now opens, and a second reader can't reuse the code
 *   4. the tutor leads a weak and a strong student through one lesson against
 *      the real model, and marks them apart
 *
 * It makes throwaway accounts and one code, and deletes them afterwards.
 *
 * Env: FIREBASE_SERVICE_ACCOUNT, WEB_API_KEY (the project's public web key)
 * Run: node scripts/course-e2e.js [courseId] [lessonId]
 */
import assert from 'node:assert';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const [courseId = 'ai-ready', lessonId = 'hash-map'] = process.argv.slice(2);
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT ?? 'null');
const apiKey = process.env.WEB_API_KEY;
if (!serviceAccount || !apiKey) {
  console.error('Set FIREBASE_SERVICE_ACCOUNT and WEB_API_KEY.');
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const project = serviceAccount.project_id;
console.log(`Project: ${project}`);

const stamp = Date.now();
const readers = [`e2e-reader-${stamp}`, `e2e-other-${stamp}`];
const code = `E2E${stamp}`.slice(0, 16);

async function signIn(uid) {
  const customToken = await getAuth().createCustomToken(uid);
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const body = await response.json();
  assert.ok(body.idToken, `sign-in failed: ${JSON.stringify(body.error ?? body)}`);
  return body.idToken;
}

async function call(name, idToken, data) {
  const response = await fetch(`https://us-central1-${project}.cloudfunctions.net/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data }),
  });
  const body = await response.json();
  return body.error ? { error: body.error } : body.result;
}

const readLesson = (idToken) =>
  fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/courses/${courseId}/lessons/${lessonId}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });

async function converse(idToken, answers) {
  let turns = [];
  let memo = '';
  for (let i = 0; i < 8; i++) {
    const reply = await call('courseTutor', idToken, { courseId, lessonId, mode: 'explain', turns, memo });
    assert.ok(!reply.error, `tutor failed: ${JSON.stringify(reply.error)}`);
    console.log(`  TUTOR [${reply.move}]: ${reply.reply}\n     memo to itself: ${reply.memo}`);
    if (i === 0) assert.ok(reply.reply.includes('?'), 'the tutor should open with a question');
    memo = reply.memo;
    turns = [...turns, { role: 'tutor', text: reply.reply }];
    if (reply.done) return reply.mark;
    const answer = answers[Math.min(i, answers.length - 1)];
    console.log(`  STUDENT: ${answer}`);
    turns = [...turns, { role: 'student', text: answer }];
  }
  throw new Error('the tutor never finished');
}

let failed = false;
try {
  const [reader, other] = await Promise.all(readers.map(signIn));
  const lesson = (await db.doc(`courses/${courseId}/lessons/${lessonId}`).get()).data();
  assert.ok(lesson && !lesson.free, `${lessonId} must be a published paid lesson`);

  assert.equal((await readLesson(reader)).status, 403);
  console.log('1. Without access, the paid lesson is refused.');

  const wrong = await call('redeemAccessCode', reader, { courseId, code: 'AIR-NOPE-NOPE' });
  assert.equal(wrong.error?.status, 'NOT_FOUND');
  const locked = await call('courseTutor', reader, { courseId, lessonId, mode: 'explain', turns: [], memo: '' });
  assert.equal(locked.error?.status, 'PERMISSION_DENIED');
  await db.doc(`accessCodes/${code}`).set({ courseId, maxUses: 1, note: 'e2e', redeemedBy: [] });
  assert.deepEqual(await call('redeemAccessCode', reader, { courseId, code: code.toLowerCase() }), { ok: true });
  console.log('2. A wrong code is rejected, the tutor is closed, and the real code is accepted.');

  const opened = await readLesson(reader);
  assert.equal(opened.status, 200);
  assert.ok((await opened.json()).fields?.idea, 'the lesson should arrive with its teaching');
  const reuse = await call('redeemAccessCode', other, { courseId, code });
  assert.equal(reuse.error?.status, 'FAILED_PRECONDITION');
  assert.equal((await readLesson(other)).status, 403);
  console.log('3. The lesson now opens for that reader, and a second reader cannot reuse the code.');

  console.log(`4. Tutor on “${lesson.title}”, weak student:`);
  const weak = await converse(reader, ['I am not sure. Something about computers being fast?', 'I do not know why.', 'Maybe it just remembers everything.', 'ok']);
  console.log('   Strong student:');
  const strong = await converse(reader, [
    lesson.recall.answer,
    `Put my own way: ${lesson.idea.split('. ').slice(0, 2).join('. ')}. That is why it works.`,
    'I would use the same idea there for the same reason, and check it by counting the steps on a small example.',
    'Yes, and its limit is the one the lesson names.',
  ]);
  console.log(`   Marks: weak ${weak}, strong ${strong}`);
  assert.ok(weak <= 1 && strong >= 2, 'the tutor should mark a weak answer below a strong one');
  console.log('\nAll four checks passed.');
} catch (error) {
  failed = true;
  console.error(`\nFAILED: ${error.message}`);
} finally {
  await Promise.allSettled([
    db.doc(`accessCodes/${code}`).delete(),
    ...readers.flatMap((uid) => [
      db.doc(`entitlements/${uid}`).delete(),
      db.doc(`redeemAttempts/${uid}`).delete(),
      db.doc(`tutorUsage/${uid}`).delete(),
      getAuth().deleteUser(uid),
    ]),
  ]);
  console.log('Test accounts and code removed.');
}
process.exit(failed ? 1 : 0);
