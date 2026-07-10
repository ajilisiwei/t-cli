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

/**
 * Count the number of words in a string.
 * Splits the input by whitespace, filters out empty strings, and returns the count.
 * Returns 0 for null, undefined, or empty input.
 * @param {string} text - The input string to count words from
 * @returns {number} The number of words in the input string
 */
export function wordCount(text) {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  return words.length;
}