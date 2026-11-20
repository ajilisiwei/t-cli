import { sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { Executor } from '../../db/client.ts';

/** The account's local calendar day ("YYYY-MM-DD") at `now` for a UTC offset in minutes. */
export function localDay(now: Date, utcOffsetMinutes: number): string {
  return new Date(now.getTime() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** Which daily limit refused a request (docs/api-v1.md, "AI quotas (extended)": `details.kind`). */
export type QuotaKind = 'requests' | 'tokens';

export type QuotaResult = { allowed: true; used: number } | { allowed: false; used: null; kind: QuotaKind };

/** ai_usage counters are int4; one request never legitimately reports more than this. */
const MAX_TOKENS_PER_RECORD = 10_000_000;

const FOREIGN_KEY_VIOLATION = '23503';

/** The account row is gone (hard delete with cascade): the usage row's foreign key fails. */
export function isMissingAccount(error: unknown): boolean {
  const root = error instanceof DrizzleQueryError ? error.cause : error;
  return Boolean(root && typeof root === 'object' && 'code' in root && root.code === FOREIGN_KEY_VIOLATION);
}

/**
 * Count one AI request against the account's daily quota, atomically.
 *
 * A single upsert increments the counter only while it is below `limit` and,
 * when `tokenLimit` is given, while the day's interactive tokens are below
 * it, so concurrent requests can never push the request count past `limit`:
 * the row lock taken by ON CONFLICT serializes them and the WHERE re-checks
 * the fresh values. Tokens are only known after a request finished, so the
 * token budget refuses the first request after it was reached.
 *
 * @returns allowed: the request was counted; used: the counter after it.
 *   Refused: `kind` names the exhausted limit (requests first).
 */
export async function consumeDailyQuota(
  db: Executor,
  { userId, day, limit, tokenLimit = null }: { userId: string; day: string; limit: number; tokenLimit?: number | null },
): Promise<QuotaResult> {
  const tokensBelow = tokenLimit === null ? sql`true` : sql`ai_usage.tokens < ${tokenLimit}`;
  const rows = await db.execute<{ requests: number }>(sql`
    INSERT INTO ai_usage (user_id, day, requests) VALUES (${userId}, ${day}, 1)
    ON CONFLICT (user_id, day) DO UPDATE SET requests = ai_usage.requests + 1
      WHERE ai_usage.requests < ${limit} AND ${tokensBelow}
    RETURNING requests`);
  const used = rows[0]?.requests;
  if (used !== undefined) return { allowed: true, used };

  const [row] = await db.execute<{ requests: number }>(
    sql`SELECT requests FROM ai_usage WHERE user_id = ${userId} AND day = ${day}`,
  );
  return { allowed: false, used: null, kind: row && row.requests < limit ? 'tokens' : 'requests' };
}

/**
 * Add finished requests' tokens to the account's day: `interactive` → the AI
 * proxy budget (`tokens`), `pipeline` → the nightly pipeline's (`pipeline_tokens`).
 * An account deleted meanwhile (cascade) is skipped instead of failing on the
 * foreign key.
 */
export async function recordTokens(
  db: Executor,
  { userId, day, tokens, kind }: { userId: string; day: string; tokens: number; kind: 'interactive' | 'pipeline' },
): Promise<void> {
  const amount = Math.min(MAX_TOKENS_PER_RECORD, Math.max(0, Math.round(tokens)));
  if (amount === 0) return;
  const column = kind === 'interactive' ? sql`tokens` : sql`pipeline_tokens`;
  await db.execute(sql`
    INSERT INTO ai_usage (user_id, day, ${column})
      SELECT ${userId}::text, ${day}::date, ${amount}::int WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId})
    ON CONFLICT (user_id, day) DO UPDATE SET ${column} = ai_usage.${column} + excluded.${column}`);
}
