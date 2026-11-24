/**
 * Turn the last result of this session into the fields of a note
 * (docs/api-v1.md, "Notes"). Pure: no I/O, no React.
 *
 *  - word lookup → `word` note: text = the English head term (the corrected
 *    spelling for a misspelled English word), translation = the gloss (the
 *    Chinese after the IPA, or the first Chinese line of a detail-mode body;
 *    for a Chinese source, the term the user typed);
 *  - sentence / paragraph → `sentence` note: text = the English side,
 *    translation = the other side;
 *  - grammar check → `sentence` note with the corrected text and no translation.
 *
 * Notes are English only in v2: a result without an English side (a Japanese
 * or Korean source) cannot be saved.
 */
import { detectSourceLang, isWordLookup } from '@t-cli/core/detect';
import { normalizeText } from '@t-cli/core/entry';
import { extractSpeakable } from '@t-cli/core/speakable';
import { extractHeadTerm } from '@t-cli/core/spelling';

/**
 * @typedef {'word'|'phrase'|'sentence'} NoteKind
 * @typedef {{ task: 'translate'|'check', input: string, output: string, srcLang: 'zh'|'en'|'other'|null,
 *             simple: boolean, entryId: string|null, noteId: string|null, stars: number|null }} LastResult
 *   The last translation or check of the session. `noteId` is minted on the first /note and reused,
 *   so saving the same result again updates the same note; `stars` is set once a save succeeded.
 * @typedef {{ kind: NoteKind, text: string, translation: string|null }} NoteDraft
 * @typedef {{ ok: true, note: NoteDraft } | { ok: false, reason: string }} DraftResult
 */

/** Code-point limits of `PUT /v1/notes/:id`. */
export const WORD_TEXT_MAX = 64;
export const SENTENCE_TEXT_MAX = 2000;
export const TRANSLATION_MAX = 2000;
export const NOTHING_YET = 'Nothing to save yet. Translate or /check something first, then /note.';

const LATIN_RE = /\p{Script=Latin}/u;
const HAN_RE = /\p{Script=Han}/u;
// The word-lookup prompt's answer for a string that is no English word.
const UNRECOGNIZED_RE = /无法识别/;
// "head /ipa/ rest": the text after the first IPA token of the first line.
const AFTER_IPA_RE = /^[^/]*\/[^/\n]*\/\s*(.*)$/;
const LIST_MARKER_RE = /^\s*(?:#+\s*|[-*•]\s+|\d+\s*[.)、]\s*)/;
const SPELLING_NOTE_RE = /^(?:注意|note\b)/i;

/**
 * @param {LastResult | null} result
 * @returns {DraftResult}
 */
export function draftNote(result) {
  if (!result) return fail(NOTHING_YET);
  if (result.task === 'check') {
    return sentenceNote(bestTranslation(result.output, result.simple), null);
  }
  const srcLang = result.srcLang ?? detectSourceLang(result.input);
  if (srcLang === 'other') {
    return fail('Only English can be saved to the notebook, and this result has no English side.');
  }
  if (isWordLookup(result.input)) return wordNote(result, srcLang);
  const input = normalizeText(result.input);
  const best = bestTranslation(result.output, result.simple);
  return srcLang === 'zh' ? sentenceNote(best, input) : sentenceNote(input, best);
}

/**
 * @param {LastResult} result
 * @param {'zh'|'en'} srcLang
 * @returns {DraftResult}
 */
function wordNote(result, srcLang) {
  const input = result.input.trim();
  const firstLine = cleanLines(result.output)[0] ?? '';
  if (!firstLine || UNRECOGNIZED_RE.test(firstLine)) {
    return fail(`"${input}" was not recognized as a word, so there is nothing to save.`);
  }
  const head = extractHeadTerm(result.output);
  const fallback = srcLang === 'en' ? input : extractSpeakable(firstLine, false);
  const text = collapseSpaces(head ?? fallback);
  if (!LATIN_RE.test(text) || codePoints(text) > WORD_TEXT_MAX) {
    return fail('Could not find the English word in the last result, so there is nothing to save.');
  }
  const translation = srcLang === 'zh' ? input : glossOf(result.output);
  // A Chinese term can translate to several English words (期待 → look forward to): that is a phrase.
  const kind = /\s/.test(text) ? 'phrase' : 'word';
  return finish({ kind, text, translation: translation || null }, WORD_TEXT_MAX);
}

/**
 * @param {string} text the English side
 * @param {string | null} translation
 * @returns {DraftResult}
 */
function sentenceNote(text, translation) {
  if (!text || !LATIN_RE.test(text)) {
    return fail('Could not find the English text in the last result, so there is nothing to save.');
  }
  return finish({ kind: 'sentence', text, translation: translation || null }, SENTENCE_TEXT_MAX);
}

/**
 * @param {NoteDraft} note
 * @param {number} textMax
 * @returns {DraftResult}
 */
function finish(note, textMax) {
  if (codePoints(note.text) > textMax || (note.translation !== null && codePoints(note.translation) > TRANSLATION_MAX)) {
    return fail(`Too long to save as a note (at most ${textMax} characters).`);
  }
  return { ok: true, note };
}

/**
 * The single best translation / correction: the whole answer in simple mode,
 * the first line in detail mode (the prompts put it there alone).
 * @param {string} output
 * @param {boolean} simple
 * @returns {string}
 */
export function bestTranslation(output, simple) {
  if (simple) return normalizeText(stripMarkdown(output || ''));
  return cleanLines(output)[0] ?? '';
}

/**
 * The gloss of an English word lookup: what follows the IPA on the first
 * line ("eliminate /ɪˈlɪm.ə.neɪt/ 消除" → "消除"), else the first Chinese line
 * (below the IPA line, if any) that is not a heading or a spelling note.
 * Null when none.
 * @param {string} output
 * @returns {string | null}
 */
export function glossOf(output) {
  const lines = cleanLines(output);
  const match = AFTER_IPA_RE.exec(lines[0] ?? '');
  const rest = match ? match[1].replace(/^[-—–:：]\s*/, '').trim() : '';
  if (rest) return rest;
  // Without an IPA the first line may itself be the gloss.
  for (const raw of match ? lines.slice(1) : lines) {
    const line = raw.replace(LIST_MARKER_RE, '').replace(/[*_]/g, '').trim();
    if (!line || !HAN_RE.test(line) || /[:：]$/.test(line) || SPELLING_NOTE_RE.test(line)) continue;
    return line;
  }
  return null;
}

/** @param {string} output @returns {string[]} non-empty lines without `**`, trimmed */
function cleanLines(output) {
  return (output || '')
    .split(/\r\n|\r|\n/)
    .map((line) => stripMarkdown(line).trim())
    .filter((line) => line !== '');
}

/** @param {string} text */
function stripMarkdown(text) {
  return text.replace(/\*\*/g, '');
}

/** @param {string} text */
function collapseSpaces(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** @param {string} text */
function codePoints(text) {
  return [...text].length;
}

/** @param {string} reason @returns {DraftResult} */
function fail(reason) {
  return { ok: false, reason };
}
