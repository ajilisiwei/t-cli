import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { toIsoWithOffset } from '../../db/entriesRepo.ts';
import type { Executor } from '../../db/client.ts';
import { cards, entries, items, itemSources } from '../../db/schema.ts';
import { stateName, type CardStateName } from '../review/fsrs.ts';

/** 词库 (docs/api-v1.md, "Library and stats"): learning units with their level. */

export type ItemType = 'word' | 'phrase' | 'grammar' | 'sentence';
/** `new` = every card new (or no cards yet), `mastered` = every card mastered, otherwise `learning`. */
export type ItemLevel = 'new' | 'learning' | 'mastered';

export const SOURCES_SHOWN = 10;

export interface ItemListEntry {
  id: string;
  type: ItemType;
  display: string;
  lookupCount: number;
  errorCount: number;
  level: ItemLevel;
  lastSeenAt: string;
}

export interface ItemDetail {
  id: string;
  type: ItemType;
  display: string;
  status: 'pending' | 'ready' | 'needs_regen';
  content: Record<string, unknown> | null;
  lookupCount: number;
  errorCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  level: ItemLevel;
  cards: { id: string; cardType: string; state: CardStateName; due: string; mastered: boolean; suspended: boolean }[];
  sources: { entryId: string; input: string; createdAt: string }[];
}

const cardOfItem = and(eq(cards.userId, items.userId), eq(cards.itemId, items.id));

/** Aggregate over the item's cards (left join: an item without cards is `new`). Also used by the notebook. */
export const LEVEL_SQL = sql<ItemLevel>`(case
  when count(${cards.id}) = 0 or bool_and(${cards.state} = 0) then 'new'
  when bool_and(${cards.mastered}) then 'mastered'
  else 'learning' end)`;

/** Escape LIKE wildcards so `q` matches literally (backslash is Postgres's default escape). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function levelOf(cardRows: readonly { state: number; mastered: boolean }[]): ItemLevel {
  if (cardRows.every((card) => card.state === 0)) return 'new';
  if (cardRows.every((card) => card.mastered)) return 'mastered';
  return 'learning';
}

/**
 * Without `q`: most recently seen first. With `q`: pg_trgm similarity on
 * `display` or a (case-insensitive) prefix match; exact matches first, then
 * prefix matches, then by similarity.
 */
export async function listItems(
  db: Executor,
  userId: string,
  { q, type, level, offset, limit }: { q?: string | undefined; type?: ItemType | undefined; level?: ItemLevel | undefined; offset: number; limit: number },
): Promise<{ items: ItemListEntry[]; nextOffset: number | null }> {
  const filters: (SQL | undefined)[] = [eq(items.userId, userId), type === undefined ? undefined : eq(items.type, type)];
  const prefix = q === undefined ? '' : `${escapeLike(q)}%`;
  if (q !== undefined) filters.push(or(sql`${items.display} % ${q}`, ilike(items.display, prefix)));
  const order: SQL[] = q === undefined
    ? [desc(items.lastSeenAt), desc(items.id)]
    : [
        desc(sql`lower(${items.display}) = lower(${q})`),
        desc(sql`${items.display} ilike ${prefix}`),
        desc(sql`similarity(${items.display}, ${q})`),
        desc(items.lastSeenAt),
        asc(items.id),
      ];

  const rows = await db
    .select({
      id: items.id,
      type: items.type,
      display: items.display,
      lookupCount: items.lookupCount,
      errorCount: items.errorCount,
      lastSeenAt: items.lastSeenAt,
      level: LEVEL_SQL,
    })
    .from(items)
    .leftJoin(cards, cardOfItem)
    .where(and(...filters))
    .groupBy(items.userId, items.id)
    .having(level === undefined ? undefined : sql`${LEVEL_SQL} = ${level}`)
    .orderBy(...order)
    .limit(limit + 1)
    .offset(offset);

  const page = rows.slice(0, limit).map((row) => ({ ...row, lastSeenAt: row.lastSeenAt.toISOString() }));
  return { items: page, nextOffset: rows.length > limit ? offset + limit : null };
}

/** One of the account's items with its cards and latest sources; null when unknown or another account's. */
export async function getItemDetail(db: Executor, userId: string, itemId: string): Promise<ItemDetail | null> {
  const [item] = await db
    .select()
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.id, itemId)));
  if (!item) return null;

  const cardRows = await db
    .select({ id: cards.id, cardType: cards.cardType, state: cards.state, due: cards.due, mastered: cards.mastered, suspended: cards.suspended })
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.itemId, itemId)))
    .orderBy(asc(cards.id));
  const sources = await db
    .select({ entryId: entries.id, input: entries.input, createdAt: entries.createdAt, utcOffsetMinutes: entries.utcOffsetMinutes })
    .from(itemSources)
    .innerJoin(entries, and(eq(entries.userId, itemSources.userId), eq(entries.id, itemSources.entryId)))
    .where(and(eq(itemSources.userId, userId), eq(itemSources.itemId, itemId)))
    .orderBy(desc(entries.createdAt), desc(entries.seq))
    .limit(SOURCES_SHOWN);

  return {
    id: item.id,
    type: item.type,
    display: item.display,
    status: item.status,
    content: item.content ?? null,
    lookupCount: item.lookupCount,
    errorCount: item.errorCount,
    firstSeenAt: item.firstSeenAt.toISOString(),
    lastSeenAt: item.lastSeenAt.toISOString(),
    level: levelOf(cardRows),
    cards: cardRows.map((card) => ({
      id: card.id,
      cardType: card.cardType,
      state: stateName(card.state),
      due: card.due.toISOString(),
      mastered: card.mastered,
      suspended: card.suspended,
    })),
    sources: sources.map((source) => ({
      entryId: source.entryId,
      input: source.input,
      createdAt: toIsoWithOffset(source.createdAt, source.utcOffsetMinutes),
    })),
  };
}
