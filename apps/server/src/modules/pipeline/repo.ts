import { and, asc, desc, eq, exists, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import type { Database, Executor } from '../../db/client.ts';
import { cards, entries, items, itemSources, pipelineState, users } from '../../db/schema.ts';
import { cardsFor, type CardSource, type CardSpec } from './cards.ts';
import { displayOf } from './content.ts';
import { DEFAULT_UTC_OFFSET_MINUTES } from './dates.ts';
import type { ExplanationLang, ItemType } from './schemas.ts';
import { checkSides, clip, findTarget, sidesOf, type RecordFields } from './text.ts';

/**
 * Pipeline data access. Every query filters on the account's user_id.
 */

export type ItemRow = typeof items.$inferSelect;

/** Longest learner sentence quoted into a generation prompt. */
const USER_SENTENCE_MAX = 300;

const recordColumns = {
  id: entries.id,
  seq: entries.seq,
  task: entries.task,
  kind: entries.kind,
  input: entries.input,
  output: entries.output,
  srcLang: entries.srcLang,
  mode: entries.mode,
  correctedInput: entries.correctedInput,
  createdAt: entries.createdAt,
};

/** Item types whose content the model writes; sentence items (v2) take theirs from the note. */
export const GENERATED_TYPES: readonly ItemType[] = ['word', 'phrase', 'grammar'];

/**
 * Accounts the nightly run looks at: active, with at least one record or an
 * item waiting for content (a word or phrase saved as a note before any
 * record was pushed).
 */
export async function accountsWithRecords(db: Executor): Promise<string[]> {
  const waiting = db
    .select({ one: sql`1` })
    .from(items)
    .where(and(eq(items.userId, users.id), inArray(items.status, ['pending', 'needs_regen']), inArray(items.type, [...GENERATED_TYPES])));
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(isNull(users.deletedAt), or(gt(users.lastSeq, 0), exists(waiting))))
    .orderBy(asc(users.createdAt));
  return rows.map((row) => row.id);
}

/** Explanation language (settings.explanationLang, default zh) and local offset (latest entry's, default 480). */
export async function accountSettings(db: Executor, userId: string): Promise<{ lang: ExplanationLang; utcOffsetMinutes: number } | null> {
  const [user] = await db
    .select({ settings: users.settings })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  if (!user) return null;
  const [latest] = await db
    .select({ offset: entries.utcOffsetMinutes })
    .from(entries)
    .where(eq(entries.userId, userId))
    .orderBy(desc(entries.seq))
    .limit(1);
  return {
    lang: user.settings.explanationLang === 'en' ? 'en' : 'zh',
    utcOffsetMinutes: latest?.offset ?? DEFAULT_UTC_OFFSET_MINUTES,
  };
}

/** The account's cursor, creating its pipeline_state row on first use. */
export async function readCursor(db: Executor, userId: string): Promise<number> {
  await db.insert(pipelineState).values({ userId }).onConflictDoNothing();
  const [row] = await db.select({ lastSeq: pipelineState.lastSeq }).from(pipelineState).where(eq(pipelineState.userId, userId));
  return row?.lastSeq ?? 0;
}

export async function finishRun(db: Executor, userId: string, { at, error }: { at: Date; error: string | null }): Promise<void> {
  await db.update(pipelineState).set({ lastRunAt: at, lastError: error }).where(eq(pipelineState.userId, userId));
}

export async function entriesAfter(db: Executor, userId: string, after: number, limit: number): Promise<RecordFields[]> {
  return db
    .select(recordColumns)
    .from(entries)
    .where(and(eq(entries.userId, userId), gt(entries.seq, after)))
    .orderBy(asc(entries.seq))
    .limit(limit);
}

/** The account's grammar slugs, most recent first (the extraction prompt reuses them for dedup). */
export async function knownGrammarSlugs(db: Executor, userId: string, limit = 60): Promise<string[]> {
  const rows = await db
    .select({ key: items.normKey })
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.type, 'grammar')))
    .orderBy(desc(items.lastSeenAt))
    .limit(limit);
  return rows.map((row) => row.key);
}

/** One extracted unit of one record. */
export interface UnitLink {
  entryId: string;
  entryCreatedAt: Date;
  /** The record was a grammar check (a mistake): errorCount + 1. */
  isCheck: boolean;
  type: ItemType;
  normKey: string;
  display: string;
}

