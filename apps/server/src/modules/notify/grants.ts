import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { notifyGrants } from '../../db/schema.ts';

/**
 * One-time subscribe-message grants: each `accept` from
 * `wx.requestSubscribeMessage` lets us send one message.
 */

/** Far more than anyone taps "allow" in practice; bounds a looping client. */
export const MAX_AVAILABLE_GRANTS = 100;

/**
 * Add one grant for `templateId`. Null when the account is missing or
 * deleted (a leftover access token of a deleted account), so the caller can
 * answer 401 instead of tripping the foreign key.
 */
export async function addGrant(db: Executor, { userId, templateId, now }: { userId: string; templateId: string; now: Date }): Promise<number | null> {
  const rows = await db.execute<{ available: number }>(sql`
    insert into notify_grants (user_id, template_id, available, updated_at)
    select ${userId}, ${templateId}, 1, ${now.toISOString()}::timestamptz
    where exists (select 1 from users where id = ${userId} and deleted_at is null)
    on conflict (user_id, template_id) do update
      set available = least(notify_grants.available + 1, ${MAX_AVAILABLE_GRANTS}::int),
          updated_at = excluded.updated_at
    returning available`);
  return rows[0]?.available ?? null;
}

/**
 * Take one grant before sending, unless one was sent since `notBefore`
 * (never two reminders in a day). False when there is none to take.
 */
export async function reserveGrant(
  db: Executor,
  { userId, templateId, now, notBefore }: { userId: string; templateId: string; now: Date; notBefore: Date },
): Promise<boolean> {
  const rows = await db
    .update(notifyGrants)
    .set({ available: sql`${notifyGrants.available} - 1`, lastSentAt: now, updatedAt: now })
    .where(
      and(
        eq(notifyGrants.userId, userId),
        eq(notifyGrants.templateId, templateId),
        gt(notifyGrants.available, 0),
        or(isNull(notifyGrants.lastSentAt), lt(notifyGrants.lastSentAt, notBefore)),
      ),
    )
    .returning({ available: notifyGrants.available });
  return rows.length > 0;
}

/** Give a reserved grant back after a failed send (WeChat did not use it either). */
export async function releaseGrant(
  db: Executor,
  { userId, templateId, previousSentAt }: { userId: string; templateId: string; previousSentAt: Date | null },
): Promise<void> {
  await db
    .update(notifyGrants)
    .set({ available: sql`least(${notifyGrants.available} + 1, ${MAX_AVAILABLE_GRANTS}::int)`, lastSentAt: previousSentAt })
    .where(and(eq(notifyGrants.userId, userId), eq(notifyGrants.templateId, templateId)));
}

/** WeChat says no subscription is left: our count is stale, drop it to zero. */
export async function clearGrants(db: Executor, { userId, templateId, now }: { userId: string; templateId: string; now: Date }): Promise<void> {
  await db
    .update(notifyGrants)
    .set({ available: 0, updatedAt: now })
    .where(and(eq(notifyGrants.userId, userId), eq(notifyGrants.templateId, templateId)));
}
