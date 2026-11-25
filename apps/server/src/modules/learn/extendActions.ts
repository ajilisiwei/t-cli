import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, Executor } from '../../db/client.ts';
import { items, users } from '../../db/schema.ts';
import { AppError } from '../../http/errors.ts';
import { mergeSettings, toSettings } from '../auth/settings.ts';
import { extendItemsOf } from '../library/materialView.ts';
import { getMaterialRow } from '../library/materials.ts';
import { EXTEND_TOPICS } from '../pipeline/learnContent.ts';
import { addDays, localDateOf } from '../review/common.ts';
import type { MutedTopic } from './plan.ts';
import { fillWordFromLexicon, insertUnitIfAbsent, unitKeyOf, type UnitContext } from './units.ts';

/**
 * What a user does with an extension material (docs/api-v1.md, "v3 →
 * Materials"): see which items are already units (`known`), adopt items as
 * units, and mute its topic ("不感兴趣"). Every query filters on the
 * caller's user_id.
 */

/** "不感兴趣" mutes a topic for this many days. */
export const MUTE_DAYS = 30;

type ExtendItemRef = { type: 'word' | 'phrase'; text: string } | null;

/** Per item: the account already has a unit of that type and key. */
export async function knownFlags(db: Executor, userId: string, refs: readonly ExtendItemRef[]): Promise<boolean[]> {
  const keys = refs.map((ref) => (ref ? { type: ref.type, normKey: unitKeyOf(ref.type, ref.text) } : null));
  const wordKeys = keys.flatMap((key) => (key?.type === 'word' ? [key.normKey] : []));
  const phraseKeys = keys.flatMap((key) => (key?.type === 'phrase' ? [key.normKey] : []));
  if (wordKeys.length === 0 && phraseKeys.length === 0) return refs.map(() => false);
  const rows = await db
    .select({ type: items.type, normKey: items.normKey })
    .from(items)
    .where(
      and(
        eq(items.userId, userId),
        or(
          wordKeys.length > 0 ? and(eq(items.type, 'word'), inArray(items.normKey, wordKeys)) : undefined,
          phraseKeys.length > 0 ? and(eq(items.type, 'phrase'), inArray(items.normKey, phraseKeys)) : undefined,
        ),
      ),
    );
  const existing = new Set(rows.map((row) => `${row.type}:${row.normKey}`));
  return keys.map((key) => (key ? existing.has(`${key.type}:${key.normKey}`) : false));
}

export interface AdoptResult {
  added: number[];
  known: number[];
}

/**
 * Make the chosen items units of the account. A unit that already exists is
 * `known` and left untouched; a new word with a lexicon entry is `ready` with
 * its cards at once, anything else new is `pending` for the nightly run.
 * Idempotent: adopting again finds every unit known. Null when the account
 * has no extension material of that date; an index past the items → 400.
 */
export async function adoptExtendItems(db: Database, ctx: UnitContext, { date, indexes }: { date: string; indexes: readonly number[] }): Promise<AdoptResult | null> {
  const material = await getMaterialRow(db, ctx.userId, 'extend', date);
  if (!material) return null;
  const refs = extendItemsOf(material.content);
  const invalid = indexes.filter((index) => !refs[index]);
  if (invalid.length > 0) {
    throw new AppError(400, 'VALIDATION_FAILED', 'request validation failed', [{ path: 'indexes', message: `must each be less than ${refs.length}` }]);
  }
  return db.transaction(async (tx) => {
    const added: number[] = [];
    const known: number[] = [];
    for (const index of [...indexes].sort((a, b) => a - b)) {
      const ref = refs[index]!;
      const display = ref.text.trim().replace(/\s+/g, ' ');
      const item = await insertUnitIfAbsent(tx, ctx, { type: ref.type, normKey: unitKeyOf(ref.type, display), display });
      if (!item) {
        known.push(index);
        continue;
      }
      await fillWordFromLexicon(tx, ctx, item);
      added.push(index);
    }
    return { added, known };
  });
}

const TopicSchema = z.enum(EXTEND_TOPICS);

/**
 * Mute (or with `undo`, unmute) the extension's topic in
 * `settings.extendMuted`, until the local day MUTE_DAYS later; an entry for
 * the topic is replaced and expired entries are dropped. `other` is never
 * muted. Null when the account has no extension material of that date.
 */
export async function dismissExtend(
  db: Database,
  { userId, date, undo, now, utcOffsetMinutes }: { userId: string; date: string; undo: boolean; now: Date; utcOffsetMinutes: number },
): Promise<{ extendMuted: MutedTopic[] } | null> {
  const material = await getMaterialRow(db, userId, 'extend', date);
  if (!material) return null;
  const parsed = TopicSchema.safeParse(material.content.topic);
  const topic = parsed.success ? parsed.data : 'other';
  return db.transaction(async (tx) => {
    // The account row's lock: concurrent dismissals never lose each other's entries.
    const [user] = await tx
      .select({ settings: users.settings })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .for('update');
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'account not found');
    const current: MutedTopic[] = toSettings(user.settings).extendMuted ?? [];
    if (topic === 'other') return { extendMuted: current };
    const today = localDateOf(now, utcOffsetMinutes);
    const others = current.filter((entry) => entry.topic !== topic);
    const extendMuted = undo ? others : [...others.filter((entry) => entry.until > today), { topic, until: addDays(today, MUTE_DAYS) }];
    await mergeSettings(tx, userId, { extendMuted });
    return { extendMuted };
  });
}
