import { and, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { entries, items, materials, reviewLogs } from '../../db/schema.ts';
import { addDays, localDayRange, streakEndingOn } from './dates.ts';
import { askJson, MAX_ATTEMPTS, byRef, type RunContext } from './llmJson.ts';
import { dailyExtrasMessages, weeklySummaryMessages, type MistakeRequest } from './prompts.ts';
import {
  DailyExtrasSchema,
  MistakeNoteSchema,
  parseStoredContent,
  StorySchema,
  WeeklySummarySchema,
  type ExplanationLang,
  type GrammarContent,
  type ItemContent,
  type PhraseContent,
  type WordContent,
} from './schemas.ts';
import { containsCjk, findTarget, wordCount, wordKey } from './text.ts';

/**
 * Steps 3 and 4: the daily material for a local day and the weekly report
 * (docs/api-v1.md, "Materials"). Built from item contents and statistics;
 * the model only writes the story, the mistake notes and the weekly summary.
 * Materials never contain paragraph text: items carry no paragraph quotes.
 */

export const DAILY_CAPS = { words: 12, phrases: 6, grammar: 4, mistakes: 5 } as const;
const WEEKLY_CAPS = { topErrors: 5, topLookups: 10 } as const;
const STORY_MIN_WORDS = 5;
/** "易错回顾": units rated 忘记 at least this often in the last MISTAKE_WINDOW_DAYS days. */
const MISTAKE_MIN_MISSES = 2;
const MISTAKE_WINDOW_DAYS = 7;
const STREAK_LOOKBACK_DAYS = 400;

export type Story = { title: string; text: string; words: string[]; zh: string };
export type Mistake = { itemId: string; display: string; note: string; example: { en: string; zh: string } };

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

interface ReadyItem {
  id: string;
  display: string;
  lookupCount: number;
  errorCount: number;
  parsed: ItemContent;
}

const weight = (item: { errorCount: number; lookupCount: number }): number => item.errorCount * 2 + item.lookupCount;

/** Stars from which an item is picked before the usual weighting (docs/api-v1.md, "Review by importance"). */
export const PRIORITY_MIN_STARS = 3;

/** 4 ★ items first, then 3 ★; every other item ranks by weight alone. */
export const priorityOf = (stars: number): number => (stars >= PRIORITY_MIN_STARS ? stars : 0);

type RankedRow = { stars: number; errorCount: number; lookupCount: number; lastSeenAt: Date };

/** Daily material order: priority (stars), then weight, then the most recently seen. */
export function compareForMaterial(a: RankedRow, b: RankedRow): number {
  return priorityOf(b.stars) - priorityOf(a.stars) || weight(b) - weight(a) || b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
}

async function materialExists(db: Executor, userId: string, kind: 'daily' | 'weekly', date: string): Promise<boolean> {
  const [row] = await db
    .select({ date: materials.date })
    .from(materials)
    .where(and(eq(materials.userId, userId), eq(materials.kind, kind), eq(materials.date, date)));
  return Boolean(row);
}

async function saveMaterial(ctx: RunContext, kind: 'daily' | 'weekly', date: string, content: DailyMaterial | WeeklyReport): Promise<void> {
  await ctx.db
    .insert(materials)
    .values({ userId: ctx.userId, kind, date, content: { ...content }, model: ctx.model })
    .onConflictDoNothing();
}

async function countEntries(db: Executor, userId: string, range: { start: Date; end: Date }, task?: 'check'): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(entries)
    .where(
      and(
        eq(entries.userId, userId),
        gte(entries.createdAt, range.start),
        lt(entries.createdAt, range.end),
        ...(task ? [eq(entries.task, task)] : []),
      ),
    );
  return row?.n ?? 0;
}

async function countReviews(db: Executor, userId: string, range: { start: Date; end: Date }): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(reviewLogs)
    .where(and(eq(reviewLogs.userId, userId), gte(reviewLogs.reviewedAt, range.start), lt(reviewLogs.reviewedAt, range.end)));
  return row?.n ?? 0;
}

async function countNewItems(
  db: Executor,
  userId: string,
  range: { start: Date; end: Date },
  type?: 'word' | 'phrase',
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        gte(items.firstSeenAt, range.start),
        lt(items.firstSeenAt, range.end),
        ...(type ? [eq(items.type, type)] : []),
      ),
    );
  return row?.n ?? 0;
}

/**
 * The day's items, with valid content: those with a source record made in
 * the range, and those a live note was saved or changed for in the range (a
 * word tapped in a sentence has no source record of its own). 4 ★ first,
 * then 3 ★, then heaviest first.
 */
