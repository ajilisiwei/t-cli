/** Longest part read aloud in one request, in code points (docs/api-v1.md, "Speech in parts"). */
export const SPEECH_PART_MAX_CHARS = 1000;

// Ends a sentence when followed by whitespace (or by the end of the text).
const LATIN_ENDS = new Set(['.', '!', '?', '…']);
// End a sentence on their own.
const CJK_ENDS = new Set(['。', '！', '？', '；']);
const LINE_BREAKS = new Set(['\n', '\r', ' ', ' ']);
const WHITESPACE_RE = /^\s$/u;

const isSpace = (ch) => WHITESPACE_RE.test(ch);

/**
 * Sentence spans of `chars` as half-open code point ranges [start, end),
 * trimmed, empty ones dropped. A sentence ends after `. ! ? …` followed by
 * whitespace, after `。！？；`, and at a line break.
 * @param {string[]} chars
 * @returns {[number, number][]}
 */
function sentenceSpans(chars) {
  const spans = [];
  let start = 0;
  const close = (end) => {
    let from = start;
    let to = end;
    while (from < to && isSpace(chars[from])) from += 1;
    while (to > from && isSpace(chars[to - 1])) to -= 1;
    if (to > from) spans.push([from, to]);
    start = end;
  };
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (LINE_BREAKS.has(ch)) close(i + 1);
    else if (CJK_ENDS.has(ch)) close(i + 1);
    else if (LATIN_ENDS.has(ch) && i + 1 < chars.length && isSpace(chars[i + 1])) close(i + 1);
  }
  close(chars.length);
  return spans;
}

/**
 * Cut a trimmed span longer than `max` into pieces of at most `max` code
 * points: at the last whitespace within reach, else hard at `max`.
 * @param {string[]} chars
 * @param {[number, number]} span
 * @param {number} max
 * @returns {[number, number][]}
 */
function cutSpan(chars, [start, end], max) {
  const pieces = [];
  let from = start;
  while (end - from > max) {
    // A whitespace at from + max still leaves exactly `max` code points before it.
    let cut = from + max;
    while (cut > from && !isSpace(chars[cut])) cut -= 1;
    if (cut === from) cut = from + max;
    let to = cut;
    while (to > from && isSpace(chars[to - 1])) to -= 1;
    pieces.push([from, to]);
    from = cut;
    while (from < end && isSpace(chars[from])) from += 1;
  }
  if (end > from) pieces.push([from, end]);
  return pieces;
}

/**
 * Split text to be read aloud into parts of at most `maxChars` code points.
 *
 * Sentences (see `sentenceSpans`) are packed greedily into parts; a sentence
 * longer than the limit is cut at its last whitespace before the limit, else
 * at the limit. Every part is a trimmed substring of `text`, in order, and the
 * split is deterministic, so clients can fetch part 0, 1, … in turn. Used by
 * the server's `POST /v1/tts`.
 * @param {string} text
 * @param {{ maxChars?: number }} [options]
 * @returns {string[]} no parts for empty or whitespace-only text
 */
export function splitSpeechParts(text, { maxChars = SPEECH_PART_MAX_CHARS } = {}) {
  if (typeof text !== 'string') throw new TypeError('splitSpeechParts: text must be a string');
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError('splitSpeechParts: maxChars must be a positive integer');

  const chars = [...text];
  const units = sentenceSpans(chars).flatMap((span) => cutSpan(chars, span, maxChars));
  /** @type {[number, number][]} */
  const parts = [];
  for (const [start, end] of units) {
    const last = parts.at(-1);
    if (last && end - last[0] <= maxChars) parts[parts.length - 1] = [last[0], end];
    else parts.push([start, end]);
  }
  return parts.map(([start, end]) => chars.slice(start, end).join(''));
}
