import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions } from './mentions';

const PARTS = [
  { id: 'u-john', name: 'John' },
  { id: 'u-amy', name: 'Amy' },
];

test('parseMentions: basic single mention', () => {
  assert.deepEqual(parseMentions('@John are you free?', PARTS), ['u-john']);
});

test('parseMentions: multiple mentions, order of first appearance', () => {
  assert.deepEqual(parseMentions('@John and @Amy please join', PARTS), ['u-john', 'u-amy']);
});

test('parseMentions: case-insensitive', () => {
  assert.deepEqual(parseMentions('@john can you check this', PARTS), ['u-john']);
});

test('parseMentions: dedup repeated mention of the same person', () => {
  assert.deepEqual(parseMentions('@John hi @John again', PARTS), ['u-john']);
});

test('parseMentions: no match for a non-participant name', () => {
  assert.deepEqual(parseMentions('@Bob hey there', PARTS), []);
});

test('parseMentions: excludes the sender even if they are a participant', () => {
  assert.deepEqual(parseMentions('@John @Amy see above', PARTS, 'u-john'), ['u-amy']);
});

test('parseMentions: word boundary — a longer word is not matched by a shorter name', () => {
  // "Johnny" must not register as a mention of participant "John".
  assert.deepEqual(parseMentions('@Johnny is not on this thread', PARTS), []);
});

test('parseMentions: longest-name-first — full name wins over a shorter overlapping name', () => {
  const parts = [
    { id: 'u-john', name: 'John' },
    { id: 'u-johnsmith', name: 'John Smith' },
  ];
  assert.deepEqual(parseMentions('@John Smith please review', parts), ['u-johnsmith']);
});

test('parseMentions: an email-shaped "@" (preceded by a word char) is not a mention', () => {
  assert.deepEqual(parseMentions('contact me at user@John.com', PARTS), []);
});

test('parseMentions: mention at the very start and end of the text', () => {
  assert.deepEqual(parseMentions('@John', PARTS), ['u-john']);
});

test('parseMentions: no participants → no matches', () => {
  assert.deepEqual(parseMentions('@John hello', []), []);
});

test('parseMentions: empty text → no matches', () => {
  assert.deepEqual(parseMentions('', PARTS), []);
});

test('parseMentions: participant with blank/whitespace-only name is never matched', () => {
  const parts = [{ id: 'u-blank', name: '   ' }];
  assert.deepEqual(parseMentions('@   hi', parts), []);
});
