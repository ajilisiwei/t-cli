/**
 * 周报: validation of `GET /v1/materials/weekly` and of the date list
 * `GET /v1/materials?kind=weekly`, week navigation and the page's wording
 * (docs/api-v1.md, "Materials").
 */

export interface WeeklyReport {
  readonly weekStart: string
  readonly weekEnd: string
  readonly totals: { readonly entries: number; readonly newItems: number; readonly reviews: number }
  readonly topErrors: readonly { readonly title: string; readonly count: number }[]
  readonly topLookups: readonly { readonly display: string; readonly count: number }[]
  readonly retention: { readonly thisWeek: number | null; readonly lastWeek: number | null }
  readonly summary: string
}

export interface WeeklyMaterial {
  /** The week's Monday: what `?date=` takes. */
  readonly date: string
  readonly content: WeeklyReport
  readonly createdAt: string
}

export interface MaterialDates {
  /** Newest first. */
  readonly dates: readonly string[]
  readonly nextBefore: string | null
}

export const WEEKLY_DATES_PAGE = 30

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isDate = (value: unknown): value is string => typeof value === 'string' && DATE_RE.test(value)

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

const rate = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Rows of a top list as `{ name, count }`, read from the field `key`; nameless rows dropped. */
const ranked = (list: unknown, key: string): { name: string; count: number }[] =>
  (Array.isArray(list) ? list : [])
    .filter(isRecord)
    .map((row) => ({ name: text(row[key]), count: count(row['count']) }))
    .filter((row) => row.name !== '')

const readReport = (value: unknown, date: string): WeeklyReport | null => {
  if (!isRecord(value)) return null
  const totals = isRecord(value['totals']) ? value['totals'] : {}
  const retention = isRecord(value['retention']) ? value['retention'] : {}
  return {
    weekStart: isDate(value['weekStart']) ? value['weekStart'] : date,
    weekEnd: isDate(value['weekEnd']) ? value['weekEnd'] : '',
    totals: {
      entries: count(totals['entries']),
      newItems: count(totals['newItems']),
      reviews: count(totals['reviews']),
    },
    topErrors: ranked(value['topErrors'], 'title').map((row) => ({ title: row.name, count: row.count })),
    topLookups: ranked(value['topLookups'], 'display').map((row) => ({ display: row.name, count: row.count })),
    retention: { thisWeek: rate(retention['thisWeek']), lastWeek: rate(retention['lastWeek']) },
    summary: text(value['summary']),
  }
}

/** Validates `GET /v1/materials/weekly`; null when unusable. */
export function readWeeklyMaterial(value: unknown): WeeklyMaterial | null {
  if (!isRecord(value) || !isDate(value['date'])) return null
  const content = readReport(value['content'], value['date'])
  if (content === null) return null
  return { date: value['date'], content, createdAt: text(value['createdAt']) }
}

/** Validates `GET /v1/materials?kind=…`; null when unusable. */
export function readMaterialDates(value: unknown): MaterialDates | null {
  if (!isRecord(value) || !Array.isArray(value['dates'])) return null
  const dates = value['dates'].filter(isDate)
  return { dates, nextBefore: isDate(value['nextBefore']) ? value['nextBefore'] : null }
}

/** Adds an older page of dates, keeping the list newest first without duplicates. */
export function mergeDates(known: readonly string[], page: readonly string[]): string[] {
  return [...new Set([...known, ...page])].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
}

export interface WeekNeighbours {
  /** The week before (older), or null. */
  readonly previous: string | null
  /** The week after (newer), or null. */
  readonly next: string | null
}

/** Older and newer reports around `current` in a newest-first list. */
export function weekNeighbours(dates: readonly string[], current: string): WeekNeighbours {
  const older = dates.filter((date) => date < current)
  const newer = dates.filter((date) => date > current)
  return {
    previous: older.length === 0 ? null : older.reduce((a, b) => (a > b ? a : b)),
    next: newer.length === 0 ? null : newer.reduce((a, b) => (a < b ? a : b)),
  }
}

const parts = (key: string): [number, number, number] => {
  const [year, month, day] = key.split('-').map(Number)
  return [year ?? 0, month ?? 0, day ?? 0]
}

/** "11月10日 – 16日", "11月24日 – 12月1日", "2025年12月29日 – 2026年1月4日". */
export function weekRangeLabel(weekStart: string, weekEnd: string, thisYear: number): string {
  const [y1, m1, d1] = parts(weekStart)
  if (!DATE_RE.test(weekEnd)) return `${y1 === thisYear ? '' : `${y1}年`}${m1}月${d1}日起的一周`
  const [y2, m2, d2] = parts(weekEnd)
  if (y1 !== y2) return `${y1}年${m1}月${d1}日 – ${y2}年${m2}月${d2}日`
  const year = y1 === thisYear ? '' : `${y1}年`
  if (m1 === m2) return `${year}${m1}月${d1}日 – ${d2}日`
  return `${year}${m1}月${d1}日 – ${m2}月${d2}日`
}

export function percent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

/** "比上周高 4 个百分点", "与上周持平", or '' when a week has no data. */
export function retentionChange(thisWeek: number | null, lastWeek: number | null): string {
  if (thisWeek === null || lastWeek === null) return ''
  const delta = Math.round(thisWeek * 100) - Math.round(lastWeek * 100)
  if (delta === 0) return '与上周持平'
  return delta > 0 ? `比上周高 ${delta} 个百分点` : `比上周低 ${-delta} 个百分点`
}

export interface RankedRow {
  readonly key: string
  readonly text: string
  readonly count: string
}

export function rankedRows(rows: readonly { readonly name: string; readonly count: number }[]): RankedRow[] {
  return rows.map((row, index) => ({ key: `${index}`, text: row.name, count: `${row.count} 次` }))
}
