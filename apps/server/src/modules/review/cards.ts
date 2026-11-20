import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database, Executor } from '../../db/client.ts';
import { cards, items, reviewLogs } from '../../db/schema.ts';
import { replayCard, stateName, toSchedule, type CardStateName, type RatingValue, type ReplayLog } from './fsrs.ts';

/**
 * Card state persistence. Every write takes the card rows' locks first (in id
 * order, so concurrent batches never deadlock) and re-derives the card from
 * all of its logs, so the stored columns always equal the replay.
 */

/** A card's scheduling state as review responses show it. */
export interface CardStateView {
  id: string;
  state: CardStateName;
  due: string;
  mastered: boolean;
}

/** One validated rating from a client. */
export interface IncomingLog {
  id: string;
  cardId: string;
  rating: RatingValue;
  reviewedAt: Date;
  durationMs: number | null;
}

export interface PushRejection {
  id: string | null;
  errors: string[];
}

interface LockedCard {
  id: string;
  createdAt: Date;
}

/** Lock the account's cards among `ids` (id order). Missing or foreign ids are simply absent. */
async function lockCards(tx: Executor, userId: string, ids: readonly string[]): Promise<Map<string, LockedCard>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: cards.id, createdAt: cards.createdAt })
    .from(cards)
    .where(and(eq(cards.userId, userId), inArray(cards.id, [...ids])))
    .orderBy(asc(cards.id))
    .for('update');
  return new Map(rows.map((row) => [row.id, row]));
}

/** Every log of the given cards, grouped by card. */
export async function logsOfCards(db: Executor, userId: string, cardIds: readonly string[]): Promise<Map<string, ReplayLog[]>> {
  const grouped = new Map<string, ReplayLog[]>(cardIds.map((id) => [id, []]));
  if (cardIds.length === 0) return grouped;
  const rows = await db
    .select({ id: reviewLogs.id, cardId: reviewLogs.cardId, rating: reviewLogs.rating, reviewedAt: reviewLogs.reviewedAt })
    .from(reviewLogs)
    .where(and(eq(reviewLogs.userId, userId), inArray(reviewLogs.cardId, [...cardIds])));
  for (const row of rows) {
    grouped.get(row.cardId)?.push({ id: row.id, rating: row.rating as RatingValue, reviewedAt: row.reviewedAt });
  }
  return grouped;
}

/** Replay each locked card from its logs and store the result. */
async function replayAndStore(
  tx: Executor,
  userId: string,
  locked: ReadonlyMap<string, LockedCard>,
  masteredDays: number,
): Promise<CardStateView[]> {
  const ids = [...locked.keys()];
  const logs = await logsOfCards(tx, userId, ids);
  const views: CardStateView[] = [];
  for (const id of ids) {
    const card = locked.get(id)!;
    const schedule = toSchedule(replayCard(card.createdAt, logs.get(id) ?? []), masteredDays);
    await tx
      .update(cards)
      .set(schedule)
      .where(and(eq(cards.userId, userId), eq(cards.id, id)));
    views.push({ id, state: stateName(schedule.state), due: schedule.due.toISOString(), mastered: schedule.mastered });
  }
  return views;
}

/**
 * Store a batch of ratings idempotently (by log id) and return the new state
 * of every card they touch. A log whose id is already stored is accepted as
 * is; one for an unknown or another account's card is rejected.
 */
