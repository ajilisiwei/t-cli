import { and, desc, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { items } from '../../db/schema.ts';
import { forgottenInRange, type Range } from './materialData.ts';
import { wordKey } from './text.ts';

/**
 * What the extension prompt is told about the account (docs/api-v1.md, "v3
 * → Pipeline", step 5): only lemmas (words and short phrases), grammar point
 * titles and counts — never a user sentence. Sentence units are left out
 * everywhere; phrase units are at most a few words by construction.
 */

export const SIGNAL_WINDOW_DAYS = 14;
export const SIGNAL_CAPS = { lemmas: 60, grammar: 10, forgotten: 10, starred: 20 } as const;
const STARRED_MIN = 3;

export interface ExtendSignals {
  /** Looked up or recorded in the window, most often first. */
  lemmas: { text: string; count: number }[];
  /** Grammar points with errors, most errors first. */
  grammar: { title: string; errors: number }[];
  /** Words and phrases forgotten (忘记) in review in the window, most lapses first. */
  forgotten: { text: string; lapses: number }[];
  /** Words and phrases with ≥ 3 stars. */
  starred: string[];
}

/** Every lemma the model may cite as evidence, by its key (display form as given). */
export function givenLemmas(signals: ExtendSignals): Map<string, string> {
  const texts = [...signals.lemmas.map((lemma) => lemma.text), ...signals.forgotten.map((unit) => unit.text), ...signals.starred];
  return new Map(texts.map((text) => [wordKey(text), text] as const).reverse());
}

/** Merge counted texts by key (the first display wins), most counted first, then alphabetically. */
export function mergeCounts(lists: readonly (readonly { text: string; count: number }[])[], cap: number): { text: string; count: number }[] {
  const merged = new Map<string, { text: string; count: number }>();
  for (const list of lists) {
    for (const { text, count } of list) {
      const key = wordKey(text);
      const current = merged.get(key);
      merged.set(key, { text: current?.text ?? text, count: (current?.count ?? 0) + count });
    }
  }
  return [...merged.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, 'en')).slice(0, cap);
}

/** Lookup events in the range by lemma key, shown as the word unit's display when there is one. */
async function lookedUp(db: Executor, userId: string, range: Range): Promise<{ text: string; count: number }[]> {
  const rows = await db.execute<{ text: string; count: number }>(sql`
    select coalesce(min(i.display), ev.lemma_key) as text, count(distinct ev.id)::int as count
      from lookup_events ev
      left join items i on i.user_id = ev.user_id and i.type = 'word' and i.norm_key = ev.lemma_key
     where ev.user_id = ${userId}
       and ev.created_at >= ${range.start.toISOString()}::timestamptz and ev.created_at < ${range.end.toISOString()}::timestamptz
     group by ev.lemma_key`);
  return rows.map((row) => ({ text: row.text, count: row.count }));
}

/** Word and phrase units with a source record in the range, by the number of such records. */
async function recorded(db: Executor, userId: string, range: Range): Promise<{ text: string; count: number }[]> {
  const rows = await db.execute<{ text: string; count: number }>(sql`
    select i.display as text, count(distinct s.entry_id)::int as count
      from item_sources s
      join items i on i.user_id = s.user_id and i.id = s.item_id
      join entries e on e.user_id = s.user_id and e.id = s.entry_id
     where s.user_id = ${userId} and i.type in ('word', 'phrase')
       and e.created_at >= ${range.start.toISOString()}::timestamptz and e.created_at < ${range.end.toISOString()}::timestamptz
     group by i.id, i.display`);
  return rows.map((row) => ({ text: row.text, count: row.count }));
}

async function grammarPoints(db: Executor, userId: string): Promise<ExtendSignals['grammar']> {
  const rows = await db
    .select({ title: items.display, errors: items.errorCount })
    .from(items)
    .where(and(eq(items.userId, userId), eq(items.type, 'grammar'), gt(items.errorCount, 0)))
    .orderBy(desc(items.errorCount), desc(items.lastSeenAt))
    .limit(SIGNAL_CAPS.grammar);
  return rows.map((row) => ({ title: row.title, errors: row.errors }));
}

async function starredUnits(db: Executor, userId: string): Promise<string[]> {
  const rows = await db
    .select({ display: items.display })
    .from(items)
    .where(and(eq(items.userId, userId), inArray(items.type, ['word', 'phrase']), gte(items.stars, STARRED_MIN)))
    .orderBy(desc(items.stars), desc(items.lastSeenAt))
    .limit(SIGNAL_CAPS.starred);
  return rows.map((row) => row.display);
}

export async function extendSignals(db: Executor, userId: string, now: Date): Promise<ExtendSignals> {
  const range: Range = { start: new Date(now.getTime() - SIGNAL_WINDOW_DAYS * 86_400_000), end: now };
  const forgotten = await forgottenInRange(db, userId, range, SIGNAL_CAPS.forgotten * 2);
  return {
    lemmas: mergeCounts([await lookedUp(db, userId, range), await recorded(db, userId, range)], SIGNAL_CAPS.lemmas),
    grammar: await grammarPoints(db, userId),
    forgotten: forgotten
      .filter(({ item }) => item.parsed.type !== 'grammar')
      .slice(0, SIGNAL_CAPS.forgotten)
      .map(({ item, lapses }) => ({ text: item.display, lapses })),
    starred: await starredUnits(db, userId),
  };
}