/**
 * Store a batch's units and move the cursor past the batch, atomically.
 * Items are upserted by (user, type, normKey); a source record counts once
 * per item (item_sources primary key), so re-running a batch after a crash
 * never double-counts.
 */
export async function storeUnits(
  db: Database,
  userId: string,
  links: readonly UnitLink[],
  cursorSeq: number,
): Promise<{ itemsCreated: number; sourcesAdded: number }> {
  return db.transaction(async (tx) => {
    let itemsCreated = 0;
    let sourcesAdded = 0;
    for (const link of links) {
      const [item] = await tx
        .insert(items)
        .values({
          userId,
          id: ulid(),
          type: link.type,
          normKey: link.normKey,
          display: link.display,
          status: 'pending',
          firstSeenAt: link.entryCreatedAt,
          lastSeenAt: link.entryCreatedAt,
        })
        .onConflictDoUpdate({ target: [items.userId, items.type, items.normKey], set: { updatedAt: sql`${items.updatedAt}` } })
        .returning({ id: items.id, inserted: sql<boolean>`(xmax = 0)` });
      if (!item) throw new Error('item upsert returned nothing');
      if (item.inserted) itemsCreated += 1;

      const added = await tx
        .insert(itemSources)
        .values({ userId, itemId: item.id, entryId: link.entryId })
        .onConflictDoNothing()
        .returning({ itemId: itemSources.itemId });
      if (added.length === 0) continue;
      sourcesAdded += 1;
      await tx
        .update(items)
        .set({
          lookupCount: sql`${items.lookupCount} + 1`,
          errorCount: sql`${items.errorCount} + ${link.isCheck ? 1 : 0}`,
          firstSeenAt: sql`least(${items.firstSeenAt}, ${link.entryCreatedAt.toISOString()}::timestamptz)`,
          lastSeenAt: sql`greatest(${items.lastSeenAt}, ${link.entryCreatedAt.toISOString()}::timestamptz)`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(items.userId, userId), eq(items.id, item.id)));
    }
    await tx
      .update(pipelineState)
      .set({ lastSeq: cursorSeq })
      .where(and(eq(pipelineState.userId, userId), sql`${pipelineState.lastSeq} < ${cursorSeq}`));
    return { itemsCreated, sourcesAdded };
  });
}

/**
 * Items waiting for content: new ones first, then those to regenerate. New
 * includes word and phrase items created `pending` by notes; sentence items
 * never go to the model.
 */
export async function itemsToGenerate(db: Executor, userId: string, limit: number): Promise<ItemRow[]> {
  return db
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), inArray(items.status, ['pending', 'needs_regen']), inArray(items.type, [...GENERATED_TYPES])))
    .orderBy(sql`${items.status} = 'pending' desc`, asc(items.firstSeenAt), asc(items.id))
    .limit(limit);
}

export async function getItem(db: Executor, userId: string, itemId: string): Promise<ItemRow | null> {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.id, itemId)));
  return row ?? null;
}

export interface CardChanges {
  cardsCreated: number;
  cardsUpdated: number;
}

/**
 * Make the item's cards match `specs`: existing cards of a type get their
 * faces rewritten in place (same id, scheduling kept) and are unsuspended;
 * missing types are created as new cards due `now`.
 */
async function applyCardSpecs(tx: Executor, userId: string, itemId: string, specs: readonly CardSpec[], now: Date): Promise<CardChanges> {
  const existing = await tx
    .select({ id: cards.id, cardType: cards.cardType })
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.itemId, itemId)));
  let cardsCreated = 0;
  let cardsUpdated = 0;
  for (const spec of specs) {
    const current = existing.filter((card) => card.cardType === spec.cardType);
    if (current.length > 0) {
      await tx
        .update(cards)
        .set({ front: spec.front, back: spec.back, suspended: false })
        .where(and(eq(cards.userId, userId), inArray(cards.id, current.map((card) => card.id))));
      cardsUpdated += current.length;
    } else {
      await tx.insert(cards).values({ userId, id: ulid(), itemId, cardType: spec.cardType, front: spec.front, back: spec.back, due: now });
      cardsCreated += 1;
    }
  }
  return { cardsCreated, cardsUpdated };
}

