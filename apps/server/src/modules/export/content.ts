import { z } from 'zod';
import { GrammarContentSchema, PhraseContentSchema, WordContentSchema } from '../pipeline/schemas.ts';
import type { ExportMaterialKind } from './request.ts';

/**
 * Stored materials (`materials.content`), read for the PDF. The pipeline
 * validated them when it wrote them; here every list is re-checked element
 * by element and a broken element is dropped, so one bad row never turns an
 * export into a 500. Shapes: pipeline/materials.ts (DailyMaterial),
 * pipeline/learnContent.ts (DigestMaterial, ExtendMaterial).
 */

/** Elements of an array that pass `schema`; anything else (or a non-array) → []. */
const listOf = <T extends z.ZodType>(schema: T) =>
  z.unknown().transform((value): z.output<T>[] =>
    Array.isArray(value)
      ? value.flatMap((element) => {
          const parsed = schema.safeParse(element);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
  );

const str = z.string().catch('');
const count = z.number().int().min(0).catch(0);
const itemId = { itemId: z.string().min(1) };
const Example = z.object({ en: z.string(), zh: z.string() });

const DailyShape = z.object({
  date: str,
  overview: z
    .object({ newWords: count, newPhrases: count, corrections: count, streakDays: count })
    .catch({ newWords: 0, newPhrases: 0, corrections: 0, streakDays: 0 }),
  words: listOf(WordContentSchema.extend(itemId)),
  phrases: listOf(PhraseContentSchema.extend(itemId)),
  grammar: listOf(GrammarContentSchema.extend(itemId)),
  story: z.object({ title: str, text: z.string().min(1), words: listOf(z.string()), zh: str }).nullable().catch(null),
  mistakes: listOf(z.object({ itemId: z.string(), display: z.string().min(1), note: str, example: Example.catch({ en: '', zh: '' }) })),
});

const DigestShape = DailyShape.extend({
  range: z.object({ start: z.string(), end: z.string() }).nullable().catch(null),
  review: listOf(z.object({ itemId: z.string(), display: z.string().min(1), gloss: str, lapses: count })),
});

const ExtendShape = z.object({
  topic: z.string().catch('other'),
  title: str,
  level: z.string().catch(''),
  reasons: listOf(z.string().min(1)),
  items: listOf(z.object({ text: z.string().min(1), kind: z.enum(['word', 'phrase']), gloss: str, example: Example.catch({ en: '', zh: '' }) })),
  passage: z.object({ title: str, text: z.string().min(1), zh: str }).nullable().catch(null),
  grammar: z
    .object({ rule: str, examples: listOf(z.object({ wrong: z.string().min(1), right: z.string().min(1) })) })
    .nullable()
    .catch(null),
});

export type DailyContent = z.output<typeof DailyShape>;
export type DigestContent = z.output<typeof DigestShape>;
export type ExtendContent = z.output<typeof ExtendShape>;

export type LoadedMaterial =
  | { kind: 'daily'; date: string; content: DailyContent }
  | { kind: 'digest'; date: string; content: DigestContent }
  | { kind: 'extend'; date: string; content: ExtendContent };

/** A stored material as the PDF reads it; null when its content is not an object at all. */
export function parseMaterial(kind: ExportMaterialKind, date: string, content: unknown): LoadedMaterial | null {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return null;
  if (kind === 'daily') return { kind, date, content: DailyShape.parse(content) };
  if (kind === 'digest') return { kind, date, content: DigestShape.parse(content) };
  return { kind, date, content: ExtendShape.parse(content) };
}
