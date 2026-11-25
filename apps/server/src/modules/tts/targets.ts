import { and, eq, isNull } from 'drizzle-orm';
import { speakableForEntry } from '@t-cli/core/speakable';
import { z } from 'zod';
import type { Executor } from '../../db/client.ts';
import { getEntry } from '../../db/entriesRepo.ts';
import { cards, items, lexicon, materials, users } from '../../db/schema.ts';
import { LEARNING_LANG, LEMMA_MAX_CHARS, LEXICON_VERSION, lexiconKey } from '../lookup/lexicon.ts';
import { LocalDate } from '../review/common.ts';

/**
 * What `POST /v1/tts` may read aloud (docs/api-v1.md, "Speech", "Speech
 * (extended)", "v2 → Speech in parts", "v2 → Speech targets" and "v3 →
 * Speech targets (v3)"): always
 * one of the caller's own records, cards, items or materials, or a cached
 * lexicon entry — never free text — and the server picks the words.
 */

const Id = z.string().trim().min(1).max(64);

/** Which part of the speakable text to read (0-based, default 0); see speechParts in @t-cli/core. */
const Part = z.number().int().min(0).default(0);

/** A lexicon lemma as `POST /v1/lookup` returned it (the display form; keyed like `lexicon.lemma`). */
const Lemma = z
  .string()
  .trim()
  .min(1)
  .refine((value) => [...value].length <= LEMMA_MAX_CHARS, `must be at most ${LEMMA_MAX_CHARS} characters`);

/**
 * A section of one of the caller's materials: the story of a daily material
 * or (v3) a digest, and (v3) an extension's passage or the text of one of its
 * items (0-based `index`).
 */
const MaterialSection = z.union([
  z.strictObject({ kind: z.enum(['daily', 'digest']), date: LocalDate, section: z.literal('story') }),
  z.strictObject({ kind: z.literal('extend'), date: LocalDate, section: z.literal('passage') }),
  z.strictObject({ kind: z.literal('extend'), date: LocalDate, section: z.literal('item'), index: z.number().int().min(0) }),
]);
type MaterialSection = z.infer<typeof MaterialSection>;

/**
 * Exactly one of `{ entryId }`, `{ cardId }`, `{ itemId }`, `{ material }`,
 * `{ lexicon }`, each with an optional `part`.
 */
export const TtsBody = z.union([
  z.strictObject({ entryId: Id, part: Part }),
  z.strictObject({ cardId: Id, part: Part }),
  z.strictObject({ itemId: Id, part: Part }),
  z.strictObject({ material: MaterialSection, part: Part }),
  z.strictObject({ lexicon: z.strictObject({ lemma: Lemma, example: z.number().int().min(0).optional() }), part: Part }),
]);
export type TtsBody = z.infer<typeof TtsBody>;

export interface MaterialTarget {
  kind: 'material';
  /** The material's date. */
  id: string;
  materialKind: MaterialSection['kind'];
  section: MaterialSection['section'];
  /** The item's index for section `item`, else null. */
  index: number | null;
}

export type TtsTarget =
  | { kind: 'entry'; id: string }
  | { kind: 'card'; id: string }
  | { kind: 'item'; id: string }
  | MaterialTarget
  /** `example` null → the lemma itself, else `examples[example].text`. */
  | { kind: 'lexicon'; lemma: string; example: number | null };

export function targetOf(body: TtsBody): TtsTarget {
  if ('entryId' in body) return { kind: 'entry', id: body.entryId };
  if ('cardId' in body) return { kind: 'card', id: body.cardId };
  if ('itemId' in body) return { kind: 'item', id: body.itemId };
  if ('lexicon' in body) return { kind: 'lexicon', lemma: body.lexicon.lemma, example: body.lexicon.example ?? null };
  const { material } = body;
  return {
    kind: 'material',
    id: material.date,
    materialKind: material.kind,
    section: material.section,
    index: material.section === 'item' ? material.index : null,
  };
}

export interface LoggableTarget {
  target: TtsTarget['kind'];
  targetId?: string;
  example?: number | null;
  materialKind?: MaterialTarget['materialKind'];
  section?: MaterialTarget['section'];
  index?: number | null;
}

/**
 * What a log line may say about the target: its kind and id (for a material
 * also its kind, section and item index). A lexicon target is named by its
 * example index only — the lemma is what the user looked up and is never
 * logged.
 */
