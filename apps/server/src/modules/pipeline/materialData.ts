import { and, count, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { entries, items, materials, reviewLogs } from '../../db/schema.ts';
import { localDayRange } from './dates.ts';
import type { RunContext } from './llmJson.ts';
import { parseStoredContent, type ItemContent } from './schemas.ts';

/**
 * What the nightly materials (daily, digest, weekly) read from the
 * account's data. Every query filters on the account's user_id.
 */

export type Range = { start: Date; end: Date };
export type StoredMaterialKind = 'daily' | 'weekly' | 'digest' | 'extend';

export interface ReadyItem {
  id: string;
  display: string;
  lookupCount: number;
  errorCount: number;
  parsed: ItemContent;
}

const STREAK_LOOKBACK_DAYS = 400;
/** "易错回顾": units rated 忘记 at least this often in the window. */
export const MISTAKE_MIN_MISSES = 2;

const weight = (item: { errorCount: number; lookupCount: number }): number => item.errorCount * 2 + item.lookupCount;

/** Stars from which an item is picked before the usual weighting (docs/api-v1.md, "Review by importance"). */
export const PRIORITY_MIN_STARS = 3;

/** 4 ★ items first, then 3 ★; every other item ranks by weight alone. */
export const priorityOf = (stars: number): number => (stars >= PRIORITY_MIN_STARS ? stars : 0);

type RankedRow = { stars: number; errorCount: number; lookupCount: number; lastSeenAt: Date };

/** Material order: priority (stars), then weight, then the most recently seen. */
export function compareForMaterial(a: RankedRow, b: RankedRow): number {
  return priorityOf(b.stars) - priorityOf(a.stars) || weight(b) - weight(a) || b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
}

const iso = (date: Date): string => date.toISOString();

export async function materialExists(db: Executor, userId: string, kind: StoredMaterialKind, date: string): Promise<boolean> {
  const [row] = await db
    .select({ date: materials.date })
    .from(materials)
    .where(and(eq(materials.userId, userId), eq(materials.kind, kind), eq(materials.date, date)));
  return Boolean(row);
}

export async function saveMaterial(ctx: RunContext, kind: StoredMaterialKind, date: string, content: object): Promise<void> {
  await ctx.db
    .insert(materials)
    .values({ userId: ctx.userId, kind, date, content: { ...content }, model: ctx.model })
    .onConflictDoNothing();
}

export async function countEntries(db: Executor, userId: string, range: Range, task?: 'check'): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(entries)
    .where(and(eq(entries.userId, userId), gte(entries.createdAt, range.start), lt(entries.createdAt, range.end), ...(task ? [eq(entries.task, task)] : [])));
  return row?.n ?? 0;
}

export async function countReviews(db: Executor, userId: string, range: Range): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(reviewLogs)
    .where(and(eq(reviewLogs.userId, userId), gte(reviewLogs.reviewedAt, range.start), lt(reviewLogs.reviewedAt, range.end)));
  return row?.n ?? 0;
}

export async function countNewItems(db: Executor, userId: string, range: Range, type?: 'word' | 'phrase'): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(items)
    .where(and(eq(items.userId, userId), gte(items.firstSeenAt, range.start), lt(items.firstSeenAt, range.end), ...(type ? [eq(items.type, type)] : [])));
  return row?.n ?? 0;
}

/**
 * Activity (docs/api-v1.md, "v3 → Pipeline"): a record, a lookup event, a
 * note saved or changed, or a review in the range.
 */
export async function hadActivity(db: Executor, userId: string, range: Range): Promise<boolean> {
  const start = iso(range.start);
  const end = iso(range.end);
  const [row] = await db.execute<{ active: boolean }>(sql`select (
    exists (select 1 from entries where user_id = ${userId} and created_at >= ${start}::timestamptz and created_at < ${end}::timestamptz)
    or exists (select 1 from lookup_events where user_id = ${userId} and created_at >= ${start}::timestamptz and created_at < ${end}::timestamptz)
    or exists (select 1 from notes where user_id = ${userId} and updated_at >= ${start}::timestamptz and updated_at < ${end}::timestamptz)
    or exists (select 1 from review_logs where user_id = ${userId} and reviewed_at >= ${start}::timestamptz and reviewed_at < ${end}::timestamptz)
  ) as active`);
  return row?.active === true;
}

/**
 * The range's units with valid content: those with a source record made in
 * the range, a live note saved or changed in the range (a word tapped in a
 * sentence has no record of its own), or (v3) a word looked up in the range.
 * 4 ★ first, then 3 ★, then heaviest first.
 */
