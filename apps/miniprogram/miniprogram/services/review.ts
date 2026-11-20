/**
 * The learning endpoints behind 复习 and 每日材料 (docs/api-v1.md, "Learning
 * (M3–M5)"), the review-log outbox, the 复习 tab badge and the reminder
 * subscription asked for on 开始复习.
 *
 * Outbox (lib/review-queue.ts): a rating is written to storage first and
 * posted at once. A failed post (offline, server busy) leaves it queued; the
 * next rating, the next session or the app coming back to the foreground
 * flushes it. Log ids are client ULIDs, so a log posted twice counts once.
 */
import { ApiError, isApiError } from '../lib/api'
import { badgeText, reminderAccepted, reminderTemplateToAsk } from '../lib/review-home'
import { readDailyMaterialResponse } from '../lib/review-material'
import { createOutbox, type UndoOutcome } from '../lib/review-queue'
import type { DailyMaterialResponse, MaterialDates, QueueCard, ReviewLog, ReviewSummary } from '../lib/review-types'
import { ULID_ENTROPY_BYTES, ulid } from '../lib/review-ulid'
import {
  readBatchResult,
  readMaterialDates,
  readQueueCards,
  readReminderTemplateId,
  readSummary,
} from '../lib/review-validate'
import { utcOffsetMinutes } from './platform'
import { api } from './session'

/** Position of 复习 in app.json's tab bar. */
const REVIEW_TAB_INDEX = 2
/** The queue serves at most 15 new + 60 review cards a day; 100 is the contract's maximum. */
export const SESSION_CARD_LIMIT = 100
export const MATERIAL_DATES_PAGE = 60
/** Queued ratings; spelled out here because this module alone reads it. */
const PENDING_KEY = 'tcli:review:pending'

const badResponse = (what: string): ApiError =>
  new ApiError({ kind: 'protocol', code: 'BAD_RESPONSE', message: `malformed ${what}` })

const isNotFound = (error: unknown): boolean => isApiError(error) && (error.code === 'NOT_FOUND' || error.status === 404)

// ---- summary and queue ----

export async function fetchSummary(): Promise<ReviewSummary> {
  const data = await api.request<unknown>({
    method: 'GET',
    path: '/v1/review/summary',
    query: { utcOffsetMinutes: utcOffsetMinutes() },
  })
  const summary = readSummary(data)
  if (summary === null) throw badResponse('review summary')
  return summary
}

export async function fetchQueue(limit: number = SESSION_CARD_LIMIT): Promise<QueueCard[]> {
  const data = await api.request<unknown>({
    method: 'GET',
    path: '/v1/review/queue',
    query: { utcOffsetMinutes: utcOffsetMinutes(), limit },
  })
  const cards = readQueueCards(data)
  if (cards === null) throw badResponse('review queue')
  return cards
}

/** "内容有误": the server suspends the item's cards and regenerates them. */
export async function reportCard(cardId: string): Promise<void> {
  await api.request<unknown>({ method: 'POST', path: `/v1/cards/${encodeURIComponent(cardId)}/report` })
}

// ---- log ids ----

/**
 * A ULID for a new log. `Math.random` entropy: the id only has to be unique
 * per account (it is an idempotency key, not a secret), and the
 * mini-program's crypto API is asynchronous.
 */
export function newLogId(now: number = Date.now()): string {
  const bytes = Array.from({ length: ULID_ENTROPY_BYTES }, () => Math.floor(Math.random() * 256))
  return ulid(now, bytes)
}

// ---- outbox ----

const outbox = createOutbox({
  load: () => {
    try {
      return wx.getStorageSync(PENDING_KEY)
    } catch {
      return null
    }
  },
  save: (logs) => {
    try {
      if (logs.length === 0) wx.removeStorageSync(PENDING_KEY)
      else wx.setStorageSync(PENDING_KEY, logs)
    } catch (error: unknown) {
      console.warn('[review] could not store queued ratings', error)
    }
  },
  post: async (logs) => {
    const data = await api.request<unknown>({ method: 'POST', path: '/v1/reviews', body: { logs } })
    const result = readBatchResult(data)
    if (result === null) throw badResponse('review batch result')
    return result
  },
  remove: async (logId) => {
    await api.request<unknown>({ method: 'DELETE', path: `/v1/reviews/${encodeURIComponent(logId)}` })
  },
  warn: (message, detail) => console.warn(`[review] ${message}`, detail),
})

