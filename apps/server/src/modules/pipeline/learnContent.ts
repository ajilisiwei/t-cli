import { z } from 'zod';
import type { DailyMaterial } from './materials.ts';
import { findTarget } from './text.ts';

/**
 * v3 learning content shared by the materials API, the nightly pipeline and
 * the PDF export (docs/api-v1.md, "v3 → Materials"; docs/v3-plan.html §4):
 * the weekly digest, the extension material, and the exercises derived from
 * a material's own words, phrases and grammar points (no model call).
 */

const text = (max: number) => z.string().trim().min(1).max(max);

// ------------------------------------------------------------ digest

/** Caps of a digest (每周模式的 7 天合集); a daily material keeps DAILY_CAPS. */
export const DIGEST_CAPS = { words: 20, phrases: 10, grammar: 6, mistakes: 8, review: 12 } as const;

/** A unit forgotten in review during the digest's range ("本周复习时忘过的"). */
export interface ReviewRecap {
  itemId: string;
  display: string;
  /** The first meaning, in the explanation language. */
  gloss: string;
  /** Ratings of 忘记 in the range. */
  lapses: number;
}

/** A daily material over a range of days, plus what was forgotten in review then. */
export interface DigestMaterial extends DailyMaterial {
  range: { start: string; end: string };
  review: ReviewRecap[];
}

// ------------------------------------------------------------ extension

export const EXTEND_TOPICS = ['work', 'travel', 'exam', 'daily', 'tech', 'culture', 'finance', 'health', 'other'] as const;
export type ExtendTopic = (typeof EXTEND_TOPICS)[number];
export const EXTEND_FOCUS = ['topic', 'family', 'grammar', 'reading'] as const;
export const STUDY_LEVELS = ['A2', 'B1', 'B2', 'C1'] as const;
export type StudyLevel = (typeof STUDY_LEVELS)[number];

const ExtendItemSchema = z.object({
  text: text(80),
  kind: z.enum(['word', 'phrase']),
  gloss: text(120),
  example: z.object({ en: text(300), zh: text(300) }),
});

/**
 * 拓展资料 as stored in `materials.content` (kind `extend`). `reasons` are
 * written by the server from `evidence` and the account's statistics, never
 * by the model; `evidence` holds only lemmas taken from the account's own data.
 */
export const ExtendContentSchema = z.object({
  focus: z.enum(EXTEND_FOCUS),
  topic: z.enum(EXTEND_TOPICS),
  title: text(60),
  level: z.enum(STUDY_LEVELS),
  reasons: z.array(text(120)).min(1).max(4),
  evidence: z.array(text(60)).max(12),
  items: z.array(ExtendItemSchema).min(6).max(10),
  passage: z.object({ title: text(120), text: text(1500), zh: text(1500) }).nullable(),
  grammar: z
    .object({ rule: text(600), examples: z.array(z.object({ wrong: text(300), right: text(300) })).max(3) })
    .nullable(),
});
export type ExtendMaterial = z.infer<typeof ExtendContentSchema>;

// ------------------------------------------------------------ exercises

export const EXERCISE_CAPS = { cloze: 8, translate: 3, fix: 4 } as const;
/** A translation exercise's English answer stays short enough for two written lines. */
const TRANSLATE_MAX_CHARS = 120;

/** 选词填空: the sentence around the blank; `answer` is the form the sentence uses ("postponed"). */
export interface ClozeExercise {
  itemId: string;
  before: string;
  after: string;
  answer: string;
  /** The headword or phrase the answer comes from, as listed in `bank`. */
  base: string;
  zh: string;
}

/** 中译英: translate `zh`; `answer` is the example's English sentence. */
export interface TranslateExercise {
  itemId: string;
  zh: string;
  answer: string;
}

/** 改错: rewrite `wrong`; `right` is the answer. */
export interface FixExercise {
  itemId: string;
  wrong: string;
  right: string;
}

export interface Exercises {
  /** The word bank of the cloze: every base used, plus at most one unused word, sorted. */
  bank: string[];
  cloze: ClozeExercise[];
  translate: TranslateExercise[];
  fix: FixExercise[];
}

type Practicable = Pick<DailyMaterial, 'words' | 'phrases' | 'grammar'>;

interface Candidate {
  itemId: string;
  base: string;
  examples: readonly { en: string; zh: string }[];
}

const candidatesOf = (material: Practicable): Candidate[] => [
  ...material.words.map((word) => ({ itemId: word.itemId, base: word.headword, examples: word.examples })),
  ...material.phrases.map((phrase) => ({ itemId: phrase.itemId, base: phrase.phrase, examples: phrase.examples })),
];

function clozeOf(candidate: Candidate): ClozeExercise | null {
  for (const example of candidate.examples) {
    const hit = findTarget(example.en, candidate.base);
    if (!hit) continue;
    return {
      itemId: candidate.itemId,
      before: example.en.slice(0, hit.index),
      after: example.en.slice(hit.index + hit.text.length),
      answer: hit.text,
      base: candidate.base,
      zh: example.zh,
    };
  }
  return null;
}

/**
 * The exercises of a daily material or a digest, derived deterministically
 * from its content: the same material always gives the same exercises, so
 * the app and the PDF agree without storing them.
 */
export function exercisesFor(material: Practicable): Exercises {
  const candidates = candidatesOf(material);
  const cloze: ClozeExercise[] = [];
  const used = new Set<string>();
  for (const candidate of candidates) {
    if (cloze.length >= EXERCISE_CAPS.cloze) break;
    const exercise = clozeOf(candidate);
    if (!exercise) continue;
    cloze.push(exercise);
    used.add(candidate.itemId);
  }

  const spare = candidates.find((candidate) => !used.has(candidate.itemId));
  const bank = [...new Set([...cloze.map((exercise) => exercise.base), ...(spare ? [spare.base] : [])])].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );

  // Translations prefer units the cloze did not use, then any; shortest English first per unit.
  const ordered = [...candidates.filter((c) => !used.has(c.itemId)), ...candidates.filter((c) => used.has(c.itemId))];
  const translate: TranslateExercise[] = [];
  for (const candidate of ordered) {
    if (translate.length >= EXERCISE_CAPS.translate) break;
    const example = [...candidate.examples]
      .filter((e) => e.en.length <= TRANSLATE_MAX_CHARS && e.zh.length > 0)
      .sort((a, b) => a.en.length - b.en.length)[0];
    if (example) translate.push({ itemId: candidate.itemId, zh: example.zh, answer: example.en });
  }

  const fix: FixExercise[] = [];
  for (const point of material.grammar) {
    for (const exercise of point.exercises) {
      if (fix.length >= EXERCISE_CAPS.fix) break;
      fix.push({ itemId: point.itemId, wrong: exercise.wrong, right: exercise.right });
    }
  }

  return { bank, cloze, translate, fix };
}
