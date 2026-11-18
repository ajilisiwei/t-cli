import { readHistory, listHistory } from '../history.js';
import { localDateDaysAgo } from './localDate.js';
import { parseHistoryFile } from './historyParser.js';
import { detectSourceLang, isWordLookup } from '@t-cli/core/detect';
import { detectSpellingCorrection } from '@t-cli/core/spelling';

/**
 * @typedef {Object} QuizEntry
 * @property {string} date - The date string (YYYY-MM-DD) of the history entry
 * @property {string} source - The text to recall a translation for
 * @property {string} target - The recorded translation
 */

/**
 * Turn one history file into quiz entries (translations only).
 *
 * Uses the shared history parser: headings are "## [HH:MM] Translation", and
 * detail responses may contain "---" lines, so neither a "translate" keyword
 * match nor splitting on "---" works. A misspelled word lookup is quizzed by
 * its corrected spelling, never by the typo.
 *
 * @param {string} date - YYYY-MM-DD file date
 * @param {string} content - Markdown history file content
 * @returns {QuizEntry[]}
 */
export function toQuizEntries(date, content) {
  return parseHistoryFile(content, date).records
    .filter((record) => record.type === 'Translation' && record.output !== '')
    .map((record) => {
      const correction = isWordLookup(record.input)
        ? detectSpellingCorrection({ input: record.input, output: record.output, srcLang: detectSourceLang(record.input), kind: 'word' })
        : null;
      return { date, source: correction ?? record.input, target: record.output };
    });
}

/**
 * Get quiz entries from history files within the specified number of days back,
 * in random order.
 *
 * @param {number} [daysBack=7] - Number of days to look back for history entries
 * @param {Date} [now] - Reference time for the cutoff (defaults to now)
 * @returns {Promise<QuizEntry[]>}
 * @throws {Error} If daysBack is not a non-negative integer
 */
export async function getQuizEntries(daysBack = 7, now = new Date()) {
  if (!Number.isInteger(daysBack) || daysBack < 0) {
    throw new Error('daysBack must be a non-negative integer');
  }

  // History files are named by local date, so the cutoff is the local date
  // `daysBack` days ago. (Older files are named by UTC date; at the cutoff
  // that shifts the window by the UTC offset at most.)
  const cutoffStr = localDateDaysAgo(daysBack, now);

  // listHistory() returns [{ date, count }], not filenames.
  const entries = listHistory()
    .filter((h) => h && typeof h.date === 'string' && h.date >= cutoffStr)
    .flatMap(({ date }) => {
      const content = readHistory(date);
      return content ? toQuizEntries(date, content) : [];
    });

  // Shuffle entries randomly using Fisher-Yates algorithm
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }

  return entries;
}

/**
 * Parse the scorer's reply for a single answer.
 *
 * @param {string} raw - The raw response string from DeepSeek
 * @returns {{ correct: boolean, explanation: string }}
 */
export function parseQuizResponse(raw) {
  const fallback = { correct: false, explanation: '' };
  if (!raw || typeof raw !== 'string') return fallback;

  // The scorer is asked to reply with {"correct": bool, "explanation": string}.
  // Tolerate code fences / surrounding prose by grabbing the first JSON object.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const obj = JSON.parse(match[0]);
    return {
      correct: Boolean(obj.correct),
      explanation: typeof obj.explanation === 'string' ? obj.explanation.trim() : ''
    };
  } catch (_) {
    return fallback;
  }
}
