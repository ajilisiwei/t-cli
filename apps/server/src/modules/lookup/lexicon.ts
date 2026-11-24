import { ULID_RE } from '@t-cli/core/ulid';
import { z } from 'zod';
import { wordKey } from '../pipeline/text.ts';

/**
 * Shapes of `POST /v1/lookup` (docs/api-v1.md, "v2 → Lookup"): the request
 * body, the shared lexicon entry (`lexicon.content`) and the per-sentence
 * context. Validation only; the route lives with the lookup feature.
 *
 * Field names are language-neutral (`gloss`, never `zh`): glosses, labels and
 * notes are in the explanation language, `text`, `def` and examples in the
 * learning language (English in v2).
 */

/** Format version of `lexicon.content`: part of the cache key, bumped when the shape or prompt changes. */
export const LEXICON_VERSION = 1;
/** The only learning language in v2 (BCP 47). */
export const LEARNING_LANG = 'en';

export const LOOKUP_WORD_MAX_CHARS = 64;
export const LOOKUP_SENTENCE_MAX_CHARS = 2000;
export const LEMMA_MAX_CHARS = 60;

const codePoints = (value: string): number => [...value].length;
const straightQuotes = (value: string): string => value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const collapse = (value: string): string => value.trim().replace(/\s+/g, ' ');

/** Trimmed text of 1–`max` code points. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => codePoints(value) <= max, `must be at most ${max} characters`);

/** Trimmed text of 0–`max` code points (empty = none). */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .refine((value) => codePoints(value) <= max, `must be at most ${max} characters`);

/** IPA wrapped in slashes, as the word content of items has it (`/dɪˈsɪʒ.ən/`). */
const Ipa = z
  .string()
  .trim()
  .max(80)
  .regex(/^\/[^/\n]+\/$/, 'IPA must be wrapped in slashes');

const Gloss = z.object({ text: text(80), gloss: text(120) });

/**
 * One lexicon entry. The limits are chosen so that a word item's content
 * (WordContent in the contract) can be built from an entry without clipping.
 */
export const LexiconEntrySchema = z.object({
  /** Display form of the base form ("decision", "look forward to", "Paris"). */
  lemma: text(LEMMA_MAX_CHARS),
  ipa: z.object({ us: Ipa, uk: Ipa }),
  /** Part of speech (≤ 20, e.g. "n."), short gloss, one-sentence English definition. */
  senses: z.array(z.object({ pos: text(20), gloss: text(120), def: text(300) })).min(1).max(6),
  /** Inflections and derived forms: label in the explanation language ("复数"), the form. */
  forms: z.array(z.object({ label: text(20), form: text(60) })).max(8),
  collocations: z.array(Gloss).max(8),
  /** English example sentence and its translation. */
  examples: z.array(z.object({ text: text(300), gloss: text(300) })).min(2).max(4),
  /** Near-synonyms and how they differ. */
  contrasts: z.array(z.object({ word: text(60), note: text(200) })).max(4),
  /** A memory aid in the explanation language; empty when there is none. */
  memory: optionalText(300),
});
export type LexiconEntry = z.infer<typeof LexiconEntrySchema>;

/** 在本句中: the word's meaning in the sentence and the phrase it belongs to there. */
export const LookupContextSchema = z.object({
  meaning: text(200),
  phrase: z.object({ text: text(80), gloss: text(120) }).nullable(),
});
export type LookupContext = z.infer<typeof LookupContextSchema>;

const Ulid = z.string().regex(ULID_RE, 'must be a ULID');

/**
 * `POST /v1/lookup` body. `word` is a word or a phrase of adjacent words
 * (whitespace collapsed, curly quotes straightened) with at least one Latin
 * letter; an empty `sentence` counts as absent.
 */
export const LookupBody = z.strictObject({
  word: text(LOOKUP_WORD_MAX_CHARS)
    .transform((value) => collapse(straightQuotes(value)))
    .refine((value) => /\p{Script=Latin}/u.test(value), 'must contain a Latin letter'),
  sentence: optionalText(LOOKUP_SENTENCE_MAX_CHARS)
    .optional()
    .transform((value) => (value ? value : undefined)),
  entryId: Ulid.optional(),
});
export type LookupBody = z.infer<typeof LookupBody>;

/**
 * The `lexicon.lemma` key of a lemma: curly quotes straightened, whitespace
 * collapsed, lowercased — the same key as a word item's `normKey`, so a
 * saved word and its pipeline-extracted item meet.
 */
export const lexiconKey = (lemma: string): string => wordKey(lemma);
