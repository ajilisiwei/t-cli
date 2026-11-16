import { readHistory, listHistory } from '../history.js';

/**
 * @typedef {Object} QuizEntry
 * @property {string} date - The date string (YYYY-MM-DD) of the history entry
 * @property {string} source - The source text that was translated/checked
 * @property {string} target - The translated/checked result
 * @property {string} type - The type of entry ('translate' or 'check')
 */

/**
 * Get quiz entries from history files within the specified number of days back.
 * Filters entries that have translation content (not just checks) and picks random entries.
 *
 * @param {number} [daysBack=7] - Number of days to look back for history entries
 * @returns {Promise<QuizEntry[]>} Array of quiz entries with source, target, date, and type
 * @throws {Error} If daysBack is negative or NaN
 */
export async function getQuizEntries(daysBack = 7) {
  if (typeof daysBack !== 'number' || isNaN(daysBack) || daysBack < 0) {
    throw new Error('daysBack must be a non-negative number');
  }

  const historyFiles = await listHistory();
  
  // Filter files within the specified date range
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];

  // listHistory() returns [{ date, count }], not filenames.
  const relevantFiles = historyFiles.filter(
    (h) => h && typeof h.date === 'string' && h.date >= cutoffStr
  );

  const entries = [];

  for (const { date } of relevantFiles) {
    const content = readHistory(date);

    if (!content) continue;

    // Parse history entries - each entry is separated by "---" or newlines
    // Format: ## type\n- **Input:** source\n- **Response:** target
    const blocks = content.split(/^---\s*$/m);
    
    for (const block of blocks) {
      const trimmedBlock = block.trim();
      if (!trimmedBlock) continue;

      // Heading is "## [HH:MM] translate" — a time tag precedes the type.
      const typeMatch = trimmedBlock.match(/^##\s+(?:\[[^\]]*\]\s+)?(translate|check)/im);
      if (!typeMatch || typeMatch[1].toLowerCase() !== 'translate') continue;

      // Format: "**Input:** <source>" then the raw translation on following lines
      // (saveHistory writes no "**Response:**" label).
      const sourceMatch = trimmedBlock.match(/\*\*Input:\*\*\s*(.+)/i);
      if (!sourceMatch) continue;

      const source = sourceMatch[1].trim();
      const target = trimmedBlock
        .slice(trimmedBlock.indexOf(sourceMatch[0]) + sourceMatch[0].length)
        .trim();

      if (!source || !target) continue;

      entries.push({ date, source, target });
    }
  }

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