/**
 * Store an item's content (`ready`) and make its cards match it, inside the
 * caller's transaction. Takes the item row's lock before the cards' (as
 * every content writer does). `model` is null for content no model wrote
 * (sentence notes).
 */
export async function writeContent(
  tx: Executor,
  userId: string,
  item: Pick<ItemRow, 'id' | 'display'>,
  value: CardSource,
  { model, now }: { model: string | null; now: Date },
): Promise<CardChanges> {
  const specs = cardsFor(value);
  await tx
    .update(items)
    .set({
      content: { ...value.content },
      status: 'ready',
      display: value.type === 'sentence' ? item.display : displayOf(value, item.display),
      model,
      version: sql`case when ${items.content} is null then ${items.version} else ${items.version} + 1 end`,
      updatedAt: now,
    })
    .where(and(eq(items.userId, userId), eq(items.id, item.id)));
  return applyCardSpecs(tx, userId, item.id, specs, now);
}

/** `writeContent` in a transaction of its own (generated content, regeneration). */
export async function saveContent(
  db: Database,
  userId: string,
  item: Pick<ItemRow, 'id' | 'display'>,
  value: CardSource,
  options: { model: string | null; now: Date },
): Promise<CardChanges> {
  return db.transaction((tx) => writeContent(tx, userId, item, value, options));
}

export async function markNeedsRegen(db: Executor, userId: string, itemIds: readonly string[], now: Date): Promise<void> {
  if (itemIds.length === 0) return;
  await db
    .update(items)
    .set({ status: 'needs_regen', updatedAt: now })
    .where(and(eq(items.userId, userId), inArray(items.id, [...itemIds])));
}

// ------------------------------------------------- the learner's own context

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`);

export type UserSentence = { en: string; zh: string };
export type UserCheck = { original: string; corrected: string };

function sentenceOf(record: RecordFields, target: string | null): UserSentence | null {
  const { en, zh } = sidesOf(record);
  if (!en || !zh) return null;
  if (target !== null && !findTarget(en, target)) return null;
  return { en: clip(en, USER_SENTENCE_MAX), zh: clip(zh, USER_SENTENCE_MAX) };
}

/**
 * A recent sentence of the learner's that uses `headword` (a word item's
 * fromUser example). Only sentence-level records: paragraph text never
 * reaches the materials.
 */
export async function userSentenceWithWord(db: Executor, userId: string, headword: string): Promise<UserSentence | null> {
  const pattern = `%${escapeLike(headword)}%`;
  const rows = await db
    .select(recordColumns)
    .from(entries)
    .where(
      and(
        eq(entries.userId, userId),
        eq(entries.task, 'translate'),
        eq(entries.kind, 'sentence'),
        sql`(${entries.input} ilike ${pattern} or ${entries.output} ilike ${pattern})`,
      ),
    )
    .orderBy(desc(entries.seq))
    .limit(20);
  for (const row of rows) {
    const sentence = sentenceOf(row, headword);
    if (sentence) return sentence;
  }
  return null;
}

/** Source records of an item, newest first, excluding paragraphs. */
async function nonParagraphSources(db: Executor, userId: string, itemId: string, task: 'translate' | 'check'): Promise<RecordFields[]> {
  return db
    .select(recordColumns)
    .from(itemSources)
    .innerJoin(entries, and(eq(entries.userId, itemSources.userId), eq(entries.id, itemSources.entryId)))
    .where(and(eq(itemSources.userId, userId), eq(itemSources.itemId, itemId), eq(entries.task, task), ne(entries.kind, 'paragraph')))
    .orderBy(desc(entries.seq))
    .limit(5);
}

/** The learner's sentence a phrase item came from. */
export async function userSentenceForPhrase(db: Executor, userId: string, itemId: string): Promise<UserSentence | null> {
  for (const row of await nonParagraphSources(db, userId, itemId, 'translate')) {
    const sentence = sentenceOf(row, null);
    if (sentence) return sentence;
  }
  return null;
}

/** The learner's checked sentence a grammar item came from. */
export async function userCheckForGrammar(db: Executor, userId: string, itemId: string): Promise<UserCheck | null> {
  const [row] = await nonParagraphSources(db, userId, itemId, 'check');
  if (!row) return null;
  const { original, corrected } = checkSides(row);
  return corrected ? { original: clip(original, USER_SENTENCE_MAX), corrected: clip(corrected, USER_SENTENCE_MAX) } : null;
}
