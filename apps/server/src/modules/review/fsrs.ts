import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type FSRS, type FSRSParameters, type Grade } from 'ts-fsrs';

/**
 * FSRS scheduling (docs/api-v1.md, "Scheduling (FSRS)" and "Review by
 * importance").
 *
 * A card's state is never edited in place: it is the replay of its review
 * logs in (reviewed_at, id) order, starting from an empty card. With fuzz off
 * FSRS is deterministic, so two devices reviewing offline both count and the
 * result does not depend on which push arrived first.
 *
 * The replay uses the retention of the card's item as it is now (from its
 * stars), so changing a note's stars re-derives the schedule from the same
 * logs: the intervals change, the progress (reps, lapses, stability) is kept.
 */

/** Target retention when importance is ignored (settings.importanceReview = false), and of the v1 contract. */
export const DEFAULT_RETENTION = 0.9;

/** Target retention by `items.stars` (0 = not saved as a note, 1–4 stars). */
export const RETENTION_BY_STARS: readonly number[] = [0.85, 0.9, 0.92, 0.94, 0.95];

/** The parameters every scheduler shares; only `request_retention` differs. */
export function fsrsParameters(retention: number): FSRSParameters {
  return generatorParameters({ request_retention: retention, maximum_interval: 36_500, enable_fuzz: false });
}

/** The v1 parameters (retention 0.9), kept for reference and tests. */
export const FSRS_PARAMETERS = fsrsParameters(DEFAULT_RETENTION);

/**
 * A card's retention from its item's stars. Stars outside 0–4 are clamped;
 * with `importanceReview` off every card uses DEFAULT_RETENTION.
 */
export function retentionFor(stars: number, importanceReview: boolean): number {
  if (!importanceReview) return DEFAULT_RETENTION;
  const index = Math.min(RETENTION_BY_STARS.length - 1, Math.max(0, Math.trunc(stars)));
  return RETENTION_BY_STARS[index] ?? DEFAULT_RETENTION;
}

/** One scheduler per retention (at most one per RETENTION_BY_STARS value plus the default in practice). */
const schedulers = new Map<number, FSRS>();

export function schedulerFor(retention: number): FSRS {
  const cached = schedulers.get(retention);
  if (cached) return cached;
  const scheduler = fsrs(fsrsParameters(retention));
  schedulers.set(retention, scheduler);
  return scheduler;
}

/** 1 忘记 (Again), 2 困难 (Hard), 3 记得 (Good), 4 简单 (Easy). */
export type RatingValue = 1 | 2 | 3 | 4;
export const RATING_VALUES: readonly RatingValue[] = [1, 2, 3, 4];
const GRADES: Readonly<Record<RatingValue, Grade>> = { 1: Rating.Again, 2: Rating.Hard, 3: Rating.Good, 4: Rating.Easy };

export type CardStateName = 'new' | 'learning' | 'review' | 'relearning';
/** `cards.state`: 0 new, 1 learning, 2 review, 3 relearning (the FSRS State values). */
export const CARD_STATE_NAMES: readonly CardStateName[] = ['new', 'learning', 'review', 'relearning'];
export const STATE_NEW = 0;
export const STATE_REVIEW = 2;

export function stateName(state: number): CardStateName {
  return CARD_STATE_NAMES[state] ?? 'new';
}

export interface ReplayLog {
  id: string;
  rating: RatingValue;
  reviewedAt: Date;
}

/** Replay order: reviewed_at, then id (ULIDs) for logs made in the same millisecond. */
export function compareReplayOrder(a: ReplayLog, b: ReplayLog): number {
  const byTime = a.reviewedAt.getTime() - b.reviewedAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The FSRS card after replaying `logs` (any order) on an empty card created
 * at `createdAt`, scheduled for `retention` (the card's current one).
 */
export function replayCard(createdAt: Date, logs: readonly ReplayLog[], retention: number): Card {
  const scheduler = schedulerFor(retention);
  return [...logs]
    .sort(compareReplayOrder)
    .reduce<Card>((card, log) => scheduler.next(card, log.reviewedAt, GRADES[log.rating]).card, createEmptyCard(createdAt));
}

/** Seconds until the card would be due if rated 1…4 at `now`. */
export interface Intervals {
  '1': number;
  '2': number;
  '3': number;
  '4': number;
}

export function previewIntervals(card: Card, now: Date, retention: number): Intervals {
  const preview = schedulerFor(retention).repeat(card, now);
  const seconds = (rating: RatingValue): number =>
    Math.max(0, Math.round((preview[GRADES[rating]].card.due.getTime() - now.getTime()) / 1000));
  return { '1': seconds(1), '2': seconds(2), '3': seconds(3), '4': seconds(4) };
}

/** The scheduling columns of `cards` for a replayed FSRS card. */
export interface CardSchedule {
  state: number;
  due: Date;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  lastReview: Date | null;
  mastered: boolean;
}

/**
 * `mastered` = the last scheduled interval exceeds `masteredDays`
 * (MASTERED_DAYS): the card leaves the queue as "已掌握".
 */
export function toSchedule(card: Card, masteredDays: number): CardSchedule {
  return {
    state: card.state,
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: Math.round(card.elapsed_days),
    scheduledDays: Math.round(card.scheduled_days),
    reps: card.reps,
    lapses: card.lapses,
    lastReview: card.last_review ?? null,
    mastered: card.scheduled_days > masteredDays,
  };
}
