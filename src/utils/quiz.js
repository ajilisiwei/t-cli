// src/utils/quiz.js

import { getHistory } from './history.js';
import { getNotes } from './notes.js';
import { streamCompletion } from '../api.js';

/**
 * Default number of days to look back for history/notes.
 * @type {number}
 */
const DEFAULT_DAYS = 7;

/**
 * Default number of quiz questions to generate.
 * @type {number}
 */
const DEFAULT_QUESTION_COUNT = 5;

/**
 * Selects random entries from an array.
 * @param {Array} entries - The array to select from.
 * @param {number} count - Number of entries to select.
 * @returns {Array} Randomly selected entries.
 */
function selectRandomEntries(entries, count) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }
  
  const shuffled = [...entries].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * Formats history entries for quiz display.
 * @param {Array} history - History entries.
 * @returns {Array} Formatted entries with source and content.
 */
function formatHistoryEntries(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  
  return history.map(entry => ({
    source: 'history',
    content: entry.content || entry.text || '',
    timestamp: entry.timestamp || new Date().toISOString()
  }));
}

/**
 * Formats notes for quiz display.
 * @param {Array} notes - Note entries.
 * @returns {Array} Formatted entries with source and content.
 */
function formatNoteEntries(notes) {
  if (!Array.isArray(notes)) {
    return [];
  }
  
  return notes.map(note => ({
    source: 'note',
    content: note.content || note.text || '',
    timestamp: note.timestamp || new Date().toISOString()
  }));
}

/**
 * Generates a quiz question from an entry.
 * @param {Object} entry - The entry to create a question from.
 * @returns {Object} Quiz question object with prompt and correct answer.
 */
function generateQuestion(entry) {
  if (!entry || !entry.content) {
    return null;
  }
  
  const content = entry.content.trim();
  if (content.length === 0) {
    return null;
  }
  
  // Extract key phrases or sentences for translation
  const sentences = content.match(/[^.!?]+[.!?]+/g) || [content];
  const selectedSentence = sentences[Math.floor(Math.random() * sentences.length)].trim();
  
  return {
    prompt: `Translate the following text to English:\n\n"${selectedSentence}"`,
    correctAnswer: selectedSentence,
    source: entry.source,
    timestamp: entry.timestamp
  };
}

/**
 * Creates a scoring prompt for DeepSeek.
 * @param {string} userAnswer - The user's answer.
 * @param {string} correctAnswer - The correct answer.
 * @param {Object} question - The original question object.
 * @returns {string} Prompt for scoring.
 */
function createScoringPrompt(userAnswer, correctAnswer, question) {
  return `You are a language learning assistant. Evaluate the following translation attempt:

Original text: "${question.prompt.replace('Translate the following text to English:\n\n"', '').replace('"', '')}"

Correct translation: "${correctAnswer}"

User's translation attempt: "${userAnswer}"

Please provide:
1. A score from 0-10 (10 being perfect)
2. Brief feedback on what was correct and what could be improved
3. Any grammar or vocabulary suggestions

Format your response as:
Score: [number]/10
Feedback: [your feedback]
Suggestions: [any suggestions]`;
}

/**
 * Runs the active recall quiz.
 * @param {Object} [options] - Quiz options.
 * @param {number} [options.days=7] - Number of days to look back.
 * @param {number} [options.questionCount=5] - Number of questions to generate.
 * @param {Function} [options.onFeedback] - Callback for streaming feedback.
 * @returns {Promise<Array>} Array of quiz results.
 */
