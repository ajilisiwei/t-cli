import { and, eq, isNull, lt } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { lookupEvents } from '../../db/schema.ts';
import { countLookups, fillWordFromLexicon, insertUnitIfAbsent, lexiconRow, lockUnit, type UnitContext } from '../learn/units.ts';
import { LexiconEntrySchema } from '../lookup/lexicon.ts';
import type { RunContext } from './llmJson.ts';

/**
 * Step 0 of the nightly job (docs/api-v1.md, "v3 → Pipeline"): the account's
 * lookup events since the last run, merged by lemma key into word units. An
 * existing unit gets `lookupCount += n` and a later `lastSeenAt`; otherwise a
 * new word unit is created, `ready` with content and cards when the lexicon
 * has the entry, else `pending` for step 2. Events are marked merged in the
 * same transaction, so a crash merges nothing twice. Events older than 180
 * days are deleted.
 */

export const LOOKUP_EVENT_RETENTION_DAYS = 180;

export interface LookupMergeSummary {
  /** Events merged this run. */
  events: number;
  /** Distinct lemma keys among them. */
  keys: number;
  unitsCreated: number;
  /** Units given content from the lexicon (new ones, or existing ones still without content). */
  unitsFilled: number;
  /** Events deleted for age. */
  deleted: number;
}

interface KeyCount {
  key: string;
  n: number;
  first: Date;
  last: Date;
}

/** Merged events grouped by key, keys in a stable order (so concurrent runs lock in the same order). */
export function groupByKey(events: readonly { lemmaKey: string; createdAt: Date }[]): KeyCount[] {
  const groups = new Map<string, KeyCount>();
  for (const { lemmaKey, createdAt } of events) {
    const current = groups.get(lemmaKey);
    groups.set(
      lemmaKey,
      current
        ? {
            key: lemmaKey,
            n: current.n + 1,
            first: createdAt < current.first ? createdAt : current.first,
            last: createdAt > current.last ? createdAt : current.last,
          }
        : { key: lemmaKey, n: 1, first: createdAt, last: createdAt },
    );
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** The display form of a new unit: the lexicon entry's lemma ("Paris"), else the key. */
async function displayFor(tx: Executor, ctx: UnitContext, key: string): Promise<string> {
  const entry = await lexiconRow(tx, ctx.explanationLang, key);
  const parsed = entry ? LexiconEntrySchema.safeParse(entry.content) : null;
  return parsed?.success ? parsed.data.lemma : key;
}

/** Fold one key's events into its word unit; true when the unit was created. */
async function mergeKey(tx: Executor, ctx: UnitContext, group: KeyCount): Promise<{ created: boolean; filled: boolean }> {
  const existing = await lockUnit(tx, ctx.userId, 'word', group.key);
  if (existing) {
    await countLookups(tx, ctx.userId, existing.id, group.n, group.last);
    return { created: false, filled: await fillWordFromLexicon(tx, ctx, existing) };
  }
  const display = await displayFor(tx, ctx, group.key);
  const unit = { type: 'word' as const, normKey: group.key, display, lookupCount: group.n, firstSeenAt: group.first, lastSeenAt: group.last };
  const created = await insertUnitIfAbsent(tx, ctx, unit);
  if (!created) {
    // Created concurrently (a note saved meanwhile): count the lookups on it instead.
    const raced = await lockUnit(tx, ctx.userId, 'word', group.key);
    if (raced) await countLookups(tx, ctx.userId, raced.id, group.n, group.last);
    return { created: false, filled: false };
  }
  return { created: true, filled: await fillWordFromLexicon(tx, ctx, created) };
}

export async function mergeLookupEvents(ctx: RunContext): Promise<LookupMergeSummary> {
  const unitCtx: UnitContext = { userId: ctx.userId, explanationLang: ctx.lang, now: ctx.now };
  const merged = await ctx.db.transaction(async (tx) => {
    const events = await tx
      .update(lookupEvents)
      .set({ mergedAt: ctx.now })
      .where(and(eq(lookupEvents.userId, ctx.userId), isNull(lookupEvents.mergedAt)))
      .returning({ lemmaKey: lookupEvents.lemmaKey, createdAt: lookupEvents.createdAt });
    const groups = groupByKey(events);
    let unitsCreated = 0;
    let unitsFilled = 0;
    for (const group of groups) {
      const result = await mergeKey(tx, unitCtx, group);
      unitsCreated += result.created ? 1 : 0;
      unitsFilled += result.filled ? 1 : 0;
    }
    return { events: events.length, keys: groups.length, unitsCreated, unitsFilled };
  });

  const cutoff = new Date(ctx.now.getTime() - LOOKUP_EVENT_RETENTION_DAYS * 86_400_000);
  const deleted = await ctx.db
    .delete(lookupEvents)
    .where(and(eq(lookupEvents.userId, ctx.userId), lt(lookupEvents.createdAt, cutoff)))
    .returning({ id: lookupEvents.id });
  return { ...merged, deleted: deleted.length };
}
