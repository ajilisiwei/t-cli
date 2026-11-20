/**
 * Local calendar days at a fixed UTC offset (the account's, docs/api-v1.md
 * "Local day"). Days are "YYYY-MM-DD" strings; arithmetic happens in UTC on
 * the shifted instant, so there are no DST surprises.
 */

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Offset used when an account has no entries yet (Asia/Shanghai). */
export const DEFAULT_UTC_OFFSET_MINUTES = 480;

export function localDateOf(instant: Date, utcOffsetMinutes: number): string {
  return new Date(instant.getTime() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function parseDate(date: string): number {
  if (!DATE_RE.test(date)) throw new Error('invalid local date');
  return Date.parse(`${date}T00:00:00Z`);
}

export function addDays(date: string, days: number): string {
  return new Date(parseDate(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The UTC instants [start, end) that make up `date` (or `days` days from it) at the offset. */
export function localDayRange(date: string, utcOffsetMinutes: number, days = 1): { start: Date; end: Date } {
  const start = parseDate(date) - utcOffsetMinutes * 60_000;
  return { start: new Date(start), end: new Date(start + days * DAY_MS) };
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: string): number {
  return new Date(parseDate(date)).getUTCDay();
}

/** The Monday of the (Monday–Sunday) week that contains `date`. */
export function mondayOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/**
 * Consecutive days with activity ending on `endDate` (or the day before, when
 * `endDate` itself has none yet — the contract's streak rule).
 */
export function streakEndingOn(activeDays: ReadonlySet<string>, endDate: string): number {
  let day = activeDays.has(endDate) ? endDate : addDays(endDate, -1);
  let streak = 0;
  while (activeDays.has(day)) {
    streak += 1;
    day = addDays(day, -1);
  }
  return streak;
}