export async function runQuiz(options = {}) {
  const {
    days = DEFAULT_DAYS,
    questionCount = DEFAULT_QUESTION_COUNT,
    onFeedback = null
  } = options || {};

  try {
    // Fetch history and notes
    const [history, notes] = await Promise.all([
      getHistory(days),
      getNotes(days)
    ]);

    // Format and combine entries
    const formattedHistory = formatHistoryEntries(history);
    const formattedNotes = formatNoteEntries(notes);
    const allEntries = [...formattedHistory, ...formattedNotes];

    if (allEntries.length === 0) {
      console.log('No history or notes found for the specified period.');
      return [];
    }

    // Select random entries for quiz
    const selectedEntries = selectRandomEntries(allEntries, questionCount);
    
    if (selectedEntries.length === 0) {
      console.log('Could not generate quiz questions from available content.');
      return [];
    }

    // Generate questions
    const questions = selectedEntries
      .map(generateQuestion)
      .filter(q => q !== null);

    if (questions.length === 0) {
      console.log('Could not generate valid quiz questions.');
      return [];
    }

    console.log(`\n📝 Active Recall Quiz (${days} day(s) of content)`);
    console.log(`Total questions: ${questions.length}\n`);

    const results = [];

    for (let i = 0; i < questions.length; i++) {
      const question = questions[i];
      console.log(`Question ${i + 1}/${questions.length}:`);
      console.log(question.prompt);
      console.log('\nYour answer: ');

      // Wait for user input (this would be handled by the REPL)
      // For now, we'll use a placeholder
      const userAnswer = await new Promise((resolve) => {
        // In REPL context, this would be handled differently
        // For testing, we'll use a simple prompt
        process.stdin.once('data', (data) => {
          resolve(data.toString().trim());
        });
      });

      if (!userAnswer || userAnswer.toLowerCase() === 'skip') {
        console.log('Skipping question.\n');
        results.push({
          question,
          userAnswer: null,
          score: null,
          feedback: 'Skipped'
        });
        continue;
      }

      // Create scoring prompt
      const scoringPrompt = createScoringPrompt(userAnswer, question.correctAnswer, question);

      // Get feedback from DeepSeek
      console.log('\nEvaluating your answer...\n');
      
      let feedback = '';
      await streamCompletion(scoringPrompt, (chunk) => {
        feedback += chunk;
        if (onFeedback) {
          onFeedback(chunk);
        } else {
          process.stdout.write(chunk);
        }
      });

      console.log('\n'); // Add spacing after feedback

      results.push({
        question,
        userAnswer,
        score: extractScore(feedback),
        feedback
      });
    }

    // Display summary
    console.log('\n📊 Quiz Summary:');
    console.log('================');
    const answeredQuestions = results.filter(r => r.userAnswer !== null);
    const averageScore = answeredQuestions.length > 0
      ? answeredQuestions.reduce((sum, r) => sum + (r.score || 0), 0) / answeredQuestions.length
      : 0;
    console.log(`Questions answered: ${answeredQuestions.length}/${results.length}`);
    console.log(`Average score: ${averageScore.toFixed(1)}/10`);

    return results;

  } catch (error) {
    console.error('Error running quiz:', error.message);
    throw error;
  }
}

/**
 * Extracts score from feedback string.
 * @param {string} feedback - The feedback from DeepSeek.
 * @returns {number|null} Extracted score or null if not found.
 */
function extractScore(feedback) {
  if (!feedback) {
    return null;
  }
  
  const scoreMatch = feedback.match(/Score:\s*(\d+)\/10/i);
  if (scoreMatch) {
    return parseInt(scoreMatch[1], 10);
  }
  
  return null;
}

/**
 * Runs a quiz with a specific number of days.
 * @param {number} [days=7] - Number of days to look back.
 * @returns {Promise<Array>} Quiz results.
 */
export async function runQuizWithDays(days = DEFAULT_DAYS) {
  return runQuiz({ days });
}

/**
 * Runs a quiz with custom options.
 * @param {Object} options - Custom quiz options.
 * @returns {Promise<Array>} Quiz results.
 */
export async function runCustomQuiz(options) {
  return runQuiz(options);
}

export default {
  runQuiz,
  runQuizWithDays,
  runCustomQuiz
};