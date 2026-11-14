/**
 * The two scripted students the tutor checks use, for the "hash-map" lesson.
 *
 * The strong one has to answer in words that aren't the lesson's. An earlier
 * version quoted the lesson back, and the tutor rightly marked it 1: reciting
 * isn't understanding. So these are written the way a student who understood
 * would put it, with their own pictures (lockers, a coat check).
 * The tutor nearly always asks how a set keeps only unique items, so the
 * strong student says so; without it the mark came back 1 about half the time.
 */
export const TUTOR_TEST_LESSON = 'hash-map';

export const STUDENTS = {
  weak: [
    'I am not sure. Something about computers being fast?',
    'I do not know why.',
    'Maybe it just remembers everything.',
    'ok',
  ],
  strong: [
    'Think of a school with numbered lockers. The dictionary does a small sum on the key, and the answer is a locker number. So it walks straight to that one locker and never opens the others. That is why finding a phone number by name is one step, even with a million names.',
    'My own example is a coat check. You hand over your ticket and the attendant goes straight to that hook. The hash is the thing that turns a name into the ticket number. Without it you would search hook by hook, and that gets slower as the room fills up.',
    'I would use a set there. Asking a set whether it already has something is one step, because it uses the same trick with keys only. That is also how it stays free of repeats: before it adds an item it does that one-step check, and if the item is already there it keeps just the one copy. With a list I would have to look at every item, so a million items could mean a million looks.',
    'Yes. Sometimes two keys land on the same shelf, and Python does a bit of extra work to tell them apart, so it is still quick. And a dictionary keeps nothing in size order, so finding the biggest key means checking them all.',
  ],
};
