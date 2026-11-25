import { and, asc, desc, eq, gte, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../../db/client.ts';
import { cards, items } from '../../db/schema.ts';
import { currentStreak } from './activity.ts';
import { localDayAt, type LocalDay } from './common.ts';
import { logsOfCards } from './cards.ts';
import { previewIntervals, replayCard, retentionFor, stateName, STATE_NEW, STATE_REVIEW, type CardStateName, type Intervals } from './fsrs.ts';
import { importanceReviewOf } from './retention.ts';

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
  itemType: 'word' | 'phrase' | 'grammar' | 'sentence';
  cardType: string;
  front: Record<string, unknown>;
  back: Record<string, unknown>;
  state: CardStateName;
  intervals: Intervals;
}

/**
 * Which cards a session reviews (docs/api-v1.md, "v3 → Review scope"): every
 * card, the cards of notebook items (stars ≥ 1) or of 3 ★+ items.
 */
export const REVIEW_SCOPES = ['all', 'notes', 'stars3'] as const;
export type ReviewScope = (typeof REVIEW_SCOPES)[number];
export const SCOPE_MIN_STARS: Readonly<Record<ReviewScope, number>> = { all: 0, notes: 1, stars3: 3 };

export type DueByScope = Record<ReviewScope, number>;

export interface ReviewSummary {
  due: number;
  newAvailable: number;
  reviewDue: number;
  doneToday: number;
  estimatedMinutes: number;
  streakDays: number;
  /** v3: `due` per scope, each with the same daily limits (`all` = `due`). */
  dueByScope: DueByScope;
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

/** The scope's filter on the card's item (none for `all`). */
function scopePredicate(scope: ReviewScope): SQL | undefined {
  const minStars = SCOPE_MIN_STARS[scope];
  return minStars > 0 ? gte(items.stars, minStars) : undefined;
}

type Available = { fresh: number; review: number };

/** Due new and non-new cards per scope, in one pass. */
async function countAvailable(db: Executor, userId: string, now: Date, day: LocalDay): Promise<Record<ReviewScope, Available>> {
  const isNew = sql`${cards.state} = ${STATE_NEW}`;
  const counter = (scope: ReviewScope, fresh: boolean) =>
    sql<number>`(count(*) filter (where ${fresh ? isNew : sql`not ${isNew}`} and ${items.stars} >= ${SCOPE_MIN_STARS[scope]}))::int`;
  const [row] = await db
    .select({
      allFresh: counter('all', true),
      allReview: counter('all', false),
      notesFresh: counter('notes', true),
      notesReview: counter('notes', false),
      stars3Fresh: counter('stars3', true),
      stars3Review: counter('stars3', false),
    })
    .from(cards)
    .innerJoin(items, itemOfCard)
    .where(duePredicate(userId, now, day));
  return {
    all: { fresh: row?.allFresh ?? 0, review: row?.allReview ?? 0 },
    notes: { fresh: row?.notesFresh ?? 0, review: row?.notesReview ?? 0 },
    stars3: { fresh: row?.stars3Fresh ?? 0, review: row?.stars3Review ?? 0 },
  };
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
  const dueOf = ({ fresh, review }: Available): number => Math.min(fresh, newLeft) + Math.min(review, reviewsLeft);
  const newAvailable = Math.min(available.all.fresh, newLeft);
  const reviewDue = Math.min(available.all.review, reviewsLeft);
  const due = newAvailable + reviewDue;
  return {
    due,
    newAvailable,
    reviewDue,
    doneToday: counts.done,
    estimatedMinutes: Math.ceil((due * SECONDS_PER_CARD) / 60),
    streakDays: await currentStreak(db, userId, day.date, utcOffsetMinutes),
    dueByScope: { all: due, notes: dueOf(available.notes), stars3: dueOf(available.stars3) },
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
  stars: items.stars,
};

/**
 * Due non-new cards first (oldest due first), then new cards by their item's
 * stars (desc), then item weight (`errorCount × 2 + lookupCount`, desc),
 * within today's limits and `limit` (docs/api-v1.md, "Review by importance").
 * `scope` (v3) filters due and new cards alike. Intervals are previewed with
 * each card's own retention.
 */
export async function reviewQueue(
  db: Executor,
  {
    userId,
    now,
    utcOffsetMinutes,
    limits,
    limit,
    scope = 'all',
  }: { userId: string; now: Date; utcOffsetMinutes: number; limits: ReviewLimits; limit: number; scope?: ReviewScope },
): Promise<QueueCard[]> {
  const { day, newLeft, reviewsLeft } = await allowance(db, userId, now, utcOffsetMinutes, limits);
  const due = and(duePredicate(userId, now, day), scopePredicate(scope));
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
        .orderBy(
          desc(items.stars),
          desc(sql`${items.errorCount} * 2 + ${items.lookupCount}`),
          desc(items.lastSeenAt),
          asc(cards.itemId),
          asc(cards.id),
        )
        .limit(newCount);

  const rows = [...reviewRows, ...newRows];
  if (rows.length === 0) return [];
  const logs = await logsOfCards(db, userId, rows.map((row) => row.id));
  const importanceReview = await importanceReviewOf(db, userId);
  return rows.map((row) => {
    const retention = retentionFor(row.stars, importanceReview);
    const card = replayCard(row.createdAt, logs.get(row.id) ?? [], retention);
    return {
      id: row.id,
      itemId: row.itemId,
      itemType: row.itemType,
      cardType: row.cardType,
      front: row.front,
      back: row.back,
      state: stateName(card.state),
      intervals: previewIntervals(card, now, retention),
    };
  });
}
