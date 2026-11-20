/**
 * The review session as a pure state machine. The page dispatches events
 * (flip, rate, undo, report, hide/show) and renders the state; the services
 * post the logs that `rate` returns.
 *
 *   reviewing ──rate last card──▶ done
 *       ▲                          │
 *       └──────── undo ◀───────────┘   (within the undo window)
 *
 * The current card is `queue[0]`. A rating moves it to `rated` and returns
 * the log to post; undo puts the most recent one back, flipped, so it can be
 * rated again. Reporting a card ("内容有误") drops every remaining card of
 * its item, since the server suspends them all.
 */
import type { Intervals, QueueCard, Rating, ReviewLog } from './review-types'

/** A card left open longer than this counts as this long (the user walked away). */
export const MAX_CARD_MS = 120_000
/** How long the 撤销 strip stays after a rating. */
export const UNDO_WINDOW_MS = 5_000

export interface RatedCard {
  readonly card: QueueCard
  readonly logId: string
  readonly rating: Rating
  /** Epoch ms. */
  readonly reviewedAt: number
  readonly durationMs: number
}

export interface PendingUndo {
  readonly logId: string
  readonly rating: Rating
  /** Epoch ms after which the strip disappears. */
  readonly until: number
}

export type SessionPhase = 'reviewing' | 'done'

export interface SessionState {
  readonly phase: SessionPhase
  /** Cards still to review; the current one is first. */
  readonly queue: readonly QueueCard[]
  readonly flipped: boolean
  /** When the current card was shown (epoch ms), shifted by time spent hidden. */
  readonly shownAt: number
  /** Set while the page is hidden. */
  readonly pausedAt: number | null
  readonly rated: readonly RatedCard[]
  readonly undo: PendingUndo | null
  /** Cards removed by a report. */
  readonly dropped: number
}

export function startSession(cards: readonly QueueCard[], now: number): SessionState {
  const seen = new Set<string>()
  const queue = cards.filter((card) => {
    if (seen.has(card.id)) return false
    seen.add(card.id)
    return true
  })
  return {
    phase: queue.length === 0 ? 'done' : 'reviewing',
    queue,
    flipped: false,
    shownAt: now,
    pausedAt: null,
    rated: [],
    undo: null,
    dropped: 0,
  }
}

export function currentCard(state: SessionState): QueueCard | null {
  return state.phase === 'reviewing' ? (state.queue[0] ?? null) : null
}

export function flip(state: SessionState): SessionState {
  if (currentCard(state) === null || state.flipped) return state
  return { ...state, flipped: true }
}

export interface RateResult {
  readonly state: SessionState
  readonly log: ReviewLog
}

/** Rates the current card; null unless a card is showing its back. */
export function rate(state: SessionState, rating: Rating, logId: string, now: number): RateResult | null {
  const card = currentCard(state)
  if (card === null || !state.flipped || state.pausedAt !== null) return null
  const durationMs = Math.round(Math.min(MAX_CARD_MS, Math.max(0, now - state.shownAt)))
  const queue = state.queue.slice(1)
  const next: SessionState = {
    ...state,
    phase: queue.length === 0 ? 'done' : 'reviewing',
    queue,
    flipped: false,
    shownAt: now,
    rated: [...state.rated, { card, logId, rating, reviewedAt: now, durationMs }],
    undo: { logId, rating, until: now + UNDO_WINDOW_MS },
  }
  const log: ReviewLog = { id: logId, cardId: card.id, rating, reviewedAt: new Date(now).toISOString(), durationMs }
  return { state: next, log }
}

/**
 * Puts the most recently rated card back in front, showing its back, after
 * its log was withdrawn. Only the rating the 撤销 strip offers can be undone.
 */
export function undoRating(state: SessionState, logId: string, now: number): SessionState {
  const last = state.rated[state.rated.length - 1]
  if (state.undo === null || state.undo.logId !== logId || last === undefined || last.logId !== logId) return state
  return {
    ...state,
    phase: 'reviewing',
    queue: [last.card, ...state.queue],
    flipped: true,
    // The time already spent on it still counts when it is rated again.
    shownAt: now - last.durationMs,
    pausedAt: null,
    rated: state.rated.slice(0, -1),
    undo: null,
  }
}

/** The 撤销 strip timed out (no-op if another rating replaced it). */
export function expireUndo(state: SessionState, logId: string): SessionState {
  return state.undo !== null && state.undo.logId === logId ? { ...state, undo: null } : state
}

/** Drops every remaining card of a reported item. */
export function dropItem(state: SessionState, itemId: string, now: number): SessionState {
  const queue = state.queue.filter((card) => card.itemId !== itemId)
  const removed = state.queue.length - queue.length
  if (removed === 0) return state
  const currentGone = state.queue[0]?.itemId === itemId
  const last = state.rated[state.rated.length - 1]
  const undoGone = state.undo !== null && last !== undefined && last.card.itemId === itemId
  return {
    ...state,
    phase: queue.length === 0 ? 'done' : state.phase,
    queue,
    flipped: currentGone ? false : state.flipped,
    shownAt: currentGone ? now : state.shownAt,
    undo: undoGone ? null : state.undo,
    dropped: state.dropped + removed,
  }
}

/** The page went to the background: stop the card's clock. */
export function pause(state: SessionState, now: number): SessionState {
  return state.pausedAt === null ? { ...state, pausedAt: now } : state
}

/** Back in the foreground: time spent hidden does not count. */
export function resume(state: SessionState, now: number): SessionState {
  if (state.pausedAt === null) return state
  return { ...state, shownAt: state.shownAt + Math.max(0, now - state.pausedAt), pausedAt: null }
}

export interface SessionProgress {
  /** 1-based number of the current card (rated + 1), capped at total. */
  readonly position: number
  readonly total: number
  /** Share of the session done, [0, 1]. */
  readonly share: number
}

export function progress(state: SessionState): SessionProgress {
  const total = state.rated.length + state.queue.length
  const position = Math.min(total, state.rated.length + 1)
  return { position, total, share: total === 0 ? 1 : state.rated.length / total }
}

export interface SessionStats {
  readonly reviewed: number
  readonly durationMs: number
  /** Ratings ≥ 2 (困难, 记得, 简单): the same measure as the weekly retention. */
  readonly remembered: number
  /** Cards of this session due again before `dueBefore`. */
  readonly dueAgain: number
}

const intervalSeconds = (intervals: Intervals, rating: Rating): number => {
  const value = intervals[String(rating) as keyof Intervals]
  return Number.isFinite(value) ? value : 0
}

/** End-of-session numbers; `dueBefore` is usually the end of tomorrow (epoch ms). */
export function sessionStats(state: SessionState, dueBefore: number): SessionStats {
  return {
    reviewed: state.rated.length,
    durationMs: state.rated.reduce((sum, entry) => sum + entry.durationMs, 0),
    remembered: state.rated.filter((entry) => entry.rating >= 2).length,
    dueAgain: state.rated.filter(
      (entry) => entry.reviewedAt + intervalSeconds(entry.card.intervals, entry.rating) * 1000 < dueBefore,
    ).length,
  }
}
