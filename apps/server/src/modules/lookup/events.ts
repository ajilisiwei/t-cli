import type { FastifyBaseLogger } from 'fastify';
import { and, eq, gt, sql } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import type { Database } from '../../db/client.ts';
import { lookupEvents } from '../../db/schema.ts';
import { loggableError } from '../../http/errors.ts';
import type { ExplanationLang } from '../pipeline/schemas.ts';

/**
 * Lookup events (docs/api-v1.md, "v3 → Lookup events"): after a `200` of
 * `POST /v1/lookup`, one row `{ lemmaKey, explainLang, createdAt }` for the
 * caller — never the sentence or the record id — at most one per account and
 * lemma key per 10 minutes. Recorded in the background: the answer is
 * already decided, so recording neither delays nor changes it, and a failure
 * is only logged (without user text).
 */

/** At most one event per account and lemma key within this window. */
export const LOOKUP_EVENT_DEDUPE_MS = 10 * 60_000;

export interface LookupEventInput {
  userId: string;
  /** The lexicon key of the answer's lemma. */
  lemmaKey: string;
  explainLang: ExplanationLang;
  now: Date;
}

/**
 * Store one event unless the account already has one for the key within the
 * window. A transaction-scoped advisory lock per (account, key) serializes
 * concurrent lookups of the same word, so two never both pass the check.
 * True when an event was stored.
 */
export async function recordLookupEvent(db: Database, { userId, lemmaKey, explainLang, now }: LookupEventInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tcli-lookup-event:${userId}:${lemmaKey}`}))`);
    const since = new Date(now.getTime() - LOOKUP_EVENT_DEDUPE_MS);
    const [recent] = await tx
      .select({ id: lookupEvents.id })
      .from(lookupEvents)
      .where(and(eq(lookupEvents.userId, userId), eq(lookupEvents.lemmaKey, lemmaKey), gt(lookupEvents.createdAt, since)))
      .limit(1);
    if (recent) return false;
    await tx.insert(lookupEvents).values({ userId, id: ulid({ time: now.getTime() }), lemmaKey, explainLang, createdAt: now });
    return true;
  });
}

export interface LookupEventRecorder {
  /** Start recording; returns at once. Failures are logged by id and error class only. */
  record(input: LookupEventInput, log: FastifyBaseLogger): void;
  /** Resolves when every recording started so far has finished (the app's onClose waits for it). */
  settle(): Promise<void>;
}

export function createLookupEventRecorder(db: Database): LookupEventRecorder {
  const pending = new Set<Promise<void>>();
  return {
    record(input, log) {
      const task: Promise<void> = recordLookupEvent(db, input)
        .then(
          (recorded) => log.debug({ userId: input.userId, recorded }, 'lookup event'),
          (error: unknown) => log.error({ userId: input.userId, ...loggableError(error) }, 'recording a lookup event failed'),
        )
        .finally(() => pending.delete(task));
      pending.add(task);
    },
    async settle() {
      await Promise.allSettled([...pending]);
    },
  };
}