async function readyItemsFromRange(db: Executor, userId: string, range: { start: Date; end: Date }): Promise<ReadyItem[]> {
  const start = range.start.toISOString();
  const end = range.end.toISOString();
  const rows = await db
    .select({
      id: items.id,
      type: items.type,
      display: items.display,
      content: items.content,
      lookupCount: items.lookupCount,
      errorCount: items.errorCount,
      stars: items.stars,
      lastSeenAt: items.lastSeenAt,
    })
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        eq(items.status, 'ready'),
        sql`(exists (select 1 from item_sources s join entries e on e.user_id = s.user_id and e.id = s.entry_id
              where s.user_id = ${items.userId} and s.item_id = ${items.id}
                and e.created_at >= ${start}::timestamptz and e.created_at < ${end}::timestamptz)
          or exists (select 1 from notes n
              where n.user_id = ${items.userId} and n.item_id = ${items.id} and n.deleted_at is null
                and n.updated_at >= ${start}::timestamptz and n.updated_at < ${end}::timestamptz))`,
      ),
    );
  return [...rows]
    .sort(compareForMaterial)
    .flatMap((row) => {
      const parsed = parseStoredContent(row.type, row.content);
      return parsed ? [{ id: row.id, display: row.display, lookupCount: row.lookupCount, errorCount: row.errorCount, parsed }] : [];
    });
}

/** Local days with at least one record or review, up to `endDate`. */
async function activeDays(db: Executor, userId: string, endDate: string, utcOffsetMinutes: number): Promise<Set<string>> {
  const { end } = localDayRange(endDate, utcOffsetMinutes);
  const since = new Date(end.getTime() - STREAK_LOOKBACK_DAYS * 86_400_000);
  const shift = sql`make_interval(mins => ${utcOffsetMinutes}::int)`;
  const rows = await db.execute<{ day: string }>(sql`
    select to_char((created_at at time zone 'UTC') + ${shift}, 'YYYY-MM-DD') as day from entries
      where user_id = ${userId} and created_at >= ${since.toISOString()}::timestamptz and created_at < ${end.toISOString()}::timestamptz
    union
    select to_char((reviewed_at at time zone 'UTC') + ${shift}, 'YYYY-MM-DD') as day from review_logs
      where user_id = ${userId} and reviewed_at >= ${since.toISOString()}::timestamptz and reviewed_at < ${end.toISOString()}::timestamptz`);
  return new Set(rows.map((row) => row.day));
}

/** Items rated 忘记 (1) at least MISTAKE_MIN_MISSES times in the window, most misses first. */
async function frequentMistakes(db: Executor, userId: string, range: { start: Date; end: Date }): Promise<ReadyItem[]> {
  const misses = await db.execute<{ item_id: string; misses: number }>(sql`
    select c.item_id, count(*)::int as misses
      from review_logs l join cards c on c.user_id = l.user_id and c.id = l.card_id
     where l.user_id = ${userId} and l.rating = 1
       and l.reviewed_at >= ${range.start.toISOString()}::timestamptz and l.reviewed_at < ${range.end.toISOString()}::timestamptz
     group by c.item_id having count(*) >= ${MISTAKE_MIN_MISSES}
     order by misses desc, c.item_id
     limit ${DAILY_CAPS.mistakes}`);
  const ids = misses.map((row) => row.item_id);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: items.id, type: items.type, display: items.display, content: items.content, lookupCount: items.lookupCount, errorCount: items.errorCount })
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.status, 'ready'), inArray(items.id, ids)));
  return ids.flatMap((id) => {
    const row = rows.find((candidate) => candidate.id === id);
    const parsed = row ? parseStoredContent(row.type, row.content) : null;
    return row && parsed ? [{ id, display: row.display, lookupCount: row.lookupCount, errorCount: row.errorCount, parsed }] : [];
  });
}

// ------------------------------------------------------------- daily extras

function knownExampleOf(item: ItemContent): { en: string; zh: string } {
  if (item.type === 'grammar') return { en: item.content.right, zh: item.content.title };
  const [first, second] = item.content.examples;
  const example = second ?? first;
  return example ? { en: example.en, zh: example.zh } : { en: '', zh: '' };
}

/** Without a model answer, the mistake section repeats the item's own explanation. */
function fallbackNote(item: ReadyItem): Mistake {
  const { parsed } = item;
  const note =
    parsed.type === 'word'
      ? parsed.content.meanings.map((meaning) => `${meaning.pos} ${meaning.zh}`).join('；')
      : parsed.type === 'phrase'
        ? parsed.content.zh
        : parsed.content.rule;
  return { itemId: item.id, display: item.display, note, example: knownExampleOf(parsed) };
}