export function loggableTarget(target: TtsTarget): LoggableTarget {
  if (target.kind === 'lexicon') return { target: target.kind, example: target.example };
  if (target.kind === 'material') {
    return { target: target.kind, targetId: target.id, materialKind: target.materialKind, section: target.section, index: target.index };
  }
  return { target: target.kind, targetId: target.id };
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const fieldOf = (object: unknown, key: string): unknown =>
  object && typeof object === 'object' && !Array.isArray(object) ? (object as Record<string, unknown>)[key] : undefined;

/** Card → the "read aloud" column: recognize reads its front (the headword), every other type its back. */
async function cardText(db: Executor, userId: string, id: string): Promise<string | null> {
  const [card] = await db
    .select({ cardType: cards.cardType, front: cards.front, back: cards.back })
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.id, id)));
  if (!card) return null;
  return textOf(fieldOf(card.cardType === 'recognize' ? card.front : card.back, 'text'));
}

/** The content field an item type reads aloud (grammar: the right sentence). */
const ITEM_SPOKEN_FIELD = { word: 'headword', phrase: 'phrase', sentence: 'text', grammar: 'right' } as const;

/**
 * Item → word headword, phrase, sentence text, grammar `right`. A word,
 * phrase or sentence without that content yet reads its display (a
 * sentence's display is its text); a grammar point without it has nothing.
 */
async function itemText(db: Executor, userId: string, id: string): Promise<string | null> {
  const [item] = await db
    .select({ type: items.type, display: items.display, content: items.content })
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.id, id)));
  if (!item) return null;
  const spoken = textOf(fieldOf(item.content, ITEM_SPOKEN_FIELD[item.type]));
  return item.type === 'grammar' ? spoken : spoken || item.display.trim();
}

/**
 * A material section's text: the story's text of a daily material or digest,
 * an extension's passage text (`''` when there is no story or passage), or
 * the text of its item `index` (null when there is no such item).
 */
async function materialText(db: Executor, userId: string, target: MaterialTarget): Promise<string | null> {
  const [material] = await db
    .select({ content: materials.content })
    .from(materials)
    .where(and(eq(materials.userId, userId), eq(materials.kind, target.materialKind), eq(materials.date, target.id)));
  if (!material) return null;
  const { content } = material;
  if (target.section === 'story') return textOf(fieldOf(fieldOf(content, 'story'), 'text'));
  if (target.section === 'passage') return textOf(fieldOf(fieldOf(content, 'passage'), 'text'));
  const items = fieldOf(content, 'items');
  if (!Array.isArray(items) || target.index === null || target.index >= items.length) return null;
  return textOf(fieldOf(items[target.index], 'text'));
}

/** The account's explanation language (settings.explanationLang, default zh); null for a missing account. */
async function explanationLangOf(db: Executor, userId: string): Promise<'zh' | 'en' | null> {
  const [user] = await db
    .select({ settings: users.settings })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  if (!user) return null;
  return user.settings.explanationLang === 'en' ? 'en' : 'zh';
}

/**
 * A cached lexicon entry's lemma, or the text of one of its examples, for
 * the learning language and the caller's explanation language at the
 * current LEXICON_VERSION. The lexicon holds no user rows (the documented
 * exception to filtering on user_id); reading it never counts a hit.
 * Null when the entry is not cached or has no such example.
 */
async function lexiconText(db: Executor, userId: string, { lemma, example }: { lemma: string; example: number | null }): Promise<string | null> {
  const explainLang = await explanationLangOf(db, userId);
  if (!explainLang) return null;
  const [row] = await db
    .select({ content: lexicon.content })
    .from(lexicon)
    .where(
      and(
        eq(lexicon.lang, LEARNING_LANG),
        eq(lexicon.explainLang, explainLang),
        eq(lexicon.lemma, lexiconKey(lemma)),
        eq(lexicon.version, LEXICON_VERSION),
      ),
    );
  if (!row) return null;
  if (example === null) return textOf(fieldOf(row.content, 'lemma'));
  const examples = fieldOf(row.content, 'examples');
  if (!Array.isArray(examples) || example >= examples.length) return null;
  return textOf(fieldOf(examples[example], 'text'));
}

/** The text to read for `target`, or null when it does not exist for this account. */
export async function speakableText(db: Executor, userId: string, target: TtsTarget): Promise<string | null> {
  switch (target.kind) {
    case 'entry': {
      const entry = await getEntry(db, userId, target.id);
      return entry ? speakableForEntry(entry) : null;
    }
    case 'card':
      return cardText(db, userId, target.id);
    case 'item':
      return itemText(db, userId, target.id);
    case 'material':
      return materialText(db, userId, target);
    case 'lexicon':
      return lexiconText(db, userId, target);
  }
}
