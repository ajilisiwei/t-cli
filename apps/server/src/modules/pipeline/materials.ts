import { sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { addDays, localDayRange, streakEndingOn } from './dates.ts';
import { dailyExtras, type Mistake, type Story } from './dailyExtras.ts';
import type { StudyLevel } from './learnContent.ts';
import { askJson, MAX_ATTEMPTS, type RunContext } from './llmJson.ts';
import {
  activeDays,
  countEntries,
  countNewItems,
  countReviews,
  frequentMistakes,
  hadActivity,
  materialExists,
  readyItemsFromRange,
  saveMaterial,
  type Range,
  type ReadyItem,
} from './materialData.ts';
import { weeklySummaryMessages } from './prompts.ts';
import { WeeklySummarySchema, type ExplanationLang, type GrammarContent, type ItemContent, type PhraseContent, type WordContent } from './schemas.ts';
import { containsCjk } from './text.ts';

/**
 * Steps 3 and 4: the daily material for a local day and the weekly report
 * (docs/api-v1.md, "Materials" and "v3 → Pipeline"). Built from item
 * contents and statistics; the model only writes the story, the mistake
 * notes and the weekly summary. Materials never contain paragraph text:
 * items carry no paragraph quotes. The digest (digest.ts) composes its
 * sections the same way over seven days.
 */

export { compareForMaterial, PRIORITY_MIN_STARS, priorityOf } from './materialData.ts';
export { validateStory, type Mistake, type Story } from './dailyExtras.ts';

export const DAILY_CAPS = { words: 12, phrases: 6, grammar: 4, mistakes: 5 } as const;
const WEEKLY_CAPS = { topErrors: 5, topLookups: 10 } as const;
/** "易错回顾" looks at the last this many days. */
export const MISTAKE_WINDOW_DAYS = 7;

export interface DailyMaterial {
  date: string;
  overview: { newWords: number; newPhrases: number; corrections: number; streakDays: number };
  words: ({ itemId: string } & WordContent)[];
  phrases: ({ itemId: string } & PhraseContent)[];
  grammar: ({ itemId: string } & GrammarContent)[];
  story: Story | null;
  mistakes: Mistake[];
}

export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  totals: { entries: number; newItems: number; reviews: number };
  topErrors: { title: string; count: number }[];
  topLookups: { display: string; count: number }[];
  retention: { thisWeek: number | null; lastWeek: number | null };
  summary: string;
}

export type MaterialOutcome = 'created' | 'exists' | 'no_activity';

/** What the account's plan asks of a daily material or digest. */
export interface MaterialOptions {
  /** materialParts has `story`: without it no story is generated (no model call for it). */
  story: boolean;
  /** The effective study level; the story is written at it. */
  level: StudyLevel;
}

export interface SectionCaps {
  words: number;
  phrases: number;
  grammar: number;
  mistakes: number;
}

const sectionOf = <T extends ItemContent['type']>(items: readonly ReadyItem[], type: T, cap: number) =>
  items.filter((item) => item.parsed.type === type).slice(0, cap);

/**
 * The sections of a daily material over `range` (one day, or the digest's
 * seven), ending on local day `date`: its units by priority and weight, the
 * mistakes of the MISTAKE_WINDOW_DAYS ending on `date`, the story, and the
 * overview counts.
 */
export async function composeMaterial(
  ctx: RunContext,
  { date, range, caps, options }: { date: string; range: Range; caps: SectionCaps; options: MaterialOptions },
): Promise<DailyMaterial> {
  const { db, userId, utcOffsetMinutes } = ctx;
  const units = await readyItemsFromRange(db, userId, range);
  const words = sectionOf(units, 'word', caps.words);
  const phrases = sectionOf(units, 'phrase', caps.phrases);
  const grammar = sectionOf(units, 'grammar', caps.grammar);
  const mistakeRange = localDayRange(addDays(date, 1 - MISTAKE_WINDOW_DAYS), utcOffsetMinutes, MISTAKE_WINDOW_DAYS);
  const mistakeItems = await frequentMistakes(db, userId, mistakeRange, caps.mistakes);
  const storyWords = options.story ? words.flatMap((item) => (item.parsed.type === 'word' ? [item.parsed.content.headword] : [])) : [];
  const extras = await dailyExtras(ctx, { date, storyWords, mistakeItems, level: options.level });

  return {
    date,
    overview: {
      newWords: await countNewItems(db, userId, range, 'word'),
      newPhrases: await countNewItems(db, userId, range, 'phrase'),
      corrections: await countEntries(db, userId, range, 'check'),
      streakDays: streakEndingOn(await activeDays(db, userId, date, utcOffsetMinutes), date),
    },
    words: words.flatMap((item) => (item.parsed.type === 'word' ? [{ itemId: item.id, ...item.parsed.content }] : [])),
    phrases: phrases.flatMap((item) => (item.parsed.type === 'phrase' ? [{ itemId: item.id, ...item.parsed.content }] : [])),
    grammar: grammar.flatMap((item) => (item.parsed.type === 'grammar' ? [{ itemId: item.id, ...item.parsed.content }] : [])),
    story: extras.story,
    mistakes: extras.mistakes,
  };
}

/**
 * Daily material for `date` (a local day of the account), unless it exists
 * or the day had no activity (a record, a lookup event, a note saved or
 * changed, or a review).
 */
