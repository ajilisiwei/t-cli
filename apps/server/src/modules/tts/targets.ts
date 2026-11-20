import { and, eq } from 'drizzle-orm';
import { speakableForEntry } from '@t-cli/core/speakable';
import { z } from 'zod';
import type { Executor } from '../../db/client.ts';
import { getEntry } from '../../db/entriesRepo.ts';
import { cards, items, materials } from '../../db/schema.ts';
import { LocalDate } from '../review/common.ts';

/**
 * What `POST /v1/tts` may read aloud (docs/api-v1.md, "Speech" and "Speech
 * (extended)"): always one of the caller's own records, cards, items or
 * materials — never free text — and the server picks the words.
 */

const Id = z.string().trim().min(1).max(64);

/** Exactly one of `{ entryId }`, `{ cardId }`, `{ itemId }`, `{ material }`. */
export const TtsBody = z.union([
  z.strictObject({ entryId: Id }),
  z.strictObject({ cardId: Id }),
  z.strictObject({ itemId: Id }),
  z.strictObject({ material: z.strictObject({ kind: z.literal('daily'), date: LocalDate, section: z.literal('story') }) }),
]);
export type TtsBody = z.infer<typeof TtsBody>;

export type TtsTarget =
  | { kind: 'entry'; id: string }
  | { kind: 'card'; id: string }
  | { kind: 'item'; id: string }
  | { kind: 'material'; id: string };

export function targetOf(body: TtsBody): TtsTarget {
  if ('entryId' in body) return { kind: 'entry', id: body.entryId };
  if ('cardId' in body) return { kind: 'card', id: body.cardId };
  if ('itemId' in body) return { kind: 'item', id: body.itemId };
  return { kind: 'material', id: body.material.date };
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

/** Item → word headword, phrase, grammar `right` (display while a word or phrase has no content yet). */
async function itemText(db: Executor, userId: string, id: string): Promise<string | null> {
  const [item] = await db
    .select({ type: items.type, display: items.display, content: items.content })
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.id, id)));
  if (!item) return null;
  if (item.type === 'grammar') return textOf(fieldOf(item.content, 'right'));
  return textOf(fieldOf(item.content, item.type === 'word' ? 'headword' : 'phrase')) || item.display.trim();
}

/** The daily material's story text (`''` when the day has no story). */
async function storyText(db: Executor, userId: string, date: string): Promise<string | null> {
  const [material] = await db
    .select({ content: materials.content })
    .from(materials)
    .where(and(eq(materials.userId, userId), eq(materials.kind, 'daily'), eq(materials.date, date)));
  if (!material) return null;
  return textOf(fieldOf(fieldOf(material.content, 'story'), 'text'));
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
      return storyText(db, userId, target.id);
  }
}
