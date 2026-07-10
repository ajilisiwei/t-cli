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

  const relevantFiles = historyFiles.filter(file => {
    // Extract date from filename (assumes format YYYY-MM-DD.md)
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!dateMatch) return false;
    return dateMatch[1] >= cutoffStr;
  });

  const entries = [];

  for (const file of relevantFiles) {
    const date = file.replace('.md', '');
    const content = await readHistory(date);
    
    if (!content) continue;

    // Parse history entries - each entry is separated by "---" or newlines
    // Format: ## type\n- **Input:** source\n- **Response:** target
    const blocks = content.split(/^---\s*$/m);
    
    for (const block of blocks) {
      const trimmedBlock = block.trim();
      if (!trimmedBlock) continue;

      // Extract type from heading
      const typeMatch = trimmedBlock.match(/^##\s+(translate|check)/im);
      if (!typeMatch) continue;

      const type = typeMatch[1].toLowerCase();
      
      // Only include translation entries (not checks) for quiz material
      if (type !== 'translate') continue;

      // Extract source text
      const sourceMatch = trimmedBlock.match(/\*\*Input:\*\*\s*(.+)/i);
      if (!sourceMatch) continue;

      // Extract target/response text
      const targetMatch = trimmedBlock.match(/\*\*Response:\*\*\s*(.+)/i);
      if (!targetMatch) continue;

      const source = sourceMatch[1].trim();
      const target = targetMatch[1].trim();

      // Skip empty entries or entries that are just checks
      if (!source || !target) continue;

      entries.push({
        date,
        source,
        target,
        type
      });
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
 * Build a system prompt for DeepSeek to present quiz entries as fill-in-the-blank questions
 * and score user answers.
 *
 * @param {QuizEntry[]} entries - Array of quiz entries to include in the prompt
 * @returns {string} The constructed system prompt
 * @throws {Error} If entries array is empty
 */
export function buildQuizPrompt(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('entries must be a non-empty array');
  }

  const entryList = entries.map((entry, index) => {
    return `Entry ${index + 1}:
- Source: ${entry.source}
- Target: ${entry.target}
- Date: ${entry.date}`;
  }).join('\n\n');

  return `You are an active recall quiz master. I will provide you with translation pairs from my learning history. For each pair, you need to:

1. Present the source text and ask me to provide the translation (fill-in-the-blank style)
2. Wait for my answer
3. Score my answer (correct/partially correct/incorrect)
4. Provide the correct answer and any helpful notes

Here are the entries to quiz me on:

${entryList}

Instructions:
- Present ONE entry at a time
- For each entry, first show the source text and ask for the translation
- After I respond, evaluate my answer and provide:
  - A score (0-100)
  - The correct answer
  - Brief feedback on what I got right/wrong
- Then move to the next entry
- At the end, provide a summary of my overall score

Format your response for each entry as:
QUESTION: [source text]
[wait for user answer]
SCORE: [score]/100
CORRECT: [correct translation]
FEEDBACK: [brief feedback]`;
}

/**
 * Parse the raw response from DeepSeek to extract score and corrections.
 *
 * @param {string} raw - The raw response string from DeepSeek
 * @returns {Object} Parsed quiz result with score and corrections
 * @property {number} score - The overall score (0-100)
 * @property {Array<{question: string, userAnswer: string, correctAnswer: string, score: number, feedback: string}>} corrections - Array of individual entry results
 * @property {string} summary - Overall summary text if present
 */
export function parseQuizResponse(raw) {
  if (!raw || typeof raw !== 'string') {
    return {
      score: 0,
      corrections: [],
      summary: ''
    };
  }

  const corrections = [];
  let overallScore = 0;
  let summary = '';

  // Split response into individual entry blocks
  const entryBlocks = raw.split(/(?=QUESTION:)/i);

  for (const block of entryBlocks) {
    const trimmedBlock = block.trim();
    if (!trimmedBlock) continue;

    // Extract question
    const questionMatch = trimmedBlock.match(/QUESTION:\s*(.+?)(?:\n|$)/i);
    const question = questionMatch ? questionMatch[1].trim() : '';

    // Extract user answer (text between QUESTION and SCORE)
    const userAnswerMatch = trimmedBlock.match(/QUESTION:.*?\n([\s\S]*?)(?=SCORE:)/i);
    const userAnswer = userAnswerMatch ? userAnswerMatch[1].trim() : '';

    // Extract score
    const scoreMatch = trimmedBlock.match(/SCORE:\s*(\d+)\/100/i);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;

    // Extract correct answer
    const correctMatch = trimmedBlock.match(/CORRECT:\s*(.+?)(?:\n|$)/i);
    const correctAnswer = correctMatch ? correctMatch[1].trim() : '';

    // Extract feedback
    const feedbackMatch = trimmedBlock.match(/FEEDBACK:\s*(.+?)(?:\n|$)/i);
    const feedback = feedbackMatch ? feedbackMatch[1].trim() : '';

    if (question || correctAnswer) {
      corrections.push({
        question,
        userAnswer,
        correctAnswer,
        score,
        feedback
      });
    }
  }

  // Try to extract overall summary
  const summaryMatch = raw.match(/SUMMARY:?\s*([\s\S]*?)$/i);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  // Calculate overall score from individual scores
  if (corrections.length > 0) {
    const totalScore = corrections.reduce((sum, entry) => sum + entry.score, 0);
    overallScore = Math.round(totalScore / corrections.length);
  }

  return {
    score: overallScore,
    corrections,
    summary
  };
}