export async function buildDailyMaterial(ctx: RunContext, date: string, options: MaterialOptions): Promise<MaterialOutcome> {
  const { db, userId, utcOffsetMinutes } = ctx;
  if (await materialExists(db, userId, 'daily', date)) return 'exists';
  const day = localDayRange(date, utcOffsetMinutes);
  if (!(await hadActivity(db, userId, day))) return 'no_activity';
  const material = await composeMaterial(ctx, { date, range: day, caps: DAILY_CAPS, options });
  await saveMaterial(ctx, 'daily', date, material);
  return 'created';
}

// ------------------------------------------------------------- weekly report

/** Share of ratings ≥ 2 among reviews of cards that were not new (each card's first log is its introduction). */
async function retention(db: Executor, userId: string, range: { start: Date; end: Date }): Promise<number | null> {
  const [row] = await db.execute<{ total: number; recalled: number }>(sql`
    with ranked as (
      select rating, reviewed_at, row_number() over (partition by card_id order by reviewed_at, id) as n
        from review_logs where user_id = ${userId} and reviewed_at < ${range.end.toISOString()}::timestamptz)
    select count(*) filter (where n > 1)::int as total, count(*) filter (where n > 1 and rating >= 2)::int as recalled
      from ranked where reviewed_at >= ${range.start.toISOString()}::timestamptz`);
  if (!row || row.total === 0) return null;
  return Math.round((row.recalled / row.total) * 1000) / 1000;
}

async function topErrors(db: Executor, userId: string, range: { start: Date; end: Date }): Promise<WeeklyReport['topErrors']> {
  const rows = await db.execute<{ title: string; count: number }>(sql`
    select i.display as title, count(*)::int as count
      from item_sources s
      join items i on i.user_id = s.user_id and i.id = s.item_id
      join entries e on e.user_id = s.user_id and e.id = s.entry_id
     where s.user_id = ${userId} and i.type = 'grammar' and e.task = 'check'
       and e.created_at >= ${range.start.toISOString()}::timestamptz and e.created_at < ${range.end.toISOString()}::timestamptz
     group by i.id, i.display
     order by count desc, max(e.created_at) desc
     limit ${WEEKLY_CAPS.topErrors}`);
  return rows.map((row) => ({ title: row.title, count: row.count }));
}

async function topLookups(db: Executor, userId: string, range: { start: Date; end: Date }): Promise<WeeklyReport['topLookups']> {
  const rows = await db.execute<{ display: string; count: number }>(sql`
    select i.display, count(*)::int as count
      from item_sources s
      join items i on i.user_id = s.user_id and i.id = s.item_id
      join entries e on e.user_id = s.user_id and e.id = s.entry_id
     where s.user_id = ${userId} and i.type in ('word', 'phrase')
       and e.created_at >= ${range.start.toISOString()}::timestamptz and e.created_at < ${range.end.toISOString()}::timestamptz
     group by i.id, i.display, i.lookup_count
     order by count desc, i.lookup_count desc, max(e.created_at) desc
     limit ${WEEKLY_CAPS.topLookups}`);
  return rows.map((row) => ({ display: row.display, count: row.count }));
}

function fallbackSummary(report: Omit<WeeklyReport, 'summary'>, lang: ExplanationLang): string {
  const { entries: records, newItems, reviews } = report.totals;
  return lang === 'en'
    ? `This week you made ${records} records, added ${newItems} new learning units and did ${reviews} reviews.`
    : `本周你查询了 ${records} 条记录，新增 ${newItems} 个学习单元，完成 ${reviews} 次复习。`;
}

async function weeklySummary(ctx: RunContext, report: Omit<WeeklyReport, 'summary'>): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const answer = await askJson(ctx, weeklySummaryMessages({ ...report }, ctx.lang));
    if (!answer.ok) continue;
    const parsed = WeeklySummarySchema.safeParse(answer.value);
    if (parsed.success && (ctx.lang !== 'zh' || containsCjk(parsed.data.summary))) return parsed.data.summary;
  }
  return fallbackSummary(report, ctx.lang);
}

/** The weekly report for the Monday–Sunday week ending `sunday`, stored under its Monday. */
export async function buildWeeklyReport(ctx: RunContext, sunday: string): Promise<MaterialOutcome> {
  const { db, userId, utcOffsetMinutes } = ctx;
  const weekStart = addDays(sunday, -6);
  if (await materialExists(db, userId, 'weekly', weekStart)) return 'exists';
  const week = localDayRange(weekStart, utcOffsetMinutes, 7);
  const lastWeek = localDayRange(addDays(weekStart, -7), utcOffsetMinutes, 7);
  const totals = {
    entries: await countEntries(db, userId, week),
    newItems: await countNewItems(db, userId, week),
    reviews: await countReviews(db, userId, week),
  };
  if (totals.entries === 0 && totals.reviews === 0) return 'no_activity';

  const report: Omit<WeeklyReport, 'summary'> = {
    weekStart,
    weekEnd: sunday,
    totals,
    topErrors: await topErrors(db, userId, week),
    topLookups: await topLookups(db, userId, week),
    retention: { thisWeek: await retention(db, userId, week), lastWeek: await retention(db, userId, lastWeek) },
  };
  await saveMaterial(ctx, 'weekly', weekStart, { ...report, summary: await weeklySummary(ctx, report) });
  return 'created';
}
