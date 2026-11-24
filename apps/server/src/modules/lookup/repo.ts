import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { aiUsage, entries, lexicon, users } from '../../db/schema.ts';
import type { QuotaKind } from '../ai/quota.ts';
import { DEFAULT_UTC_OFFSET_MINUTES } from '../pipeline/dates.ts';
import { toSettings } from '../auth/settings.ts';
import type { ExplanationLang } from '../pipeline/schemas.ts';

/**
 * Data access of `POST /v1/lookup`. Every account-owned query filters on the
 * caller's user id; the `lexicon` table is the one shared table (approved
 * exception, docs/v2-plan.html section 11): it holds no user id and no
 * sentence, only lemmas and AI-written dictionary content.
 */

/** One lexicon cache key without the lemma: (lang, explainLang, version). */
export interface LexiconScope {
  lang: string;
  explainLang: ExplanationLang;
  version: number;
}

/** The account's explanation language (default zh); null when the account is missing or deleted. */
export async function explanationLangOf(db: Executor, userId: string): Promise<ExplanationLang | null> {
  const [user] = await db
    .select({ settings: users.settings })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  if (!user) return null;
  return toSettings(user.settings).explanationLang ?? 'zh';
}

/** The UTC offset of the account's most recent record (default 480), as the nightly jobs use. */
export async function latestUtcOffset(db: Executor, userId: string): Promise<number> {
  const [latest] = await db
    .select({ offset: entries.utcOffsetMinutes })
    .from(entries)
    .where(eq(entries.userId, userId))
    .orderBy(desc(entries.seq))
    .limit(1);
  return latest?.offset ?? DEFAULT_UTC_OFFSET_MINUTES;
}

/** Whether the caller owns a record with this id. */
export async function ownsEntry(db: Executor, userId: string, entryId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: entries.id })
    .from(entries)
    .where(and(eq(entries.userId, userId), eq(entries.id, entryId)))
    .limit(1);
  return row !== undefined;
}

/** The stored entries for any of `lemmas` (content unvalidated). */
export async function readLexicon(db: Executor, scope: LexiconScope, lemmas: readonly string[]): Promise<{ lemma: string; content: unknown }[]> {
  if (lemmas.length === 0) return [];
  return db
    .select({ lemma: lexicon.lemma, content: lexicon.content })
    .from(lexicon)
    .where(
      and(
        eq(lexicon.lang, scope.lang),
        eq(lexicon.explainLang, scope.explainLang),
        eq(lexicon.version, scope.version),
        inArray(lexicon.lemma, [...lemmas]),
      ),
    );
}

/** One more lookup served from this entry. */
export async function countHit(db: Executor, scope: LexiconScope, lemma: string): Promise<void> {
  await db
    .update(lexicon)
    .set({ hits: sql`${lexicon.hits} + 1` })
    .where(
      and(eq(lexicon.lang, scope.lang), eq(lexicon.explainLang, scope.explainLang), eq(lexicon.version, scope.version), eq(lexicon.lemma, lemma)),
    );
}

/**
 * Store a generated entry under its lemma key. Concurrent misses for the same
 * key store one row (ON CONFLICT DO NOTHING). True when this call stored it.
 */
export async function storeLexicon(
  db: Executor,
  row: LexiconScope & { lemma: string; content: Record<string, unknown>; model: string },
): Promise<boolean> {
  const stored = await db.insert(lexicon).values(row).onConflictDoNothing().returning({ lemma: lexicon.lemma });
  return stored.length > 0;
}

/**
 * Which daily AI limit is already used up, without counting anything (null:
 * neither). The same conditions as consumeDailyQuota's upsert, so a request
 * that cannot reach the model is told about an exhausted quota first.
 */
export async function exhaustedQuota(
  db: Executor,
  { userId, day, limit, tokenLimit }: { userId: string; day: string; limit: number; tokenLimit: number },
): Promise<QuotaKind | null> {
  const [row] = await db
    .select({ requests: aiUsage.requests, tokens: aiUsage.tokens })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), eq(aiUsage.day, day)));
  if (!row) return null;
  if (row.requests >= limit) return 'requests';
  return row.tokens >= tokenLimit ? 'tokens' : null;
}
