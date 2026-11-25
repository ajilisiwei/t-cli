import { and, eq, sql } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import type { Executor } from '../../db/client.ts';
import { items, lexicon } from '../../db/schema.ts';
import { LEARNING_LANG, LEXICON_VERSION, lexiconKey } from '../lookup/lexicon.ts';
import { wordContentFromLexicon } from '../notes/content.ts';
import { writeContent, type ItemRow } from '../pipeline/repo.ts';
import type { ExplanationLang } from '../pipeline/schemas.ts';
import { phraseKey } from '../pipeline/text.ts';

/**
 * Learning units created outside the extraction step: from notes (v2), from
 * lookup events and from adopted extension items (v3). A new word gets its
 * content and cards at once from the shared lexicon when it has the entry;
 * anything else stays `pending` for the nightly generation. Every query
 * filters on the account's user_id; the lexicon is the one shared table.
 */

export interface UnitContext {
  userId: string;
  explanationLang: ExplanationLang;
  now: Date;
}

export interface NewUnit {
  type: 'word' | 'phrase';
  normKey: string;
  display: string;
  lookupCount?: number;
  firstSeenAt?: Date;
  lastSeenAt?: Date;
}

/** The dedup key of a word or phrase text: the lexicon (lemma) key for words, the pipeline's phrase key for phrases. */
export function unitKeyOf(type: NewUnit['type'], text: string): string {
  return type === 'word' ? lexiconKey(text) : phraseKey(text);
}

/** Insert the (user, type, normKey) unit as `pending` unless it exists. Null when it already existed (left untouched). */
export async function insertUnitIfAbsent(tx: Executor, { userId, now }: UnitContext, unit: NewUnit): Promise<ItemRow | null> {
  const [row] = await tx
    .insert(items)
    .values({
      userId,
      id: ulid({ time: now.getTime() }),
      type: unit.type,
      normKey: unit.normKey,
      display: unit.display,
      status: 'pending',
      lookupCount: unit.lookupCount ?? 0,
      firstSeenAt: unit.firstSeenAt ?? now,
      lastSeenAt: unit.lastSeenAt ?? now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [items.userId, items.type, items.normKey] })
    .returning();
  return row ?? null;
}

/** The lexicon entry of a lemma key in the account's explanation language (current version), unvalidated. */
export async function lexiconRow(
  tx: Executor,
  explanationLang: ExplanationLang,
  lemmaKey: string,
): Promise<{ content: unknown; model: string | null } | null> {
  const [entry] = await tx
    .select({ content: lexicon.content, model: lexicon.model })
    .from(lexicon)
    .where(
      and(eq(lexicon.lang, LEARNING_LANG), eq(lexicon.explainLang, explanationLang), eq(lexicon.lemma, lemmaKey), eq(lexicon.version, LEXICON_VERSION)),
    );
  return entry ?? null;
}

/**
 * A word unit without content yet gets it from the lexicon entry of its key
 * (the account's explanation language, the current version) and its cards
 * now. No entry, or one that does not make valid content → it stays as it is
 * for the nightly pipeline. True when content was written.
 */
export async function fillWordFromLexicon(tx: Executor, ctx: UnitContext, item: ItemRow): Promise<boolean> {
  if (item.type !== 'word' || item.content !== null) return false;
  const entry = await lexiconRow(tx, ctx.explanationLang, item.normKey);
  const content = entry ? wordContentFromLexicon(entry.content) : null;
  if (!entry || !content) return false;
  await writeContent(tx, ctx.userId, item, { type: 'word', content }, { model: entry.model, now: ctx.now });
  return true;
}

/** Lock and read the account's unit (type, normKey). */
export async function lockUnit(tx: Executor, userId: string, type: NewUnit['type'], normKey: string): Promise<ItemRow | null> {
  const [row] = await tx
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.type, type), eq(items.normKey, normKey)))
    .for('update');
  return row ?? null;
}

/** Add `n` lookups to an existing unit and move its lastSeenAt forward (never back). */
export async function countLookups(tx: Executor, userId: string, itemId: string, n: number, seenAt: Date): Promise<void> {
  await tx
    .update(items)
    .set({
      lookupCount: sql`${items.lookupCount} + ${n}`,
      lastSeenAt: sql`greatest(${items.lastSeenAt}, ${seenAt.toISOString()}::timestamptz)`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(items.userId, userId), eq(items.id, itemId)));
}
