/**
 * Runs the lesson tutor against the real model, without deploying anything:
 * a weak student and a strong student each explain one lesson, and the marks
 * should come out low and high. Run it before the first launch and after any
 * change to the tutor's rules or model.
 *
 *   GEMINI_API_KEY=... node functions/tutor-smoke.mjs <ai-ready.json> [lessonId]
 *
 * The lessons file comes from `npm run course:export` in ai-digital-crew-next.
 */
import { readFileSync } from 'node:fs';
import { tutorTurn } from './course.js';

const [file, lessonId = 'hash-map'] = process.argv.slice(2);
const apiKey = process.env.GEMINI_API_KEY;
if (!file || !apiKey) {
  console.error('Usage: GEMINI_API_KEY=... node functions/tutor-smoke.mjs <ai-ready.json> [lessonId]');
  process.exit(1);
}
const lesson = JSON.parse(readFileSync(file, 'utf8')).lessons.find((l) => l.id === lessonId);
if (!lesson) throw new Error(`No lesson "${lessonId}" in ${file}`);

const STUDENTS = {
  weak: ['I am not sure. It is something about computers being fast?', 'I do not know why.', 'Maybe it just remembers everything.', 'ok'],
  // A scripted student can't listen, so the strong one covers the whole lesson up front.
  strong: [
    lesson.recall.answer,
    `Let me say all of it in my own words. ${lesson.idea} One more thing I know: ${lesson.limit}`,
    `As I said: ${lesson.limit} In a new case I would use the same idea for the same reason, and check it by counting the steps on a small example.`,
    `To sum up: ${lesson.recall.answer}`,
  ],
};

const marks = {};
for (const [name, answers] of Object.entries(STUDENTS)) {
  console.log(`\n── ${name} student, lesson "${lesson.title}" ──`);
  let turns = [];
  let memo = '';
  for (let i = 0; ; i++) {
    const reply = await tutorTurn({ lesson, mode: 'explain', turns, memo, apiKey });
    console.log(`TUTOR [${reply.move}]: ${reply.reply}\n   memo: ${reply.memo}`);
    memo = reply.memo;
    turns = [...turns, { role: 'tutor', text: reply.reply }];
    if (reply.done) {
      marks[name] = reply.mark;
      break;
    }
    const answer = answers[Math.min(i, answers.length - 1)];
    console.log(`STUDENT: ${answer}`);
    turns = [...turns, { role: 'student', text: answer }];
  }
}

console.log('\nMarks:', marks);
if (!(marks.weak <= 1 && marks.strong >= 2)) {
  console.error('The tutor did not separate a weak answer from a strong one. Read the transcripts above.');
  process.exit(1);
}
console.log('The tutor led both conversations, kept its own notes, and marked them apart.');