export async function readyItemsFromRange(db: Executor, userId: string, range: Range): Promise<ReadyItem[]> {
  const start = iso(range.start);
  const end = iso(range.end);
  const rows = await db
    .select({
      id: items.id,
      type: items.type,
      display: items.display,
      content: items.content,
      lookupCount: items.lookupCount,
      errorCount: items.errorCount,
      stars: items.stars,
      lastSeenAt: items.lastSeenAt,
    })
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        eq(items.status, 'ready'),
        sql`(exists (select 1 from item_sources s join entries e on e.user_id = s.user_id and e.id = s.entry_id
              where s.user_id = ${items.userId} and s.item_id = ${items.id}
                and e.created_at >= ${start}::timestamptz and e.created_at < ${end}::timestamptz)
          or exists (select 1 from notes n
              where n.user_id = ${items.userId} and n.item_id = ${items.id} and n.deleted_at is null
                and n.updated_at >= ${start}::timestamptz and n.updated_at < ${end}::timestamptz)
          or (${items.type} = 'word' and exists (select 1 from lookup_events ev
              where ev.user_id = ${items.userId} and ev.lemma_key = ${items.normKey}
                and ev.created_at >= ${start}::timestamptz and ev.created_at < ${end}::timestamptz)))`,
      ),
    );
  return [...rows].sort(compareForMaterial).flatMap((row) => {
    const parsed = parseStoredContent(row.type, row.content);
    return parsed ? [{ id: row.id, display: row.display, lookupCount: row.lookupCount, errorCount: row.errorCount, parsed }] : [];
  });
}

/** Local days with at least one record or review, up to `endDate` (the streak's definition, unchanged in v3). */
export async function activeDays(db: Executor, userId: string, endDate: string, utcOffsetMinutes: number): Promise<Set<string>> {
  const { end } = localDayRange(endDate, utcOffsetMinutes);
  const since = new Date(end.getTime() - STREAK_LOOKBACK_DAYS * 86_400_000);
  const shift = sql`make_interval(mins => ${utcOffsetMinutes}::int)`;
  const rows = await db.execute<{ day: string }>(sql`
    select to_char((created_at at time zone 'UTC') + ${shift}, 'YYYY-MM-DD') as day from entries
      where user_id = ${userId} and created_at >= ${iso(since)}::timestamptz and created_at < ${iso(end)}::timestamptz
    union
    select to_char((reviewed_at at time zone 'UTC') + ${shift}, 'YYYY-MM-DD') as day from review_logs
      where user_id = ${userId} and reviewed_at >= ${iso(since)}::timestamptz and reviewed_at < ${iso(end)}::timestamptz`);
  return new Set(rows.map((row) => row.day));
}

/** Items rated 忘记 (1) in the range, most misses first (ties: item id), with their miss counts. */
async function missesInRange(db: Executor, userId: string, range: Range, minMisses: number, limit: number): Promise<{ itemId: string; misses: number }[]> {
  const rows = await db.execute<{ item_id: string; misses: number }>(sql`
    select c.item_id, count(*)::int as misses
      from review_logs l join cards c on c.user_id = l.user_id and c.id = l.card_id
      join items i on i.user_id = c.user_id and i.id = c.item_id
     where l.user_id = ${userId} and l.rating = 1 and i.type <> 'sentence'
       and l.reviewed_at >= ${iso(range.start)}::timestamptz and l.reviewed_at < ${iso(range.end)}::timestamptz
     group by c.item_id having count(*) >= ${minMisses}
     order by misses desc, c.item_id
     limit ${limit}`);
  return rows.map((row) => ({ itemId: row.item_id, misses: row.misses }));
}

async function readyItemsByIds(db: Executor, userId: string, ids: readonly string[]): Promise<Map<string, ReadyItem>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: items.id, type: items.type, display: items.display, content: items.content, lookupCount: items.lookupCount, errorCount: items.errorCount })
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.status, 'ready'), inArray(items.id, [...ids])));
  return new Map(
    rows.flatMap((row) => {
      const parsed = parseStoredContent(row.type, row.content);
      return parsed ? [[row.id, { id: row.id, display: row.display, lookupCount: row.lookupCount, errorCount: row.errorCount, parsed }] as const] : [];
    }),
  );
}

/** Items rated 忘记 at least MISTAKE_MIN_MISSES times in the range, most misses first, at most `cap`. */
export async function frequentMistakes(db: Executor, userId: string, range: Range, cap: number): Promise<ReadyItem[]> {
  const misses = await missesInRange(db, userId, range, MISTAKE_MIN_MISSES, cap);
  const byId = await readyItemsByIds(db, userId, misses.map((miss) => miss.itemId));
  return misses.flatMap((miss) => {
    const item = byId.get(miss.itemId);
    return item ? [item] : [];
  });
}

/** Items forgotten (rated 忘记 at least once) in the range, most lapses first, at most `cap`, with their lapses. */
export async function forgottenInRange(db: Executor, userId: string, range: Range, cap: number): Promise<{ item: ReadyItem; lapses: number }[]> {
  const misses = await missesInRange(db, userId, range, 1, cap);
  const byId = await readyItemsByIds(db, userId, misses.map((miss) => miss.itemId));
  return misses.flatMap((miss) => {
    const item = byId.get(miss.itemId);
    return item ? [{ item, lapses: miss.misses }] : [];
  });
}
