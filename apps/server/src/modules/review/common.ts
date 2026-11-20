import type { FastifyReply } from 'fastify';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../http/errors.ts';
import type { RateLimiter } from '../../lib/rateLimit.ts';

/**
 * Helpers shared by the learning routes (review, library, account, notify):
 * the caller's local day, id parameters and per-account rate limits.
 */

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;
export const DEFAULT_UTC_OFFSET_MINUTES = 480;

/** `utcOffsetMinutes` (query or body): -720…840, default 480 (docs/api-v1.md, "Local day"). */
export const UtcOffsetMinutes = z.coerce.number().int().min(-720).max(840).default(DEFAULT_UTC_OFFSET_MINUTES);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date `YYYY-MM-DD` that actually exists (no 2026-02-30). */
export const LocalDate = z.string().refine((value) => DATE_RE.test(value) && isRealDate(value), { message: 'expected a date YYYY-MM-DD' });

/** `:id` of a card, item or review log. */
export const IdParams = z.object({ id: z.string().trim().min(1).max(64) });

function isRealDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** The local calendar date ("YYYY-MM-DD") at `instant` for a UTC offset in minutes. */
export function localDateOf(instant: Date, utcOffsetMinutes: number): string {
  return new Date(instant.getTime() + utcOffsetMinutes * MINUTE_MS).toISOString().slice(0, 10);
}

/** The instant a local date starts at, for a UTC offset in minutes. */
export function startOfLocalDate(date: string, utcOffsetMinutes: number): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) - utcOffsetMinutes * MINUTE_MS);
}

/** `date` plus `days` calendar days (negative goes back). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday of the (ISO) week `date` is in. */
export function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/** One local day as a half-open instant range [start, end). */
export interface LocalDay {
  date: string;
  start: Date;
  end: Date;
}

export function localDayAt(instant: Date, utcOffsetMinutes: number): LocalDay {
  const date = localDateOf(instant, utcOffsetMinutes);
  return localDay(date, utcOffsetMinutes);
}

export function localDay(date: string, utcOffsetMinutes: number): LocalDay {
  return { date, start: startOfLocalDate(date, utcOffsetMinutes), end: startOfLocalDate(addDays(date, 1), utcOffsetMinutes) };
}

/** Count one request against `limiter`; throws 429 RATE_LIMITED (with Retry-After) when over. */
export function enforceRateLimit(limiter: RateLimiter, key: string, now: Date, reply: FastifyReply, message: string): void {
  const result = limiter.hit(key, now.getTime());
  if (result.allowed) return;
  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  reply.header('retry-after', String(retryAfterSeconds));
  throw new AppError(429, 'RATE_LIMITED', message, { retryAfterSeconds });
}

/** SQL: the local timestamp (without time zone) of a timestamptz expression at a fixed UTC offset. */
export function localTimestampSql(instant: SQLWrapper, utcOffsetMinutes: number): SQL {
  return sql`((${instant} at time zone 'UTC') + make_interval(mins => ${utcOffsetMinutes}::int))`;
}

/** SQL: the local date, as text `YYYY-MM-DD`, of a timestamptz expression at a fixed UTC offset. */
export function localDateSql(instant: SQLWrapper, utcOffsetMinutes: number): SQL<string> {
  return sql<string>`to_char(${localTimestampSql(instant, utcOffsetMinutes)}, 'YYYY-MM-DD')`;
}