export async function pushReviewLogs(
  db: Database,
  { userId, deviceId, logs, now, masteredDays }: { userId: string; deviceId: string; logs: readonly IncomingLog[]; now: Date; masteredDays: number },
): Promise<{ accepted: string[]; rejected: PushRejection[]; cards: CardStateView[]; inserted: number }> {
  const unique = [...new Map(logs.map((log) => [log.id, log])).values()];
  if (unique.length === 0) return { accepted: [], rejected: [], cards: [], inserted: 0 };

  return db.transaction(async (tx) => {
    const stored = await tx
      .select({ id: reviewLogs.id, cardId: reviewLogs.cardId })
      .from(reviewLogs)
      .where(and(eq(reviewLogs.userId, userId), inArray(reviewLogs.id, unique.map((log) => log.id))));
    const storedCardOf = new Map(stored.map((row) => [row.id, row.cardId]));
    const fresh = unique.filter((log) => !storedCardOf.has(log.id));

    const cardIds = [...new Set([...fresh.map((log) => log.cardId), ...storedCardOf.values()])].sort();
    const locked = await lockCards(tx, userId, cardIds);

    const insertable = fresh.filter((log) => locked.has(log.cardId));
    const rejected: PushRejection[] = fresh
      .filter((log) => !locked.has(log.cardId))
      .map((log) => ({ id: log.id, errors: ['unknown card'] }));
    const inserted = insertable.length === 0
      ? []
      : await tx
          .insert(reviewLogs)
          .values(insertable.map((log) => ({
            userId,
            id: log.id,
            cardId: log.cardId,
            rating: log.rating,
            reviewedAt: log.reviewedAt,
            durationMs: log.durationMs,
            deviceId,
            createdAt: now,
          })))
          .onConflictDoNothing()
          .returning({ id: reviewLogs.id });

    const accepted = unique.filter((log) => storedCardOf.has(log.id) || locked.has(log.cardId)).map((log) => log.id);
    // Every locked card is touched: it is the card of a stored or a newly inserted log.
    const views = await replayAndStore(tx, userId, locked, masteredDays);
    return { accepted, rejected, cards: views, inserted: inserted.length };
  });
}

export type UndoOutcome =
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'undone'; card: CardStateView };

/** Delete one rating within `windowMs` of the server accepting it and re-derive its card. */
export async function undoReviewLog(
  db: Database,
  { userId, logId, now, windowMs, masteredDays }: { userId: string; logId: string; now: Date; windowMs: number; masteredDays: number },
): Promise<UndoOutcome> {
  return db.transaction(async (tx) => {
    const [log] = await tx
      .select({ cardId: reviewLogs.cardId, createdAt: reviewLogs.createdAt })
      .from(reviewLogs)
      .where(and(eq(reviewLogs.userId, userId), eq(reviewLogs.id, logId)));
    if (!log) return { kind: 'not_found' };
    if (now.getTime() - log.createdAt.getTime() > windowMs) return { kind: 'expired' };

    const locked = await lockCards(tx, userId, [log.cardId]);
    const deleted = await tx
      .delete(reviewLogs)
      .where(and(eq(reviewLogs.userId, userId), eq(reviewLogs.id, logId)))
      .returning({ id: reviewLogs.id });
    // A concurrent undo of the same log won; or the card is gone.
    if (deleted.length === 0 || !locked.has(log.cardId)) return { kind: 'not_found' };
    const [card] = await replayAndStore(tx, userId, locked, masteredDays);
    return card ? { kind: 'undone', card } : { kind: 'not_found' };
  });
}

/**
 * "内容有误": suspend every card of the reported card's item and mark the
 * item `needs_regen`. Null when the card is unknown or another account's.
 */
export async function suspendItemOfCard(db: Database, { userId, cardId, now }: { userId: string; cardId: string; now: Date }): Promise<{ itemId: string } | null> {
  return db.transaction(async (tx) => {
    const [card] = await tx
      .select({ itemId: cards.itemId })
      .from(cards)
      .where(and(eq(cards.userId, userId), eq(cards.id, cardId)));
    if (!card) return null;
    // Lock the item's cards in id order first, as rating pushes do, so the two never deadlock.
    const siblings = await tx
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.userId, userId), eq(cards.itemId, card.itemId)))
      .orderBy(asc(cards.id))
      .for('update');
    await tx
      .update(cards)
      .set({ suspended: true })
      .where(and(eq(cards.userId, userId), inArray(cards.id, siblings.map((row) => row.id))));
    await tx
      .update(items)
      .set({ status: 'needs_regen', updatedAt: now })
      .where(and(eq(items.userId, userId), eq(items.id, card.itemId)));
    return { itemId: card.itemId };
  });
}