export function validateStory(raw: unknown, storyWords: readonly string[], lang: ExplanationLang): Story | null {
  const parsed = StorySchema.safeParse(raw);
  if (!parsed.success) return null;
  const story = parsed.data;
  const byKey = new Map(storyWords.map((word) => [wordKey(word), word]));
  const words = [...new Set(story.words.map((word) => byKey.get(wordKey(word))))];
  if (words.some((word) => word === undefined) || words.length < STORY_MIN_WORDS) return null;
  const used = words.filter((word): word is string => word !== undefined);
  if (!used.every((word) => findTarget(story.text, word))) return null;
  const length = wordCount(story.text);
  if (length < 60 || length > 250) return null;
  if (lang === 'zh' && !containsCjk(story.zh)) return null;
  return { title: story.title, text: story.text, words: used, zh: story.zh };
}

function validateNote(raw: unknown, lang: ExplanationLang): { note: string; example: { en: string; zh: string } } | null {
  const parsed = MistakeNoteSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (lang === 'zh' && !containsCjk(parsed.data.note)) return null;
  return { note: parsed.data.note, example: parsed.data.example };
}

/** The story and the mistake notes, in one call (retried for whatever is still invalid). */
async function dailyExtras(
  ctx: RunContext,
  date: string,
  storyWords: readonly string[],
  mistakeItems: readonly ReadyItem[],
): Promise<{ story: Story | null; mistakes: Mistake[] }> {
  const requests: MistakeRequest[] = mistakeItems.map((item, i) => ({
    ref: `m${i + 1}`,
    type: item.parsed.type,
    display: item.display,
    knownExample: knownExampleOf(item.parsed).en,
  }));
  let story: Story | null | undefined = storyWords.length >= STORY_MIN_WORDS ? undefined : null;
  let notes = new Map<string, { note: string; example: { en: string; zh: string } }>();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const wantStory = story === undefined;
    const wanted = requests.filter((request) => !notes.has(request.ref));
    if (!wantStory && wanted.length === 0) break;
    const answer = await askJson(ctx, dailyExtrasMessages({ date, storyWords: wantStory ? storyWords : [], mistakes: wanted }, ctx.lang));
    if (!answer.ok) continue;
    const extras = DailyExtrasSchema.safeParse(answer.value);
    if (!extras.success) continue;
    if (wantStory) story = validateStory(extras.data.story, storyWords, ctx.lang) ?? undefined;
    const answered = byRef(extras.data.mistakes ?? []);
    const valid = wanted.flatMap((request) => {
      const note = validateNote(answered.get(request.ref), ctx.lang);
      return note ? [[request.ref, note] as const] : [];
    });
    notes = new Map([...notes, ...valid]);
  }

  const mistakes = mistakeItems.map((item, i) => {
    const note = notes.get(`m${i + 1}`);
    return note ? { itemId: item.id, display: item.display, ...note } : fallbackNote(item);
  });
  return { story: story ?? null, mistakes };
}

/** Daily material for `date` (a local day of the account), unless it exists or the day had no records. */
export async function buildDailyMaterial(ctx: RunContext, date: string): Promise<MaterialOutcome> {
  const { db, userId, utcOffsetMinutes } = ctx;
  if (await materialExists(db, userId, 'daily', date)) return 'exists';
  const day = localDayRange(date, utcOffsetMinutes);
  if ((await countEntries(db, userId, day)) === 0) return 'no_activity';

  const dayItems = await readyItemsFromRange(db, userId, day);
  const pick = <T extends ItemContent['type']>(type: T, cap: number) =>
    dayItems.filter((item) => item.parsed.type === type).slice(0, cap);
  const words = pick('word', DAILY_CAPS.words);
  const phrases = pick('phrase', DAILY_CAPS.phrases);
  const grammar = pick('grammar', DAILY_CAPS.grammar);
  const mistakeItems = await frequentMistakes(db, userId, localDayRange(addDays(date, 1 - MISTAKE_WINDOW_DAYS), utcOffsetMinutes, MISTAKE_WINDOW_DAYS));

  const storyWords = words.flatMap((item) => (item.parsed.type === 'word' ? [item.parsed.content.headword] : []));
  const extras =
    storyWords.length >= STORY_MIN_WORDS || mistakeItems.length > 0
      ? await dailyExtras(ctx, date, storyWords, mistakeItems)
      : { story: null, mistakes: [] };

  const material: DailyMaterial = {
    date,
    overview: {
      newWords: await countNewItems(db, userId, day, 'word'),
      newPhrases: await countNewItems(db, userId, day, 'phrase'),
      corrections: await countEntries(db, userId, day, 'check'),
      streakDays: streakEndingOn(await activeDays(db, userId, date, utcOffsetMinutes), date),
    },
    words: words.flatMap((item) => (item.parsed.type === 'word' ? [{ itemId: item.id, ...item.parsed.content }] : [])),
    phrases: phrases.flatMap((item) => (item.parsed.type === 'phrase' ? [{ itemId: item.id, ...item.parsed.content }] : [])),
    grammar: grammar.flatMap((item) => (item.parsed.type === 'grammar' ? [{ itemId: item.id, ...item.parsed.content }] : [])),
    story: extras.story,
    mistakes: extras.mistakes,
  };
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
