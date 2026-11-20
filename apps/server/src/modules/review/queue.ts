import { and, asc, desc, eq, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { cards, items } from '../../db/schema.ts';
import { currentStreak } from './activity.ts';
import { localDayAt, type LocalDay } from './common.ts';
import { logsOfCards } from './cards.ts';
import { previewIntervals, replayCard, stateName, STATE_NEW, STATE_REVIEW, type CardStateName, type Intervals } from './fsrs.ts';

/**
 * What the review queue serves now (docs/api-v1.md, "Review").
 *
 * A card is due when its due time has passed; a card in the review state is
 * due for the whole local day it falls on (as Anki does), so a daily session
 * does not miss cards that come due a few hours later the same day.
 * Suspended and mastered cards never are.
 *
 * Daily limits (D10), per local day: at most `newPerDay` cards introduced (a
 * card is introduced by its first log) and at most `reviewsPerDay` ratings of
 * cards that were not new any more.
 */

/** Seconds a card takes on average, for `estimatedMinutes`. */
export const SECONDS_PER_CARD = 8;

export interface ReviewLimits {
  newPerDay: number;
  reviewsPerDay: number;
}

export interface QueueCard {
  id: string;
  itemId: string;
  itemType: 'word' | 'phrase' | 'grammar';
  cardType: string;
  front: Record<string, unknown>;
  back: Record<string, unknown>;
  state: CardStateName;
  intervals: Intervals;
}

export interface ReviewSummary {
  due: number;
  newAvailable: number;
  reviewDue: number;
  doneToday: number;
  estimatedMinutes: number;
  streakDays: number;
}

interface DayCounts {
  /** Cards whose first log falls on the day. */
  introduced: number;
  /** Logs on the day that were not their card's first. */
  reviewed: number;
  /** All logs on the day. */
  done: number;
}

/** Today's ratings, split by whether they introduced their card. */
async function countDay(db: Executor, userId: string, day: LocalDay): Promise<DayCounts> {
  const [row] = await db.execute<{ introduced: number; reviewed: number; done: number }>(sql`
    select count(*) filter (where p.first)::int as introduced,
           count(*) filter (where not p.first)::int as reviewed,
           count(*)::int as done
    from (
      select not exists (
        select 1 from review_logs e
        where e.user_id = l.user_id and e.card_id = l.card_id
          and (e.reviewed_at, e.id) < (l.reviewed_at, l.id)
      ) as first
      from review_logs l
      where l.user_id = ${userId}
        and l.reviewed_at >= ${day.start.toISOString()}::timestamptz
        and l.reviewed_at < ${day.end.toISOString()}::timestamptz
    ) p`);
  return { introduced: row?.introduced ?? 0, reviewed: row?.reviewed ?? 0, done: row?.done ?? 0 };
}

function duePredicate(userId: string, now: Date, day: LocalDay): SQL {
  return and(
    eq(cards.userId, userId),
    eq(cards.suspended, false),
    eq(cards.mastered, false),
    or(lte(cards.due, now), and(eq(cards.state, STATE_REVIEW), lt(cards.due, day.end))),
  )!;
}

const itemOfCard = and(eq(items.userId, cards.userId), eq(items.id, cards.itemId));

async function countAvailable(db: Executor, userId: string, now: Date, day: LocalDay): Promise<{ fresh: number; review: number }> {
  const [row] = await db
    .select({
      fresh: sql<number>`(count(*) filter (where ${cards.state} = ${STATE_NEW}))::int`,
      review: sql<number>`(count(*) filter (where ${cards.state} <> ${STATE_NEW}))::int`,
    })
    .from(cards)
    .innerJoin(items, itemOfCard)
    .where(duePredicate(userId, now, day));
  return { fresh: row?.fresh ?? 0, review: row?.review ?? 0 };
}

/** How many cards of each kind the queue may still serve today. */
interface Allowance {
  day: LocalDay;
  counts: DayCounts;
  newLeft: number;
  reviewsLeft: number;
}

async function allowance(db: Executor, userId: string, now: Date, utcOffsetMinutes: number, limits: ReviewLimits): Promise<Allowance> {
  const day = localDayAt(now, utcOffsetMinutes);
  const counts = await countDay(db, userId, day);
  return {
    day,
    counts,
    newLeft: Math.max(0, limits.newPerDay - counts.introduced),
    reviewsLeft: Math.max(0, limits.reviewsPerDay - counts.reviewed),
  };
}

export async function reviewSummary(
  db: Executor,
  { userId, now, utcOffsetMinutes, limits }: { userId: string; now: Date; utcOffsetMinutes: number; limits: ReviewLimits },
): Promise<ReviewSummary> {
  const { day, counts, newLeft, reviewsLeft } = await allowance(db, userId, now, utcOffsetMinutes, limits);
  const available = await countAvailable(db, userId, now, day);
  const newAvailable = Math.min(available.fresh, newLeft);
  const reviewDue = Math.min(available.review, reviewsLeft);
  const due = newAvailable + reviewDue;
  return {
    due,
    newAvailable,
    reviewDue,
    doneToday: counts.done,
    estimatedMinutes: Math.ceil((due * SECONDS_PER_CARD) / 60),
    streakDays: await currentStreak(db, userId, day.date, utcOffsetMinutes),
  };
}

const queueColumns = {
  id: cards.id,
  itemId: cards.itemId,
  itemType: items.type,
  cardType: cards.cardType,
  front: cards.front,
  back: cards.back,
  createdAt: cards.createdAt,
};

/**
 * Due non-new cards first (oldest due first), then new cards by item weight
 * (`errorCount × 2 + lookupCount`, desc), within today's limits and `limit`.
 */
export async function reviewQueue(
  db: Executor,
  { userId, now, utcOffsetMinutes, limits, limit }: { userId: string; now: Date; utcOffsetMinutes: number; limits: ReviewLimits; limit: number },
): Promise<QueueCard[]> {
  const { day, newLeft, reviewsLeft } = await allowance(db, userId, now, utcOffsetMinutes, limits);
  const due = duePredicate(userId, now, day);
  const reviewCount = Math.min(reviewsLeft, limit);
  const reviewRows = reviewCount === 0
    ? []
    : await db
        .select(queueColumns)
        .from(cards)
        .innerJoin(items, itemOfCard)
        .where(and(due, ne(cards.state, STATE_NEW)))
        .orderBy(asc(cards.due), asc(cards.id))
        .limit(reviewCount);
  const newCount = Math.min(newLeft, limit - reviewRows.length);
  const newRows = newCount === 0
    ? []
    : await db
        .select(queueColumns)
        .from(cards)
        .innerJoin(items, itemOfCard)
        .where(and(due, eq(cards.state, STATE_NEW)))
        .orderBy(desc(sql`${items.errorCount} * 2 + ${items.lookupCount}`), desc(items.lastSeenAt), asc(cards.itemId), asc(cards.id))
        .limit(newCount);

  const rows = [...reviewRows, ...newRows];
  const logs = await logsOfCards(db, userId, rows.map((row) => row.id));
  return rows.map((row) => {
    const card = replayCard(row.createdAt, logs.get(row.id) ?? []);
    return {
      id: row.id,
      itemId: row.itemId,
      itemType: row.itemType,
      cardType: row.cardType,
      front: row.front,
      back: row.back,
      state: stateName(card.state),
      intervals: previewIntervals(card, now),
    };
  });
}
