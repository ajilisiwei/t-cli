import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { items } from '../../db/schema.ts';
import { addDays, localDayRange } from '../pipeline/dates.ts';
import type { Range } from '../pipeline/materialData.ts';
import type { MaterialRow } from './materials.ts';

/**
 * Why a daily material or digest picked its words and phrases (docs/api-v1.md,
 * "v3 → Materials", `reasons`): per unit its current stars, its 忘记 ratings
 * and its lookups (lookup events plus source records) within the material's
 * range. Every query filters on the caller's user_id; nothing here reads or
 * logs user text.
 */

export interface UnitReason {
  /** The unit's current stars (0–4). */
  stars: number;
  /** Ratings 忘记 (1) on the unit's cards within the range. */
  lapses: number;
  /** Lookup events (words) plus source records of the unit within the range. */
  lookups: number;
}

/** Days of a digest when its stored `range` is unusable (DIGEST_DAYS). */
const DIGEST_FALLBACK_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDate = (value: unknown): value is string => typeof value === 'string' && DATE_RE.test(value);

/** Whole local days from `start` to `end`, both included (0 when `end` is before `start`). */
const daysBetween = (start: string, end: string): number => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;

/**
 * The instants a material covers at the account's offset: a daily material's
 * local day; a digest's `range` (start to end, both included), or the 7 days
 * ending on its date when the stored range is unusable.
 */
export function reasonRangeOf(row: Pick<MaterialRow, 'kind' | 'date' | 'content'>, utcOffsetMinutes: number): Range {
  if (row.kind !== 'digest') return localDayRange(row.date, utcOffsetMinutes);
  const range = isRecord(row.content.range) ? row.content.range : {};
  const { start, end } = range;
  if (isDate(start) && isDate(end)) {
    const days = daysBetween(start, end);
    if (days >= 1 && days <= 31) return localDayRange(start, utcOffsetMinutes, days);
  }
  return localDayRange(addDays(row.date, 1 - DIGEST_FALLBACK_DAYS), utcOffsetMinutes, DIGEST_FALLBACK_DAYS);
}

/** The item ids of a material's words and phrases, each once, in order. */
export function reasonUnitIds(content: Record<string, unknown>): string[] {
  const ids = [content.words, content.phrases].flatMap((section) =>
    Array.isArray(section) ? section.flatMap((unit) => (isRecord(unit) && typeof unit.itemId === 'string' && unit.itemId !== '' ? [unit.itemId] : [])) : [],
  );
  return [...new Set(ids)];
}

/**
 * Reasons for `itemIds` of the account within `range`. Units that no longer
 * exist are left out.
 */
export async function unitReasons(db: Executor, userId: string, itemIds: readonly string[], range: Range): Promise<Record<string, UnitReason>> {
  if (itemIds.length === 0) return {};
  const start = range.start.toISOString();
  const end = range.end.toISOString();
  // Column references inside the subqueries name the outer table explicitly (`items.`): a bare
  // column there would be ambiguous with the subquery's own tables.
  const rows = await db
    .select({
      id: items.id,
      stars: items.stars,
      lapses: sql<number>`(select count(*)::int from review_logs l join cards c on c.user_id = l.user_id and c.id = l.card_id
        where l.user_id = items.user_id and c.item_id = items.id and l.rating = 1
          and l.reviewed_at >= ${start}::timestamptz and l.reviewed_at < ${end}::timestamptz)`,
      sources: sql<number>`(select count(*)::int from item_sources s join entries e on e.user_id = s.user_id and e.id = s.entry_id
        where s.user_id = items.user_id and s.item_id = items.id
          and e.created_at >= ${start}::timestamptz and e.created_at < ${end}::timestamptz)`,
      events: sql<number>`(case when items.type = 'word' then (select count(*)::int from lookup_events ev
        where ev.user_id = items.user_id and ev.lemma_key = items.norm_key
          and ev.created_at >= ${start}::timestamptz and ev.created_at < ${end}::timestamptz) else 0 end)`,
    })
    .from(items)
    .where(and(eq(items.userId, userId), inArray(items.id, [...itemIds])));
  return Object.fromEntries(
    rows.map((row) => [row.id, { stars: row.stars, lapses: Number(row.lapses), lookups: Number(row.sources) + Number(row.events) }] as const),
  );
}
