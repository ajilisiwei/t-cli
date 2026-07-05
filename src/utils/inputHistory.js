const DEFAULT_LIMIT = 100;

/**
 * Append a submitted entry to the input history.
 * Skips blank entries and consecutive duplicates; caps the list at `limit`.
 * Never mutates the given array.
 * @param {string[]} entries
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function pushHistory(entries, text, limit = DEFAULT_LIMIT) {
  const trimmed = (text || '').trim();
  if (!trimmed) return entries;
  if (entries.length > 0 && entries[entries.length - 1] === trimmed) return entries;
  const next = [...entries, trimmed];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * Compute the next history position for an arrow-key press.
 * `index` is the current position in `entries` (null when not navigating).
 * Returns null when the key press should be ignored, otherwise
 * `{ index, text }` — an index of null means "back to the draft".
 * @param {string[]} entries
 * @param {number|null} index
 * @param {'up'|'down'} direction
 * @param {string} [draft]
 * @returns {{index: number|null, text: string}|null}
 */
export function navigateHistory(entries, index, direction, draft = '') {
  if (direction === 'up') {
    if (entries.length === 0) return null;
    if (index === null) return { index: entries.length - 1, text: entries[entries.length - 1] };
    if (index === 0) return null;
    return { index: index - 1, text: entries[index - 1] };
  }
  if (index === null) return null;
  if (index >= entries.length - 1) return { index: null, text: draft };
  return { index: index + 1, text: entries[index + 1] };
}
