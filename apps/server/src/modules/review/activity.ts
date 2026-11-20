import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { entries, reviewLogs } from '../../db/schema.ts';
import { addDays, localDateSql } from './common.ts';

/**
 * Learning activity per local day: a day counts when the account made at
 * least one record (entry) or one review on it.
 */

/** The local dates (desc) on which the account has any entry or review. */
export async function activityDates(db: Executor, userId: string, utcOffsetMinutes: number): Promise<string[]> {
  const entryDate = localDateSql(entries.createdAt, utcOffsetMinutes);
  const reviewDate = localDateSql(reviewLogs.reviewedAt, utcOffsetMinutes);
  const rows = await db.execute<{ date: string }>(sql`
    select ${entryDate} as date from ${entries} where ${entries.userId} = ${userId}
    union
    select ${reviewDate} as date from ${reviewLogs} where ${reviewLogs.userId} = ${userId}
    order by date desc`);
  return rows.map((row) => row.date);
}

/**
 * Consecutive active local days ending today — or ending yesterday while
 * today has no activity yet (the streak is not broken until today is over).
 */
export function streakFrom(activeDates: Iterable<string>, today: string): number {
  const active = new Set(activeDates);
  let day = active.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (active.has(day)) {
    streak += 1;
    day = addDays(day, -1);
  }
  return streak;
}

export async function currentStreak(db: Executor, userId: string, today: string, utcOffsetMinutes: number): Promise<number> {
  return streakFrom(await activityDates(db, userId, utcOffsetMinutes), today);
}
