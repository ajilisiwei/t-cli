import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { streakFrom, activityDates } from '../review/activity.ts';
import { addDays, localDateOf, localTimestampSql, mondayOf, startOfLocalDate } from '../review/common.ts';

/** 我的 → 统计 (docs/api-v1.md, "Library and stats"). */

export const RETENTION_WEEKS = 12;

export interface StatsView {
  days: { date: string; entries: number; reviews: number }[];
  streakDays: number;
  retention: { weekStart: string; rate: number }[];
  totals: { entries: number; items: number; cards: number; mastered: number };
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Entries and reviews per local day since `from` (days without activity are absent), oldest first. */
async function dailyActivity(db: Executor, userId: string, from: Date, utcOffsetMinutes: number): Promise<StatsView['days']> {
  const entryDay = sql`to_char(${localTimestampSql(sql`e.created_at`, utcOffsetMinutes)}, 'YYYY-MM-DD')`;
  const reviewDay = sql`to_char(${localTimestampSql(sql`l.reviewed_at`, utcOffsetMinutes)}, 'YYYY-MM-DD')`;
  const rows = await db.execute<{ date: string; entries: number; reviews: number }>(sql`
    select d.date, sum(d.entries)::int as entries, sum(d.reviews)::int as reviews
    from (
      select ${entryDay} as date, count(*) as entries, 0 as reviews
      from entries e where e.user_id = ${userId} and e.created_at >= ${from.toISOString()}::timestamptz
      group by 1
      union all
      select ${reviewDay} as date, 0 as entries, count(*) as reviews
      from review_logs l where l.user_id = ${userId} and l.reviewed_at >= ${from.toISOString()}::timestamptz
      group by 1
    ) d
    group by d.date
    order by d.date`);
  return rows.map((row) => ({ date: row.date, entries: row.entries, reviews: row.reviews }));
}

/**
 * Per local (Monday) week since `from`: the share of ratings ≥ 2 among
 * ratings of cards that were not new (not their card's first log). Weeks
 * without such ratings are absent.
 */
async function weeklyRetention(db: Executor, userId: string, from: Date, utcOffsetMinutes: number): Promise<StatsView['retention']> {
  const week = sql`to_char(date_trunc('week', ${localTimestampSql(sql`l.reviewed_at`, utcOffsetMinutes)}), 'YYYY-MM-DD')`;
  const rows = await db.execute<{ week_start: string; total: number; passed: number }>(sql`
    select ${week} as week_start, count(*)::int as total, (count(*) filter (where l.rating >= 2))::int as passed
    from review_logs l
    where l.user_id = ${userId} and l.reviewed_at >= ${from.toISOString()}::timestamptz
      and exists (
        select 1 from review_logs e
        where e.user_id = l.user_id and e.card_id = l.card_id
          and (e.reviewed_at, e.id) < (l.reviewed_at, l.id)
      )
    group by 1
    order by 1`);
  return rows.map((row) => ({ weekStart: row.week_start, rate: round4(row.passed / row.total) }));
}

async function totals(db: Executor, userId: string): Promise<StatsView['totals']> {
  const [row] = await db.execute<StatsView['totals']>(sql`
    select
      (select count(*) from entries where user_id = ${userId})::int as entries,
      (select count(*) from items where user_id = ${userId})::int as items,
      (select count(*) from cards where user_id = ${userId})::int as cards,
      (select count(*) from cards where user_id = ${userId} and mastered)::int as mastered`);
  return row ?? { entries: 0, items: 0, cards: 0, mastered: 0 };
}

export async function learningStats(
  db: Executor,
  { userId, now, utcOffsetMinutes, days }: { userId: string; now: Date; utcOffsetMinutes: number; days: number },
): Promise<StatsView> {
  const today = localDateOf(now, utcOffsetMinutes);
  const firstDay = startOfLocalDate(addDays(today, -(days - 1)), utcOffsetMinutes);
  const firstWeek = startOfLocalDate(addDays(mondayOf(today), -7 * (RETENTION_WEEKS - 1)), utcOffsetMinutes);
  const [daily, active, retention, counts] = await Promise.all([
    dailyActivity(db, userId, firstDay, utcOffsetMinutes),
    activityDates(db, userId, utcOffsetMinutes),
    weeklyRetention(db, userId, firstWeek, utcOffsetMinutes),
    totals(db, userId),
  ]);
  return { days: daily, streakDays: streakFrom(active, today), retention, totals: counts };
}