/** Posts queued ratings (single-flight). Resolves when the outbox is empty or offline; never rejects. */
export function flushPending(): Promise<void> {
  return outbox.flush()
}

/** Queues a rating and posts it at once (or later, when offline). */
export function recordReview(log: ReviewLog): void {
  outbox.record(log)
}

/**
 * Withdraws a rating: removed locally while queued, else `DELETE
 * /v1/reviews/:id`. Rejects with the ApiError when the server cannot be
 * reached; the rating then stands.
 */
export function undoReview(logId: string): Promise<UndoOutcome> {
  return outbox.undo(logId)
}

export type { UndoOutcome }

// ---- tab badge ----

/** Shows `due` on the 复习 tab (fails quietly while a non-tab page is on top). */
export function applyBadge(due: number): void {
  const text = badgeText(due)
  if (text === null) wx.removeTabBarBadge({ index: REVIEW_TAB_INDEX, fail: () => undefined })
  else wx.setTabBarBadge({ index: REVIEW_TAB_INDEX, text, fail: () => undefined })
}

const BADGE_REFRESH_MIN_MS = 30_000
let lastBadgeRefresh = 0

/** Flushes queued ratings, then reads the summary and updates the badge. */
export async function loadSummary(): Promise<ReviewSummary> {
  await flushPending()
  const summary = await fetchSummary()
  lastBadgeRefresh = Date.now()
  applyBadge(summary.due)
  return summary
}

/** For app show: at most every 30 s, quiet on failure. */
export async function refreshReviewBadge(): Promise<void> {
  if (Date.now() - lastBadgeRefresh < BADGE_REFRESH_MIN_MS) return
  lastBadgeRefresh = Date.now()
  try {
    await loadSummary()
  } catch (error: unknown) {
    console.warn('[review] badge refresh failed', isApiError(error) ? error.code : error)
  }
}

// ---- materials ----

/** The day's material (latest without a date); null when there is none. */
export async function fetchDailyMaterial(date?: string): Promise<DailyMaterialResponse | null> {
  let data: unknown
  try {
    data = await api.request<unknown>({ method: 'GET', path: '/v1/materials/daily', query: { date } })
  } catch (error: unknown) {
    if (isNotFound(error)) return null
    throw error
  }
  const material = readDailyMaterialResponse(data)
  if (material === null) throw badResponse('daily material')
  return material
}

export async function fetchMaterialDates(before: string | null = null): Promise<MaterialDates> {
  const data = await api.request<unknown>({
    method: 'GET',
    path: '/v1/materials',
    query: { kind: 'daily', before, limit: MATERIAL_DATES_PAGE },
  })
  const dates = readMaterialDates(data)
  if (dates === null) throw badResponse('material dates')
  return dates
}

// ---- reminders (WeChat one-time subscribe messages) ----

/** undefined: not loaded yet; null: reminders not configured on the server. */
let reminderTemplate: string | null | undefined

/** Loads `GET /v1/notify/config` once per run (again after a failure). Quiet on failure. */
export async function loadReminderConfig(): Promise<void> {
  if (reminderTemplate !== undefined) return
  try {
    reminderTemplate = readReminderTemplateId(await api.request<unknown>({ method: 'GET', path: '/v1/notify/config' }))
  } catch (error: unknown) {
    console.warn('[review] notify config not loaded', isApiError(error) ? error.code : error)
  }
}

const grantReminder = (templateId: string): void => {
  api.request<unknown>({ method: 'POST', path: '/v1/notify/grant', body: { templateId } }).catch((error: unknown) => {
    console.warn('[review] reminder grant not recorded', isApiError(error) ? error.code : error)
  })
}

/**
 * One acceptance = one reminder, so 开始复习 asks for the next one. Must be
 * called synchronously inside the tap (WeChat shows the dialog only for a
 * user gesture). `then` runs once the dialog is settled — or at once when
 * reminders are off or not configured — whatever the answer.
 */
export function askForReminderThen(reminderHour: number | null, then: () => void): void {
  const templateId = reminderTemplateToAsk(reminderHour, reminderTemplate ?? null)
  if (templateId === null) {
    then()
    return
  }
  wx.requestSubscribeMessage({
    tmplIds: [templateId],
    success: (result) => {
      if (reminderAccepted(result, templateId)) grantReminder(templateId)
    },
    complete: () => then(),
  })
}
