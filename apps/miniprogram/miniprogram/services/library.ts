/**
 * Reads of the learning data the 词库, 学习单元, 学习统计 and 周报 pages show
 * (docs/api-v1.md, "Library and stats" and "Materials"). Responses are
 * validated by the pure readers in lib/; a mismatch is `BAD_RESPONSE`.
 */
import { ApiError, isApiError } from '../lib/api'
import { readItemDetail, type ItemDetail } from '../lib/item'
import { LIBRARY_PAGE_SIZE, itemsQuery, readItemsPage, type ItemsPage, type LibraryFilter } from '../lib/library'
import { heatmapDays, readStats, type Stats } from '../lib/stats'
import {
  WEEKLY_DATES_PAGE,
  readMaterialDates,
  readWeeklyMaterial,
  type MaterialDates,
  type WeeklyMaterial,
} from '../lib/weekly'
import { utcOffsetMinutes } from './platform'
import { api } from './session'

const badResponse = (what: string): ApiError =>
  new ApiError({ kind: 'protocol', code: 'BAD_RESPONSE', message: `malformed ${what}` })

export async function fetchItems(filter: LibraryFilter, offset: number): Promise<ItemsPage> {
  const data = await api.request<unknown>({
    method: 'GET',
    path: '/v1/items',
    query: itemsQuery(filter, offset, LIBRARY_PAGE_SIZE),
  })
  const page = readItemsPage(data)
  if (page === null) throw badResponse('items page')
  return page
}

export async function fetchItem(id: string): Promise<ItemDetail> {
  const data = await api.request<unknown>({ method: 'GET', path: `/v1/items/${encodeURIComponent(id)}` })
  const detail = readItemDetail(data)
  if (detail === null) throw badResponse('item')
  return detail
}

export async function fetchStats(days: number = heatmapDays()): Promise<Stats> {
  const data = await api.request<unknown>({
    method: 'GET',
    path: '/v1/stats',
    query: { days, utcOffsetMinutes: utcOffsetMinutes() },
  })
  const stats = readStats(data)
  if (stats === null) throw badResponse('stats')
  return stats
}

/** The weekly report starting on `monday`, or the latest one; null when there is none. */
export async function fetchWeekly(monday: string | null): Promise<WeeklyMaterial | null> {
  let data: unknown
  try {
    data = await api.request<unknown>({ method: 'GET', path: '/v1/materials/weekly', query: { date: monday } })
  } catch (error: unknown) {
    if (isApiError(error) && error.code === 'NOT_FOUND') return null
    throw error
  }
  const material = readWeeklyMaterial(data)
  if (material === null) throw badResponse('weekly report')
  return material
}

/** Dates (Mondays) that have a weekly report, newest first, older than `before`. */
export async function fetchWeeklyDates(before: string | null): Promise<MaterialDates> {
  const data = await api.request<unknown>({
    method: 'GET',
    path: '/v1/materials',
    query: { kind: 'weekly', before, limit: WEEKLY_DATES_PAGE },
  })
  const dates = readMaterialDates(data)
  if (dates === null) throw badResponse('material dates')
  return dates
}
