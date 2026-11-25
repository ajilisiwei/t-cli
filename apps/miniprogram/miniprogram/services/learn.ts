/**
 * The v3 学习 endpoints (docs/api-v1.md, "v3 (M12–M17)"): the learn summary,
 * the material list, 周期资料 and 拓展资料, 学完了, 加入复习 and 不感兴趣.
 * Responses are checked by lib/learn-wire.ts; a mismatch is `BAD_RESPONSE`.
 */
import { ApiError, isApiError } from '../lib/api'
import { localDateKey } from '../lib/history'
import type {
  AdoptResult,
  ExtendMaterial,
  LearnSummary,
  MaterialKind,
  MaterialListItem,
  MaterialListPage,
  PeriodicKind,
  PeriodicMaterial,
} from '../lib/learn-types'
import { thisWeekPrintable } from '../lib/learn-view'
import {
  readAdoptResult,
  readExtendMaterial,
  readLearnSummary,
  readMaterialList,
  readPeriodicMaterial,
  readReadAt,
} from '../lib/learn-wire'
import { readDailyMaterial } from '../lib/review-material'
import { readSettings } from '../lib/wire'
import { utcOffsetMinutes } from './platform'
import { applyBadge } from './review'
import { api } from './session'
import { applyAccountSettings } from './settings'

export const MATERIALS_PAGE = 30

const badResponse = (what: string): ApiError =>
  new ApiError({ kind: 'protocol', code: 'BAD_RESPONSE', message: `malformed ${what}` })

export const isNotFound = (error: unknown): boolean =>
  isApiError(error) && (error.code === 'NOT_FOUND' || error.status === 404)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Everything the 学习 home's first screen needs; also refreshes the tab badge. */
export async function fetchLearnSummary(): Promise<LearnSummary> {
  const data = await api.request<unknown>({
    method: 'GET',
    path: '/v1/learn/summary',
    query: { utcOffsetMinutes: utcOffsetMinutes() },
  })
  const summary = readLearnSummary(data)
  if (summary === null) throw badResponse('learn summary')
  applyBadge(summary.review.dueByScope.all)
  return summary
}

export type ListKind = 'all' | MaterialKind

/** Materials newest first; `before` (a date) pages further back. */
export async function fetchMaterialList(
  kind: ListKind,
  before: string | null,
  limit: number = MATERIALS_PAGE,
): Promise<MaterialListPage> {
  const data = await api.request<unknown>({ method: 'GET', path: '/v1/materials', query: { kind, before, limit } })
  const page = readMaterialList(data)
  if (page === null) throw badResponse('material list')
  return page
}

const WEEK_CACHE_MS = 60_000
let weekCache: { readonly at: number; readonly today: string; readonly items: MaterialListItem[] } | null = null

/**
 * This week's printable materials (本周合集, 单词卡), newest first; cached for
 * a minute so the pages that open the export sheet share one request.
 */
export async function fetchThisWeek(): Promise<MaterialListItem[]> {
  const today = localDateKey(new Date())
  if (weekCache !== null && weekCache.today === today && Date.now() - weekCache.at < WEEK_CACHE_MS) return weekCache.items
  const page = await fetchMaterialList('all', null, MATERIALS_PAGE)
  const items = thisWeekPrintable(page.items, today)
  weekCache = { at: Date.now(), today, items }
  return items
}

/** A daily material or a digest (the latest without `date`); null when there is none. */
export async function fetchPeriodic(kind: PeriodicKind, date?: string): Promise<PeriodicMaterial | null> {
  let data: unknown
  try {
    data = await api.request<unknown>({ method: 'GET', path: `/v1/materials/${kind}`, query: { date } })
  } catch (error: unknown) {
    if (isNotFound(error)) return null
    throw error
  }
  const material = readPeriodicMaterial(data, kind, readDailyMaterial)
  if (material === null) throw badResponse(`${kind} material`)
  return material
}

/** An extension material (the latest without `date`); null when there is none. */
export async function fetchExtend(date?: string): Promise<ExtendMaterial | null> {
  let data: unknown
  try {
    data = await api.request<unknown>({ method: 'GET', path: '/v1/materials/extend', query: { date } })
  } catch (error: unknown) {
    if (isNotFound(error)) return null
    throw error
  }
  const material = readExtendMaterial(data)
  if (material === null) throw badResponse('extension material')
  return material
}

/** 学完了 (or its undo): the new `readAt`. */
export async function markRead(kind: MaterialKind, date: string, read: boolean): Promise<string | null> {
  const data = await api.request<unknown>({
    method: 'POST',
    path: `/v1/materials/${kind}/${encodeURIComponent(date)}/read`,
    body: { read },
  })
  const readAt = readReadAt(data)
  if (readAt === undefined) throw badResponse('read state')
  return readAt
}

/** 加入复习: the ticked items of an extension become units (idempotent). */
export async function adoptExtend(date: string, indexes: readonly number[]): Promise<AdoptResult> {
  const data = await api.request<unknown>({
    method: 'POST',
    path: `/v1/materials/extend/${encodeURIComponent(date)}/adopt`,
    body: { indexes },
  })
  const result = readAdoptResult(data)
  if (result === null) throw badResponse('adopt result')
  return result
}

/**
 * 不感兴趣 (or its undo): the server mutes the material's topic for 30 days in
 * `extendMuted`; the answer is taken into the local settings.
 */
export async function dismissExtend(date: string, undo: boolean): Promise<void> {
  const data = await api.request<unknown>({
    method: 'POST',
    path: `/v1/materials/extend/${encodeURIComponent(date)}/dismiss`,
    body: undo ? { undo: true } : {},
  })
  const settings = readSettings(isRecord(data) ? { extendMuted: data['extendMuted'] } : {})
  if (settings.extendMuted === undefined) throw badResponse('dismiss result')
  applyAccountSettings(settings)
}
