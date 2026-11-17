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

/**
 * Deterministically detect the translation source language.
 * Any CJK character means the source is Chinese (mixed sentences like
 * "珠宝估值的wrapped GraphQL API已部署" are Chinese with embedded English
 * terms), otherwise English. Keeps direction out of the model's hands.
 * @param {string} text
 * @returns {'zh'|'en'}
 */
export function detectSourceLang(text) {
  return containsCJK(text) ? 'zh' : 'en';
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
