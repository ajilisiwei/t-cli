import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPEECH_PART_MAX_CHARS, splitSpeechParts } from '../src/speechParts.js';

const cp = (text) => [...text].length;

/** Every part is a trimmed, non-empty substring of `text`, in order, within the limit. */
function assertWellFormed(text, parts, maxChars = SPEECH_PART_MAX_CHARS) {
  let from = 0;
  for (const part of parts) {
    assert.ok(part.length > 0, 'no empty part');
    assert.equal(part, part.trim(), 'parts are trimmed');
    assert.ok(cp(part) <= maxChars, `part of ${cp(part)} code points exceeds ${maxChars}`);
    const at = text.indexOf(part, from);
    assert.ok(at >= from, 'parts are substrings of the text, in order');
    from = at + part.length;
  }
  // Nothing but whitespace is lost between the parts.
  assert.equal(parts.join('').replace(/\s+/gu, ''), text.replace(/\s+/gu, ''));
}

test('the limit is 1000 code points', () => {
  assert.equal(SPEECH_PART_MAX_CHARS, 1000);
});

test('empty or whitespace-only text has no parts', () => {
  assert.deepEqual(splitSpeechParts(''), []);
  assert.deepEqual(splitSpeechParts('  \n\t \r\n '), []);
});

test('text within the limit is one part: the whole text, trimmed', () => {
  assert.deepEqual(splitSpeechParts('  Hello there. How are you?\n'), ['Hello there. How are you?']);
  const atLimit = 'é'.repeat(SPEECH_PART_MAX_CHARS);
  assert.deepEqual(splitSpeechParts(atLimit), [atLimit], 'the limit counts code points, not UTF-16 units or bytes');
  const astral = '𝒜'.repeat(SPEECH_PART_MAX_CHARS);
  assert.deepEqual(splitSpeechParts(astral), [astral]);
});

test('sentences are packed greedily into parts', () => {
  const text = 'One two. Three four! Five six? Seven eight… Nine.';
  assert.deepEqual(splitSpeechParts(text, { maxChars: 20 }), ['One two. Three four!', 'Five six?', 'Seven eight… Nine.']);
  assert.deepEqual(splitSpeechParts(text, { maxChars: 9 }), ['One two.', 'Three', 'four!', 'Five six?', 'Seven', 'eight…', 'Nine.']);
});

test('. ! ? … end a sentence only when followed by whitespace', () => {
  // "3.14", "e.g." inside a word and "?!" without a space do not split.
  assert.deepEqual(splitSpeechParts('Pi is 3.14 today.', { maxChars: 12 }), ['Pi is 3.14', 'today.']);
  assert.deepEqual(splitSpeechParts('Really?!Yes sir. Fine.', { maxChars: 16 }), ['Really?!Yes sir.', 'Fine.']);
  assert.deepEqual(splitSpeechParts('Wait… what? No.', { maxChars: 11 }), ['Wait… what?', 'No.']);
});

test('。！？； end a sentence without whitespace', () => {
  assert.deepEqual(splitSpeechParts('今天下雨。明天晴！后天呢？不知道；再说', { maxChars: 8 }), ['今天下雨。', '明天晴！后天呢？', '不知道；再说']);
});

test('line breaks end a sentence; blank lines are skipped', () => {
  assert.deepEqual(splitSpeechParts('first line\r\n\r\nsecond line\nthird', { maxChars: 12 }), ['first line', 'second line', 'third']);
  assert.deepEqual(splitSpeechParts('a\nb\nc', { maxChars: 5 }), ['a\nb\nc'], 'packed parts keep the original separators');
});

test('a sentence over the limit is cut at its last whitespace before the limit', () => {
  const words = 'alpha beta gamma delta epsilon';
  assert.deepEqual(splitSpeechParts(words, { maxChars: 12 }), ['alpha beta', 'gamma delta', 'epsilon']);
  // A whitespace right after the limit still leaves a full part before it.
  assert.deepEqual(splitSpeechParts('abcde fgh', { maxChars: 5 }), ['abcde', 'fgh']);
  // Runs of whitespace at the cut are dropped from both sides.
  assert.deepEqual(splitSpeechParts('abc    defgh', { maxChars: 6 }), ['abc', 'defgh']);
});

test('a sentence without whitespace is cut hard at the limit', () => {
  assert.deepEqual(splitSpeechParts('abcdefghij', { maxChars: 4 }), ['abcd', 'efgh', 'ij']);
  const han = '汉'.repeat(2500);
  assert.deepEqual(splitSpeechParts(han), ['汉'.repeat(1000), '汉'.repeat(1000), '汉'.repeat(500)]);
});

test('the pieces of a cut sentence are packed like sentences', () => {
  assert.deepEqual(splitSpeechParts('aaaa bbbb cc. dd.', { maxChars: 9 }), ['aaaa bbbb', 'cc. dd.']);
  assert.deepEqual(splitSpeechParts('x. aaaa bbbb', { maxChars: 7 }), ['x. aaaa', 'bbbb']);
});

test('a long English text: parts within the limit, cut at sentence ends', () => {
  const sentence = 'The quick brown fox jumps over the lazy dog near the quiet river bank. ';
  const text = sentence.repeat(40); // 2840 code points
  const parts = splitSpeechParts(text);
  assertWellFormed(text, parts);
  assert.equal(parts.length, 3);
  for (const part of parts) assert.ok(part.endsWith('bank.'), 'parts end at a sentence end');
  assert.equal(cp(parts[0]), 14 * sentence.length - 1, 'greedy: as many whole sentences as fit');
});

test('mixed text keeps every character and stays deterministic', () => {
  const text = [
    '第一段：今天我们讨论一个很长的话题。'.repeat(30),
    'Then an English paragraph follows! It has several sentences? Yes… it does. '.repeat(20),
    'x'.repeat(1500),
    'final words without punctuation '.repeat(40),
  ].join('\n\n');
  const parts = splitSpeechParts(text);
  assertWellFormed(text, parts);
  assert.deepEqual(splitSpeechParts(text), parts);
  assert.ok(parts.length >= 5);
});

test('rejects invalid arguments', () => {
  assert.throws(() => splitSpeechParts(null), TypeError);
  assert.throws(() => splitSpeechParts('text', { maxChars: 0 }), RangeError);
  assert.throws(() => splitSpeechParts('text', { maxChars: 1.5 }), RangeError);
});
