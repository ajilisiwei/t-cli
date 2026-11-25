/**
 * Pure text helpers for the PDF: Chinese dates and numerals, glosses, and
 * whitespace clean-up. Dates are local calendar days "YYYY-MM-DD".
 */

const partsOf = (date: string): { year: number; month: number; day: number } => {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  return { year, month, day };
};

/** "2026-11-24" → "2026年11月24日". */
export function cnDate(date: string): string {
  const { year, month, day } = partsOf(date);
  return `${year}年${month}月${day}日`;
}

/** "2026-11-24" → "11月24日". */
export function monthDay(date: string): string {
  const { month, day } = partsOf(date);
  return `${month}月${day}日`;
}

/** "2026-11-24" → "1124" (file names). */
export const mmdd = (date: string): string => date.slice(5, 7) + date.slice(8, 10);

/** One date, or "11月18日–11月24日" for a range (input in any order). */
export function dateRangeLabel(dates: readonly string[]): string {
  const sorted = [...new Set(dates)].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return '';
  return first === last ? monthDay(first) : `${monthDay(first)}–${monthDay(last)}`;
}

/** ISO 8601 week number of a date. */
export function isoWeek(date: string): number {
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(day.getTime() + (3 - weekday) * 86_400_000);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7;
  const weekOne = firstThursday.getTime() - firstWeekday * 86_400_000;
  return 1 + Math.floor((thursday.getTime() - weekOne) / (7 * 86_400_000));
}

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

/** 1 → "一", 10 → "十", 12 → "十二", 25 → "二十五" (section numbers; 1–99). */
export function cnNumeral(n: number): string {
  if (n < 10) return DIGITS[n] ?? String(n);
  if (n > 99) return String(n);
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${tens === 1 ? '' : DIGITS[tens]}十${ones === 0 ? '' : DIGITS[ones]}`;
}

/** Collapse whitespace (line breaks included) into single spaces. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Paragraphs of a longer text: split on line breaks, empty ones dropped. */
export const paragraphsOf = (text: string): string[] =>
  text
    .split(/\r\n|\r|\n/)
    .map(oneLine)
    .filter((line) => line !== '');

/** "v. 减轻；缓和" from a word's meanings (at most `max` of them). */
export function glossOfMeanings(meanings: readonly { pos: string; zh: string }[], max = 2): string {
  return meanings
    .slice(0, max)
    .map((meaning) => oneLine(`${meaning.pos} ${meaning.zh}`))
    .join('；');
}

/** The example to print: the first one not taken from the user's own records, else the first. */
export function pickExample<T extends { fromUser?: boolean }>(examples: readonly T[]): T | undefined {
  return examples.find((example) => example.fromUser !== true) ?? examples[0];
}

export const TOPIC_LABELS: Readonly<Record<string, string>> = {
  work: '职场',
  travel: '旅行',
  exam: '考试',
  daily: '日常',
  tech: '科技',
  culture: '文化',
  finance: '财经',
  health: '健康',
  other: '综合',
};
