import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { loggableError } from '../../http/errors.ts';
import type { Alerter } from '../../ports.ts';
import { DEFAULT_UTC_OFFSET_MINUTES, localDateOf, MINUTE_MS } from '../review/common.ts';
import { reviewSummary, type ReviewLimits } from '../review/queue.ts';
import { fillReminderData, type ReminderConfig } from './config.ts';
import { clearGrants, releaseGrant, reserveGrant } from './grants.ts';
import { ERRCODE_NO_SUBSCRIPTION, ReminderSendError, type ReminderSender } from './sender.ts';

/** The page a reminder opens. */
export const REMINDER_PAGE = 'pages/review/index';
/** At most one reminder per account within this window (one per day in practice). */
export const REMINDER_MIN_GAP_MS = 12 * 60 * MINUTE_MS;

interface Candidate {
  userId: string;
  openid: string;
  reminderHour: number;
  utcOffsetMinutes: number;
  lastSentAt: Date | null;
}

export interface ReminderRunResult {
  /** Accounts with a reminder hour, a grant and a WeChat identity. */
  candidates: number;
  /** Of those, the ones whose local hour it is and that have cards due. */
  attempted: number;
  sent: number;
  failed: number;
  /** WeChat said the user has no subscription left; the grant count was reset. */
  noSubscription: number;
}

/**
 * Accounts that could get a reminder: an integer `reminderHour` setting, a
 * grant for the template, nothing sent since `notBefore`, and a WeChat
 * identity. The local offset is that of the account's most recent entry
 * (default 480), as for the nightly jobs.
 */
async function candidates(db: Database, templateId: string, notBefore: Date): Promise<Candidate[]> {
  const rows = await db.execute<{ user_id: string; openid: string; reminder_hour: number; utc_offset_minutes: number; last_sent_ms: number | null }>(sql`
    select u.id as user_id, ident.subject as openid,
           (u.settings ->> 'reminderHour')::float8 as reminder_hour,
           coalesce((
             select e.utc_offset_minutes from entries e
             where e.user_id = u.id order by e.created_at desc, e.seq desc limit 1
           ), ${DEFAULT_UTC_OFFSET_MINUTES})::int as utc_offset_minutes,
           (extract(epoch from g.last_sent_at) * 1000)::float8 as last_sent_ms
    from users u
    join notify_grants g on g.user_id = u.id and g.template_id = ${templateId} and g.available > 0
      and (g.last_sent_at is null or g.last_sent_at < ${notBefore.toISOString()}::timestamptz)
    join lateral (
      select i.subject from identities i
      where i.user_id = u.id and i.provider = 'wechat_mp'
      order by i.created_at desc limit 1
    ) ident on true
    where u.deleted_at is null and jsonb_typeof(u.settings -> 'reminderHour') = 'number'
    order by u.id`);
  return rows
    .filter((row) => Number.isInteger(row.reminder_hour) && row.reminder_hour >= 0 && row.reminder_hour <= 23)
    .map((row) => ({
      userId: row.user_id,
      openid: row.openid,
      reminderHour: row.reminder_hour,
      utcOffsetMinutes: row.utc_offset_minutes,
      lastSentAt: row.last_sent_ms === null ? null : new Date(row.last_sent_ms),
    }));
}

const localHourOf = (now: Date, utcOffsetMinutes: number): number => new Date(now.getTime() + utcOffsetMinutes * MINUTE_MS).getUTCHours();

/**
 * The hourly reminder run (docs/api-v1.md, "Reminders"): for every account
 * whose `reminderHour` is the current local hour, that has at least one card
 * the queue would serve and a grant left, send one subscribe message and
 * consume the grant. A grant is taken before sending and given back when the
 * send fails. Failures (other than "no subscription left") raise one
 * `reminder_failed` alert per run — counts and WeChat errcodes only.
 */
export async function runReminders(
  deps: { db: Database; alerter: Alerter },
  { sender, reminder, limits, now }: { sender: ReminderSender; reminder: ReminderConfig; limits: ReviewLimits; now: Date },
): Promise<ReminderRunResult> {
  const { db } = deps;
  const { templateId } = reminder;
  const result: ReminderRunResult = { candidates: 0, attempted: 0, sent: 0, failed: 0, noSubscription: 0 };
  const failures = new Set<string>();
  const notBefore = new Date(now.getTime() - REMINDER_MIN_GAP_MS);
  const all = await candidates(db, templateId, notBefore);
  result.candidates = all.length;

  for (const candidate of all) {
    const { userId, utcOffsetMinutes } = candidate;
    if (localHourOf(now, utcOffsetMinutes) !== candidate.reminderHour) continue;
    const { due } = await reviewSummary(db, { userId, now, utcOffsetMinutes, limits });
    if (due === 0) continue;
    if (!(await reserveGrant(db, { userId, templateId, now, notBefore }))) continue;
    result.attempted += 1;
    try {
      await sender.send({
        openid: candidate.openid,
        templateId,
        page: REMINDER_PAGE,
        data: fillReminderData(reminder.fields, { due, date: localDateOf(now, utcOffsetMinutes) }),
      });
      result.sent += 1;
    } catch (error) {
      const errcode = error instanceof ReminderSendError ? error.errcode : undefined;
      if (errcode === ERRCODE_NO_SUBSCRIPTION) {
        await clearGrants(db, { userId, templateId, now });
        result.noSubscription += 1;
        continue;
      }
      await releaseGrant(db, { userId, templateId, previousSentAt: candidate.lastSentAt });
      result.failed += 1;
      failures.add(errcode !== undefined ? `errcode ${errcode}` : error instanceof ReminderSendError ? error.message : loggableError(error).errName);
    }
  }

  if (result.failed > 0) {
    await deps.alerter
      .alert('reminder_failed', `${result.failed} of ${result.attempted} review reminder(s) failed: ${[...failures].sort().join('; ')}`)
      .catch(() => undefined);
  }
  return result;
}
