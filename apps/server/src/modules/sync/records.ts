import type { FastifyRequest } from 'fastify';
import { and, eq, gte, ilike, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../../db/client.ts';
import { entries } from '../../db/schema.ts';
import { addDays, DAY_MS, LocalDate, localDateSql, localDay, startOfLocalDate, UtcOffsetMinutes } from '../review/common.ts';

/**
 * The record page (记录页, docs/api-v1.md, "v2 → Records"): records per
 * local day, and the filters of `GET /v1/entries/history`. Every query
 * filters on the caller's user_id.
 */

/** Longest `from`…`to` range of `GET /v1/entries/days`, in days (inclusive). */
export const DAYS_MAX_RANGE = 366;
/** Longest search text `q`, in code points after trimming. */
export const HISTORY_Q_MAX_CHARS = 100;

export const EntrySource = z.enum(['cli', 'mp']);
export type EntrySource = z.infer<typeof EntrySource>;

const daysInRange = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;

export const DaysQuery = z
  .object({ from: LocalDate, to: LocalDate, utcOffsetMinutes: UtcOffsetMinutes, source: EntrySource.optional() })
  .refine((query) => query.from <= query.to, { path: ['to'], message: 'must not be before from' })
  .refine((query) => daysInRange(query.from, query.to) <= DAYS_MAX_RANGE, { path: ['to'], message: `the range is at most ${DAYS_MAX_RANGE} days` });
export type DaysQuery = z.infer<typeof DaysQuery>;

/** `q`: trimmed, 1–100 code points; empty counts as absent. */
export const HistorySearch = z
  .string()
  .trim()
  .refine((value) => [...value].length <= HISTORY_Q_MAX_CHARS, `must be at most ${HISTORY_Q_MAX_CHARS} characters`)
  .optional()
  .transform((value) => (value ? value : undefined));

/** The filters `GET /v1/entries/history` gains (all optional, combined with AND). */
export const HistoryFilters = z.object({
  date: LocalDate.optional(),
  utcOffsetMinutes: UtcOffsetMinutes,
  source: EntrySource.optional(),
  q: HistorySearch,
});
export type HistoryFilters = z.infer<typeof HistoryFilters>;

/** `value` as a LIKE pattern that matches it literally (`%`, `_` and `\` match themselves). */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * SQL for the history filters, ANDed; undefined when there is none. `q` is
 * a case-insensitive substring of `input` (ILIKE, served by the trigram index
 * entries_input_trgm_idx); `date` is one local day at the caller's offset.
 */
export function historyFilter({ date, utcOffsetMinutes, source, q }: HistoryFilters): SQL | undefined {
  const day = date === undefined ? undefined : localDay(date, utcOffsetMinutes);
  return and(
    day ? gte(entries.createdAt, day.start) : undefined,
    day ? lt(entries.createdAt, day.end) : undefined,
    source ? eq(entries.source, source) : undefined,
    q ? ilike(entries.input, `%${escapeLike(q)}%`) : undefined,
  );
}

/**
 * The local dates (at the caller's offset) in `from`…`to` with at least one
 * of the account's records, ascending, with their counts.
 */
export async function listEntryDays(
  db: Executor,
  userId: string,
  { from, to, utcOffsetMinutes, source }: DaysQuery,
): Promise<{ date: string; count: number }[]> {
  const rows = await db
    .select({ date: localDateSql(entries.createdAt, utcOffsetMinutes), count: sql<number>`count(*)::int` })
    .from(entries)
    .where(
      and(
        eq(entries.userId, userId),
        gte(entries.createdAt, startOfLocalDate(from, utcOffsetMinutes)),
        lt(entries.createdAt, startOfLocalDate(addDays(to, 1), utcOffsetMinutes)),
        source ? eq(entries.source, source) : undefined,
      ),
    )
    // By position: the date expression carries the offset as a parameter, so
    // a repeated expression would not count as the same one in GROUP BY.
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return rows.map((row) => ({ date: row.date, count: row.count }));
}

/**
 * How record requests are logged: the default serializer logs `req.url`
 * with its query string, and `q` is the user's own text.
 */
export const RECORD_LOG_SERIALIZERS = {
  req: (request: FastifyRequest) => ({ method: request.method, url: request.url.split('?')[0], host: request.host, remoteAddress: request.ip }),
};
