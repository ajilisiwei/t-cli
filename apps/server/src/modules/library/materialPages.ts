import type { Exercises } from '../pipeline/learnContent.ts';
import type { MaterialKind } from './materials.ts';

/**
 * Estimated A4 pages of a material's PDF in the practice layout (the
 * `pages` of a material list item). A deliberately simple line count:
 * about PAGE_LINES body lines fit on an A4 page, each section costs a fixed
 * number of lines per entry, running text costs one line per LINE_CHARS
 * (English) or CJK_LINE_CHARS (Chinese) characters, and the practice layout
 * adds an answer section. The PDF export may refine it; the weekly report
 * has no PDF (0).
 */

export const PAGE_LINES = 46;
const LINE_CHARS = 80;
const CJK_LINE_CHARS = 38;

/** Lines per entry, by section. */
const LINES = {
  header: 4,
  heading: 2,
  word: 6,
  phrase: 5,
  grammar: 7,
  mistake: 3,
  review: 1,
  cloze: 2,
  translate: 3,
  fix: 3,
  answer: 1,
  extendItem: 4,
  reason: 1,
  grammarExample: 2,
} as const;

const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const textLength = (value: unknown): number => (typeof value === 'string' ? [...value].length : 0);

/** Lines of running English text and its Chinese translation, with a heading. */
function passageLines(passage: Record<string, unknown> | null): number {
  if (!passage) return 0;
  return LINES.heading + Math.ceil(textLength(passage.text) / LINE_CHARS) + Math.ceil(textLength(passage.zh) / CJK_LINE_CHARS);
}

const section = (count: number, perEntry: number): number => (count > 0 ? LINES.heading + count * perEntry : 0);

function exerciseLines(exercises: Exercises | null): number {
  if (!exercises) return 0;
  const { cloze, translate, fix, bank } = exercises;
  const total = cloze.length + translate.length + fix.length;
  if (total === 0) return 0;
  const questions = section(cloze.length, LINES.cloze) + (bank.length > 0 ? LINES.heading : 0) + section(translate.length, LINES.translate) + section(fix.length, LINES.fix);
  return questions + LINES.heading + total * LINES.answer;
}

function dailyLines(content: Record<string, unknown>, exercises: Exercises | null): number {
  return (
    LINES.header +
    section(arrayOf(content.words).length, LINES.word) +
    section(arrayOf(content.phrases).length, LINES.phrase) +
    section(arrayOf(content.grammar).length, LINES.grammar) +
    passageLines(recordOf(content.story)) +
    section(arrayOf(content.mistakes).length, LINES.mistake) +
    section(arrayOf(content.review).length, LINES.review) +
    exerciseLines(exercises)
  );
}

function extendLines(content: Record<string, unknown>): number {
  const grammar = recordOf(content.grammar);
  const grammarLines = grammar
    ? LINES.heading + Math.ceil(textLength(grammar.rule) / CJK_LINE_CHARS) + arrayOf(grammar.examples).length * LINES.grammarExample
    : 0;
  return (
    LINES.header +
    arrayOf(content.reasons).length * LINES.reason +
    section(arrayOf(content.items).length, LINES.extendItem) +
    passageLines(recordOf(content.passage)) +
    grammarLines
  );
}

export function estimatePages(kind: MaterialKind, content: Record<string, unknown>, exercises: Exercises | null): number {
  if (kind === 'weekly') return 0;
  const lines = kind === 'extend' ? extendLines(content) : dailyLines(content, exercises);
  return Math.max(1, Math.ceil(lines / PAGE_LINES));
}
