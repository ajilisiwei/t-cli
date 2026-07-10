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
 * Words are defined as sequences of non-whitespace characters separated by whitespace.
 * Returns 0 for null, undefined, or empty strings.
 * @param {string} text - The input string to count words from
 * @returns {number} The number of words in the string
 */
export function wordCount(text) {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(word => word.length > 0).length;
}