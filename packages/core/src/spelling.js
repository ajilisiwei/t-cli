/**
 * Spelling-correction detection for English word lookups.
 *
 * Word-lookup responses start with the head term followed by its IPA, e.g.
 * "prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑". The prompt tells the model to put the
 * correctly spelled word there, so when the head term differs from what the
 * user typed (ignoring case), the user misspelled it. Detecting this on the
 * client keeps the correction deterministic: it does not depend on how the
 * model words any explanation.
 */

// Head term: one or more English words (letters, apostrophes, hyphens), then
// optional whitespace and the opening slash of the IPA.
const HEAD_TERM_RE = /^([A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*)*)\s*\//;

/**
 * Extract the head term (the word before the IPA) from a word-lookup response.
 * @param {string} output raw model response
 * @returns {string | null} null when the first line does not start with "term /ipa/"
 */
export function extractHeadTerm(output) {
  const firstLine = (output || '')
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\*\*/g, '').trim())
    .find((line) => line !== '');
  if (!firstLine) return null;
  const match = HEAD_TERM_RE.exec(firstLine);
  return match ? match[1] : null;
}

/**
 * The corrected spelling for an English single-word lookup, or null when the
 * lookup is not an English word lookup or the head term matches the input.
 * @param {{ input: string, output: string, srcLang: 'zh'|'en'|'other'|null, kind: string }} fields
 * @returns {string | null}
 */
export function detectSpellingCorrection({ input, output, srcLang, kind }) {
  if (kind !== 'word' || srcLang !== 'en') return null;
  const head = extractHeadTerm(output);
  if (!head) return null;
  return head.toLowerCase() === (input || '').trim().toLowerCase() ? null : head;
}
