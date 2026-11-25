import type { Exercises } from '../pipeline/learnContent.ts';
import type { MaterialKind } from './materials.ts';

/**
 * Estimated A4 pages of a material's PDF in the practice layout (the
 * `pages` of a material list item), as the export's templates
 * (export/templates/material.typ) lay it out with every part shown. The
 * heights below, in pt, are what each block takes on the page, fitted
 * against Typst renders of daily materials, digests and extensions of every
 * size built from the export fixtures' content (test/helpers/exportFixtures.ts):
 * about 94% of daily and digest estimates and 98% of extension estimates are
 * exact, the rest one page off. The weekly report has no PDF (0).
 */

/** The text area of an A4 page: 297 mm less the 26 mm top and 22 mm bottom margins. */
export const PAGE_BODY_PT = Math.round(((297 - 26 - 22) * 72) / 25.4);

/**
 * The heights are averages that include what page breaks before unbreakable
 * rows waste; a material ending within this much past a page boundary
 * usually fits on the pages before it, so it counts as fitting.
 */
const LEEWAY_PT = 50;

/** Daily material and digest. */
const PERIODIC_PT = {
  /** Kicker, title, subtitle and the counts row. */
  head: 92,
  /** With words or phrases: the 重点词 heading and table head, the 练习 group titles and word bank, the 自测清单 heading, intro and table head. */
  units: 213,
  /** One word or phrase: its 重点词 row and its 自测清单 row. */
  unit: 69,
  /** 情景短文 (heading, title, text and hint), per character of its text. */
  storyChar: 0.45,
  /** The 练习 heading. */
  exercises: 37,
  cloze: 30,
  translate: 66,
  fix: 54,
  /** The 易错提醒 heading. */
  mistakes: 31,
  /** A row of two grammar pairs. */
  pairRow: 89,
  /** The heading of the recap rows (复习时常忘的 / 复习时忘过的) … */
  recapHead: 52,
  /** … and one row: a mistake, or a unit forgotten in a digest's range. */
  recap: 23,
  /** The cut line and the 答案 heading. */
  answers: 62,
  /** One answer line: an exercise group, or 短文大意. */
  answer: 28,
} as const;

/** Extension. */
const EXTEND_PT = {
  /** Kicker, title, subtitle, the 词汇 and 自测清单 headings and table heads. */
  head: 219,
  /** One line of 为什么推荐给你. */
  reason: 12,
  /** One item: its 词汇 row and its 自测清单 row. */
  item: 56,
  /** 短文: heading, title, hint and its 短文大意 answer line … */
  passage: 156,
  /** … and its text, per character. */
  passageChar: 0.14,
  /** 语法: heading and rule. */
  grammar: 50,
  /** With grammar examples: the 练习 heading, the 改错 group and its answer line … */
  exercises: 45,
  /** … and one 改错 item. */
  fix: 60,
  /** The cut line and the 答案 heading. */
  answers: 66,
} as const;

const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const recordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const textLength = (value: unknown): number => (typeof value === 'string' ? [...value].length : 0);
const when = (condition: boolean, pt: number): number => (condition ? pt : 0);

/** The height (pt) of a daily material or digest; `exercises` as derived for it (exercisesFor). */
export function periodicHeight(content: Record<string, unknown>, exercises: Exercises | null): number {
  const P = PERIODIC_PT;
  const units = arrayOf(content.words).length + arrayOf(content.phrases).length;
  const grammar = arrayOf(content.grammar).length;
  const recaps = arrayOf(content.mistakes).length + arrayOf(content.review).length;
  const story = recordOf(content.story);
  const cloze = exercises?.cloze.length ?? 0;
  const translate = exercises?.translate.length ?? 0;
  const fix = exercises?.fix.length ?? 0;
  const answers = [cloze, translate, fix].filter((n) => n > 0).length + (story && textLength(story.zh) > 0 ? 1 : 0);
  return (
    P.head +
    when(units > 0, P.units + units * P.unit) +
    (story ? textLength(story.text) * P.storyChar : 0) +
    when(cloze + translate + fix > 0, P.exercises + cloze * P.cloze + translate * P.translate + fix * P.fix) +
    when(grammar + recaps > 0, P.mistakes + Math.ceil(grammar / 2) * P.pairRow) +
    when(recaps > 0, P.recapHead + recaps * P.recap) +
    when(answers > 0, P.answers + answers * P.answer)
  );
}

/** The height (pt) of an extension. */
export function extendHeight(content: Record<string, unknown>): number {
  const X = EXTEND_PT;
  const passage = recordOf(content.passage);
  const grammar = recordOf(content.grammar);
  const fix = grammar ? arrayOf(grammar.examples).length : 0;
  return (
    X.head +
    arrayOf(content.reasons).length * X.reason +
    arrayOf(content.items).length * X.item +
    (passage ? X.passage + textLength(passage.text) * X.passageChar : 0) +
    when(grammar !== null, X.grammar) +
    when(fix > 0, X.exercises + fix * X.fix) +
    when(fix > 0 || passage !== null, X.answers)
  );
}

export function estimatePages(kind: MaterialKind, content: Record<string, unknown>, exercises: Exercises | null): number {
  if (kind === 'weekly') return 0;
  const height = kind === 'extend' ? extendHeight(content) : periodicHeight(content, exercises);
  return Math.max(1, Math.ceil((height - LEEWAY_PT) / PAGE_BODY_PT));
}
