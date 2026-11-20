/**
 * The outbox of review logs. Every rating is queued in storage first and
 * posted right away; a failed post leaves it queued until the next flush
 * (next rating, next session, app back in the foreground). Log ids are
 * client ULIDs and `POST /v1/reviews` is idempotent by id, so posting a log
 * twice never counts twice.
 */
import type { Rating, ReviewBatchResult, ReviewLog } from './review-types'

/** Most logs one `POST /v1/reviews` takes. */
export const MAX_BATCH = 200
/** Storage bound (≈150 bytes per log, far below the 1 MB per key). */
export const MAX_PENDING = 2000

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRating = (value: unknown): value is Rating => value === 1 || value === 2 || value === 3 || value === 4

/** A log as the contract accepts it, or null. */
export function readLog(value: unknown): ReviewLog | null {
  if (!isRecord(value)) return null
  const { id, cardId, rating, reviewedAt, durationMs } = value
  if (typeof id !== 'string' || !ULID_RE.test(id)) return null
  if (typeof cardId !== 'string' || cardId === '') return null
  if (!isRating(rating)) return null
  if (typeof reviewedAt !== 'string' || !ISO_RE.test(reviewedAt) || Number.isNaN(Date.parse(reviewedAt))) return null
  const log: ReviewLog = { id, cardId, rating, reviewedAt }
  return typeof durationMs === 'number' && Number.isInteger(durationMs) && durationMs >= 0
    ? { ...log, durationMs }
    : log
}

/** The stored queue; anything unreadable is dropped. */
export function readQueue(value: unknown): ReviewLog[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const logs: ReviewLog[] = []
  for (const entry of value) {
    const log = readLog(entry)
    if (log === null || seen.has(log.id)) continue
    seen.add(log.id)
    logs.push(log)
  }
  return logs
}

/**
 * Appends logs not queued yet. Past `max`, the oldest are dropped: a phone
 * offline for thousands of ratings loses the earliest rather than all.
 */
export function enqueue(queue: readonly ReviewLog[], logs: readonly ReviewLog[], max: number = MAX_PENDING): ReviewLog[] {
  const ids = new Set(queue.map((log) => log.id))
  const merged = [...queue, ...logs.filter((log) => !ids.has(log.id))]
  return merged.length > max ? merged.slice(merged.length - max) : merged
}

/** The next batch to post (oldest first). */
export function nextBatch(queue: readonly ReviewLog[], max: number = MAX_BATCH): ReviewLog[] {
  return queue.slice(0, Math.max(0, max))
}

/** The queue without the given ids. */
export function withoutIds(queue: readonly ReviewLog[], ids: Iterable<string>): ReviewLog[] {
  const drop = new Set(ids)
  return queue.filter((log) => !drop.has(log.id))
}

/**
 * What a failed post means for its batch: `drop` only when sending the same
 * batch again cannot succeed (400/413/422: the batch itself is invalid);
 * `keep` for everything else — offline, timeouts, rate limits, server
 * errors, and a 404 from a proxy or an older server, which must not lose
 * ratings.
 */
export type FailureAction = 'keep' | 'drop'

const HOPELESS_STATUSES: readonly number[] = [400, 413, 422]

export function failureAction(error: { readonly kind?: string; readonly status?: number | null }): FailureAction {
  const status = error.status ?? null
  return error.kind === 'http' && status !== null && HOPELESS_STATUSES.includes(status) ? 'drop' : 'keep'
}

/** Fields of an ApiError, read structurally (this module imports no values). */
interface ErrorFields {
  readonly kind?: string
  readonly status?: number | null
  readonly code?: string
}

const errorFields = (error: unknown): ErrorFields => {
  if (!isRecord(error)) return {}
  const { kind, status, code } = error
  return {
    ...(typeof kind === 'string' ? { kind } : {}),
    ...(typeof status === 'number' || status === null ? { status } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  }
}

export interface OutboxDeps {
  /** Reads the stored queue (validated here) and writes it back. */
  readonly load: () => unknown
  readonly save: (logs: readonly ReviewLog[]) => void
  /** `POST /v1/reviews`. */
  readonly post: (logs: readonly ReviewLog[]) => Promise<ReviewBatchResult>
  /** `DELETE /v1/reviews/:id`. */
  readonly remove: (logId: string) => Promise<void>
  readonly warn?: (message: string, detail?: unknown) => void
}

export type UndoOutcome = 'undone' | 'expired'

export interface Outbox {
  /** Queues a rating and starts posting it. */
  record(log: ReviewLog): void
  /** Posts queued ratings, single-flight. Resolves when the queue is empty or a post failed; never rejects. */
  flush(): Promise<void>
  /**
   * Withdraws a rating: removed locally while queued, otherwise deleted on
   * the server (a 404 means the server never kept it: undone just the same).
   * Rejects with the request's error when the server cannot be reached.
   */
  undo(logId: string): Promise<UndoOutcome>
  pending(): ReviewLog[]
}

export function createOutbox(deps: OutboxDeps): Outbox {
  const warn = deps.warn ?? ((): void => undefined)
  const pending = (): ReviewLog[] => readQueue(deps.load())
  let flushing: Promise<void> | null = null
  /** Ids of the batch being posted. */
  let inFlight: ReadonlySet<string> = new Set()

  const drain = async (): Promise<void> => {
    for (;;) {
      const batch = nextBatch(pending())
      if (batch.length === 0) return
      const ids = batch.map((log) => log.id)
      inFlight = new Set(ids)
      try {
        const result = await deps.post(batch)
        if (result.rejected.length > 0) warn('ratings rejected by the server', result.rejected.length)
        // Every log of an answered batch is settled: stored, or rejected for good.
        deps.save(withoutIds(pending(), ids))
      } catch (error: unknown) {
        const fields = errorFields(error)
        if (failureAction(fields) === 'keep') return
        warn('dropping a batch the server refuses', fields.code)
        deps.save(withoutIds(pending(), ids))
      } finally {
        inFlight = new Set()
      }
    }
  }

  const flush = (): Promise<void> => {
    flushing ??= drain().finally(() => {
      flushing = null
    })
    return flushing
  }

  return {
    record(log) {
      deps.save(enqueue(pending(), [log]))
      // A drain already running picks the new log up after its current batch.
      void flush()
    },
    flush,
    async undo(logId) {
      while (flushing !== null && inFlight.has(logId)) await flushing
      const queued = pending()
      if (queued.some((log) => log.id === logId)) {
        deps.save(withoutIds(queued, [logId]))
        return 'undone'
      }
      try {
        await deps.remove(logId)
        return 'undone'
      } catch (error: unknown) {
        const fields = errorFields(error)
        if (fields.code === 'NOT_FOUND' || fields.status === 404) return 'undone'
        if (fields.code === 'UNDO_EXPIRED') return 'expired'
        throw error
      }
    },
    pending,
  }
}
