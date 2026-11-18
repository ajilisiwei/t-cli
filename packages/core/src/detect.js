const EN_WORD_RE = /^[a-zA-Z][a-zA-Z'-]*$/;
const ZH_WORD_RE = /^[一-鿿]{1,4}$/;
const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/;

/**
 * Detect whether the input looks like a single-word lookup
 * (single English token, or a Chinese term of 1-4 characters).
 * @param {string} text
 * @returns {boolean}
 */
export function isWordLookup(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  return EN_WORD_RE.test(trimmed) || ZH_WORD_RE.test(trimmed);
}

/**
 * Whether the text contains CJK characters (used for TTS voice selection).
 * @param {string} text
 * @returns {boolean}
 */
export function containsCJK(text) {
  return CJK_RE.test(text || '');
}

// Script property escapes (not Script_Extensions): marks shared with Chinese
// text, such as "・" (U+30FB) or "ー" (U+30FC), are Script=Common and must not
// turn a Chinese sentence into "other".
const KANA_HANGUL_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HAN_RE = /\p{Script=Han}/u;
// A letter of any script except Latin. Common/Inherited letters (e.g. the
// micro sign "µ") belong to no particular language.
const NON_LATIN_LETTER_RE = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u;

/**
 * @typedef {'zh'|'en'|'other'} SourceLang
 */

/**
 * Deterministically detect the translation source language (docs/api-v1.md,
 * "srcLang"); first match wins:
 * 1. any kana or Hangul → 'other' (Japanese, Korean);
 * 2. any Han character → 'zh' (mixed sentences like
 *    "珠宝估值的wrapped GraphQL API已部署" are Chinese with embedded English terms);
 * 3. any letter of another non-Latin script (Cyrillic, Greek, Thai, …) → 'other';
 * 4. otherwise → 'en' (Latin script, digits, punctuation, empty input).
 * Pure-Han Japanese is detected as 'zh'. Keeps direction out of the model's hands:
 * 'zh' translates into English, anything else into Chinese.
 * @param {string} text
 * @returns {SourceLang}
 */
export function detectSourceLang(text) {
  const value = text || '';
  if (KANA_HANGUL_RE.test(value)) return 'other';
  if (HAN_RE.test(value)) return 'zh';
  if (NON_LATIN_LETTER_RE.test(value)) return 'other';
  return 'en';
}

/**
 * Detect if input is a URL (starts with http:// or https://).
 * @param {string} text
 * @returns {boolean}
 */
export function isURL(text) {
  if (!text) return false;
  return text.startsWith('http://') || text.startsWith('https://');
}

/**
 * Convert a string to title case (first letter of each word capitalized).
 * @param {string} text
 * @returns {string}
 */
export function toTitleCase(text) {
  if (!text) return '';
  return text.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Check if a string is empty or only whitespace.
 * @param {string} text
 * @returns {boolean}
 */
export function isEmptyOrWhitespace(text) {
  return !text || text.trim() === '';
}
