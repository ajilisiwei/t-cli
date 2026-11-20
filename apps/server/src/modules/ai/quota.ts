import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';

/** The account's local calendar day ("YYYY-MM-DD") at `now` for a UTC offset in minutes. */
export function localDay(now: Date, utcOffsetMinutes: number): string {
  return new Date(now.getTime() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * Count one AI request against the account's daily quota, atomically.
 *
 * A single upsert increments the counter only while it is below the limit,
 * so concurrent requests can never push it past `limit`: the row lock taken
 * by ON CONFLICT serializes them and the WHERE re-checks the fresh value.
 *
 * @returns allowed: the request was counted; used: the counter after it (null when refused)
 */
export async function consumeDailyQuota(
  db: Executor,
  { userId, day, limit }: { userId: string; day: string; limit: number },
): Promise<{ allowed: boolean; used: number | null }> {
  const rows = await db.execute<{ requests: number }>(sql`
    INSERT INTO ai_usage (user_id, day, requests) VALUES (${userId}, ${day}, 1)
    ON CONFLICT (user_id, day) DO UPDATE SET requests = ai_usage.requests + 1
      WHERE ai_usage.requests < ${limit}
    RETURNING requests`);
  const used = rows[0]?.requests;
  return used === undefined ? { allowed: false, used: null } : { allowed: true, used };
}
