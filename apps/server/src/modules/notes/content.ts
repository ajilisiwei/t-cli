import { createHash } from 'node:crypto';
import { LexiconEntrySchema } from '../lookup/lexicon.ts';
import { WordContentSchema, type WordContent } from '../pipeline/schemas.ts';
import { findTarget } from '../pipeline/text.ts';

/**
 * Pure pieces of linking a note to its learning unit (docs/api-v1.md,
 * "v2 → Notes"): the word content built from a lexicon entry, and the dedup
 * key of a sentence.
 */

/** Examples a word item carries (WordContent has exactly two). */
const WORD_EXAMPLES = 2;

/**
 * A word item's content from a lexicon entry: headword = lemma, ipa = the
 * American IPA, meanings = senses, the first two examples, collocations,
 * contrasts as synonyms, the forms as the word family. Null when the entry
 * is not a valid LexiconEntry, the result does not fit WordContent, or no
 * example contains the headword (the cloze card needs one): the item then
 * stays `pending` for the nightly pipeline.
 */
export function wordContentFromLexicon(raw: unknown): WordContent | null {
  const entry = LexiconEntrySchema.safeParse(raw);
  if (!entry.success) return null;
  const { lemma, ipa, senses, examples, collocations, contrasts, forms } = entry.data;
  const content = WordContentSchema.safeParse({
    headword: lemma,
    ipa: ipa.us,
    meanings: senses.map((sense) => ({ pos: sense.pos, zh: sense.gloss })),
    examples: examples.slice(0, WORD_EXAMPLES).map((example) => ({ en: example.text, zh: example.gloss, fromUser: false })),
    collocations: collocations.map((collocation) => collocation.text),
    synonyms: contrasts.map((contrast) => ({ word: contrast.word, note: contrast.note })),
    family: forms.map((form) => form.form),
  });
  if (!content.success) return null;
  const { headword } = content.data;
  return content.data.examples.some((example) => findTarget(example.en, headword)) ? content.data : null;
}

/**
 * `normKey` of a sentence item: SHA-256 (hex) of the lowercased,
 * whitespace-collapsed text, so the unique index stays small for long text.
 */
export function sentenceKey(text: string): string {
  return createHash('sha256').update(text.trim().replace(/\s+/g, ' ').toLowerCase(), 'utf8').digest('hex');
}
