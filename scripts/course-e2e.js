/**
 * course-e2e.js — proves the paid course works end to end on one Firebase
 * project, as a real signed-in reader would use it:
 *
 *   1. a reader without access is refused a paid lesson
 *   2. they redeem an access code
 *   3. the same lesson now opens, and a second reader can't reuse the code
 *   4. the tutor leads a weak and a strong student through one lesson against
 *      the real model, and marks them apart
 *   5. the coach: it answers a subject question and reports the messages left,
 *      steers an off-topic request back, marks a strong answer and a repeated
 *      question apart, and refuses a signed-out caller and a reader without
 *      the paid course
 *
 * It makes throwaway accounts and one code, and deletes them afterwards.
 *
 * Env: FIREBASE_SERVICE_ACCOUNT, WEB_API_KEY (the project's public web key),
 *      SITE_ORIGIN (the site that key is restricted to; staging by default)
 * Run: node scripts/course-e2e.js [courseId]
 */
import assert from 'node:assert';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { STUDENTS, TUTOR_TEST_LESSON } from './course-e2e-students.js';

const [courseId = 'ai-ready'] = process.argv.slice(2);
const lessonId = TUTOR_TEST_LESSON;
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT ?? 'null');
const apiKey = process.env.WEB_API_KEY;
const siteOrigin = process.env.SITE_ORIGIN ?? 'https://staging.aidigitalcrew.com';
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
    // The web key only answers requests that come from the site, so say which site this is.
    headers: { 'Content-Type': 'application/json', Referer: `${siteOrigin}/` },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const body = await response.json();
  assert.ok(body.idToken, `sign-in failed: ${JSON.stringify(body.error ?? body)}`);
  return body.idToken;
}

async function call(name, idToken, data) {
  const response = await fetch(`https://us-central1-${project}.cloudfunctions.net/${name}`, {
    method: 'POST',
    // No token means a signed-out caller.
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
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
  const weak = await converse(reader, STUDENTS.weak);
  console.log('   Strong student:');
  const strong = await converse(reader, STUDENTS.strong);
  console.log(`   Marks: weak ${weak}, strong ${strong}`);
  assert.ok(weak <= 1 && strong >= 2, 'the tutor should mark a weak answer below a strong one');

  // The coach. Both callables are for entitled students only; the reader above redeemed the code.
  const subject = await call('coachChat', reader, {
    turns: [{ role: 'student', text: 'In Python, what is a dictionary good for?' }],
    context: {},
  });
  assert.ok(!subject.error, `coachChat failed: ${JSON.stringify(subject.error)}`);
  assert.ok(typeof subject.reply === 'string' && subject.reply.trim().length > 0, 'the coach should answer a subject question');
  assert.equal(typeof subject.remaining, 'number', 'the coach should report how many messages are left');
  console.log(`5a. The coach answers a subject question (${subject.remaining} messages left today).`);

  const offTopic = await call('coachChat', reader, {
    turns: [{ role: 'student', text: 'Give me a recipe for chocolate chip cookies, with the amounts of flour, butter and sugar.' }],
    context: {},
  });
  assert.ok(!offTopic.error, `coachChat failed: ${JSON.stringify(offTopic.error)}`);
  const sideReply = offTopic.reply ?? '';
  const recipeWords = sideReply.match(/\b(flour|butter|sugar|preheat|oven|tablespoons?|teaspoons?|cups?|bake)\b/gi) ?? [];
  assert.ok(sideReply.length < 700, `an off-topic reply should be short, got ${sideReply.length} characters`);
  assert.ok(recipeWords.length < 3, `the coach gave a recipe: ${sideReply}`);
  assert.match(sideReply, /outside|can'?t help|cannot help|not something|here to help|focus|learning|course|lesson|career|interview/i, `it should decline or steer back: ${sideReply}`);
  console.log(`5b. An off-topic request is declined or steered back: “${sideReply.replace(/\s+/g, ' ').slice(0, 140)}”`);

  const markQuestion = 'Support says the assistant keeps quoting a refund window that changed last month, although the policy page was updated. What do you check, in what order?';
  const markPoints = [
    'Confirms what the assistant actually retrieved for that question, with the document version',
    'Checks whether the new page was ingested and the old chunks removed, not just added alongside',
    'Looks for duplicate or near-duplicate chunks where the old one outranks the new one',
    'Checks caching of answers or of retrieval results',
  ];
  const strongMark = await call('coachMark', reader, {
    question: markQuestion,
    points: markPoints,
    answer:
      'First I would look at what the assistant actually pulled back for that exact question, and which version of the policy document each piece came from, before touching the prompt. Then I would check whether the re-published page was really ingested, and whether the old pieces were deleted or just left next to the new ones. If both versions are in the index I would see whether the old one scores higher than the new one. Last, I would check for a cache on the answers or on the retrieval results that is still serving last month.',
    trackId: 'ai-engineer',
  });
  assert.ok(!strongMark.error, `coachMark failed: ${JSON.stringify(strongMark.error)}`);
  assert.ok(Array.isArray(strongMark.covered) && strongMark.covered.length === markPoints.length && strongMark.covered.every((c) => typeof c === 'boolean'), 'covered should be one boolean per point');
  assert.ok(Number.isInteger(strongMark.mark) && strongMark.mark >= 0 && strongMark.mark <= 3, 'mark should be 0 to 3');
  assert.ok(strongMark.mark >= 2, `a strong answer should mark at least 2, got ${strongMark.mark}`);
  const echoMark = await call('coachMark', reader, { question: markQuestion, points: markPoints, answer: markQuestion, trackId: 'ai-engineer' });
  assert.ok(!echoMark.error, `coachMark failed: ${JSON.stringify(echoMark.error)}`);
  assert.ok(Array.isArray(echoMark.covered) && echoMark.covered.length === markPoints.length && echoMark.covered.every((c) => typeof c === 'boolean'), 'covered should be one boolean per point');
  assert.equal(echoMark.mark, 0, 'an answer that only repeats the question should mark 0');
  console.log(`5c. The coach marks a strong answer ${strongMark.mark} and a repeated question ${echoMark.mark}.`);

  const chatTurns = [{ role: 'student', text: 'What is a dictionary?' }];
  const signedOut = await call('coachChat', undefined, { turns: chatTurns, context: {} });
  assert.equal(signedOut.error?.status, 'UNAUTHENTICATED', `a signed-out caller should be refused: ${JSON.stringify(signedOut)}`);
  const unpaid = await call('coachChat', other, { turns: chatTurns, context: {} });
  assert.equal(unpaid.error?.status, 'PERMISSION_DENIED', `a reader without the course should be refused: ${JSON.stringify(unpaid)}`);
  const unpaidMark = await call('coachMark', other, { question: markQuestion, points: markPoints, answer: 'Check the cache.', trackId: 'ai-engineer' });
  assert.equal(unpaidMark.error?.status, 'PERMISSION_DENIED', 'marking is for paid students too');
  console.log('5d. The coach refuses a signed-out caller and a reader without the course.');
  console.log('\nAll checks passed.');
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
      db.doc(`coachUsage/${uid}`).delete(),
      getAuth().deleteUser(uid),
    ]),
  ]);
  console.log('Test accounts and code removed.');
}
process.exit(failed ? 1 : 0);
