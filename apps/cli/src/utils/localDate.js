/**
 * Calendar dates for the per-day files under the config dir
 * (`history/YYYY-MM-DD.md`, `notes/YYYY-MM-DD.md`) and the commands that
 * address them (`/history today`, `/notes today`, `/quiz [days]`).
 *
 * All of them use the user's local calendar date (process time zone), so an
 * entry made at 07:30 in Beijing lands in that day's file, not the previous
 * UTC day's. History files written before this rule are named by UTC date;
 * utils/historyParser.js tells the two apart by the file header.
 */

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Local calendar date of `date` as YYYY-MM-DD.
 * @param {Date} [date] defaults to now
 * @returns {string}
 * @throws {TypeError} on an invalid Date
 */
export function localDateString(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('localDateString expects a valid Date');
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * The local date `days` calendar days before `now`. Calendar arithmetic, so a
 * DST change never skips or repeats a date.
 * @param {number} days non-negative integer
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD
 * @throws {TypeError} on a negative or non-integer `days`, or an invalid Date
 */
export function localDateDaysAgo(days, now = new Date()) {
  if (!Number.isInteger(days) || days < 0) {
    throw new TypeError('days must be a non-negative integer');
  }
  localDateString(now); // validates `now`
  return localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - days));
}
