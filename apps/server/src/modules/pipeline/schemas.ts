import { z } from 'zod';

/**
 * Zod schemas for everything the pipeline accepts from the model. The content
 * schemas mirror docs/api-v1.md "Content shapes" exactly: z.object strips any
 * extra key, so what is stored has precisely the contract's fields.
 */

export type ItemType = 'word' | 'phrase' | 'grammar';
export type ExplanationLang = 'zh' | 'en';

const text = (max: number) => z.string().trim().min(1).max(max);

const ExampleSchema = z.object({ en: text(300), zh: text(300), fromUser: z.boolean() });

const atMostOneFromUser = (examples: readonly { fromUser: boolean }[]): boolean =>
  examples.filter((example) => example.fromUser).length <= 1;

export const WordContentSchema = z.object({
  headword: text(60),
  ipa: z.string().trim().max(80).regex(/^\/[^/\n]+\/$/, 'IPA must be wrapped in slashes'),
  meanings: z.array(z.object({ pos: text(20), zh: text(200) })).min(1).max(6),
  examples: z.array(ExampleSchema).length(2).refine(atMostOneFromUser, 'at most one example may come from the user'),
  collocations: z.array(text(80)).max(8),
  synonyms: z.array(z.object({ word: text(60), note: text(200) })).max(5),
  family: z.array(text(60)).max(8),
});

export const PhraseContentSchema = z.object({
  phrase: text(80),
  zh: text(200),
  register: z.enum(['formal', 'neutral', 'casual']),
  alternatives: z.array(z.object({ en: text(160), note: text(200) })).length(2),
  examples: z.array(ExampleSchema).min(1).max(3).refine(atMostOneFromUser, 'at most one example may come from the user'),
});

export const GrammarContentSchema = z.object({
  title: text(80),
  rule: text(600),
  wrong: text(300),
  right: text(300),
  exercises: z.array(z.object({ wrong: text(300), right: text(300) })).length(3),
});

export type WordContent = z.infer<typeof WordContentSchema>;
export type PhraseContent = z.infer<typeof PhraseContentSchema>;
export type GrammarContent = z.infer<typeof GrammarContentSchema>;

export type ItemContent =
  | { type: 'word'; content: WordContent }
  | { type: 'phrase'; content: PhraseContent }
  | { type: 'grammar'; content: GrammarContent };

export const CONTENT_SCHEMAS = {
  word: WordContentSchema,
  phrase: PhraseContentSchema,
  grammar: GrammarContentSchema,
} as const;

/** Stored content of an item, re-validated on read (null when it does not fit its type's shape). */
export function parseStoredContent(type: ItemType, content: unknown): ItemContent | null {
  if (type === 'word') {
    const parsed = WordContentSchema.safeParse(content);
    return parsed.success ? { type, content: parsed.data } : null;
  }
  if (type === 'phrase') {
    const parsed = PhraseContentSchema.safeParse(content);
    return parsed.success ? { type, content: parsed.data } : null;
  }
  const parsed = GrammarContentSchema.safeParse(content);
  return parsed.success ? { type, content: parsed.data } : null;
}

// ------------------------------------------------------------- model answers

// Batch envelopes: the list is checked here, each entry on its own, so one
// bad entry does not discard the rest of the batch.
export const ExtractionEnvelopeSchema = z.object({ records: z.array(z.unknown()) });
export const GenerationEnvelopeSchema = z.object({ items: z.array(z.unknown()) });

export const ExtractedRecordSchema = z.object({
  ref: z.string(),
  units: z.array(z.unknown()).max(10),
});

export const ExtractedUnitSchema = z.object({
  type: z.enum(['word', 'phrase', 'grammar']),
  text: z.string().trim().min(1).max(120),
  key: z.string().trim().max(80).nullish(),
});

export const GeneratedItemSchema = z.object({ ref: z.string(), content: z.unknown() });

export const StorySchema = z.object({
  title: text(120),
  text: text(1500),
  words: z.array(text(60)).min(5).max(8),
  zh: text(1500),
});

export const MistakeNoteSchema = z.object({
  ref: z.string(),
  note: text(300),
  example: z.object({ en: text(300), zh: text(300) }),
});

export const DailyExtrasSchema = z.object({
  story: z.unknown().optional(),
  mistakes: z.array(z.unknown()).optional(),
});

export const WeeklySummarySchema = z.object({ summary: text(1200) });
