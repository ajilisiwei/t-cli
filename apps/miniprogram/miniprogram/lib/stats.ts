/**
 * 学习统计: validation of `GET /v1/stats` and the layouts the page draws —
 * a calendar heatmap (weeks as columns, Monday on top), 12 weekly retention
 * bars and the totals (docs/api-v1.md, "Library and stats").
 *
 * Dates are local `YYYY-MM-DD` keys. Day arithmetic runs on UTC midnights
 * of those keys, so a daylight-saving switch never skips or repeats a day.
 */

export interface StatsDay {
  readonly date: string
  readonly entries: number
  readonly reviews: number
}

export interface RetentionWeek {
  readonly weekStart: string
  /** Share of ratings ≥ 2 on non-new cards, 0–1. */
  readonly rate: number
}

export interface StatsTotals {
  readonly entries: number
  readonly items: number
  readonly cards: number
  readonly mastered: number
}

export interface Stats {
  readonly days: readonly StatsDay[]
  readonly streakDays: number
  readonly retention: readonly RetentionWeek[]
  readonly totals: StatsTotals
}

export const HEATMAP_WEEKS = 17
export const RETENTION_WEEKS = 12

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = DATE_RE.exec(value)
  if (match === null) return false
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return toDateKey(time) === value
}

/** UTC midnight of a `YYYY-MM-DD` key (call only with a valid key). */
const toTime = (key: string): number => {
  const match = DATE_RE.exec(key)
  return match === null ? Number.NaN : Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

const toDateKey = (time: number): string => {
  const date = new Date(time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

export function addDays(key: string, days: number): string {
  return toDateKey(toTime(key) + days * DAY_MS)
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(key: string): number {
  return (new Date(toTime(key)).getUTCDay() + 6) % 7
}

/** The Monday of the week containing `key`. */
export function mondayOf(key: string): string {
  return addDays(key, -weekdayIndex(key))
}

/** Validates `GET /v1/stats`; null when unusable. Malformed days and weeks are dropped. */
export function readStats(value: unknown): Stats | null {
  if (!isRecord(value) || !Array.isArray(value['days'])) return null
  const days = value['days']
    .filter(isRecord)
    .filter((day) => isDateKey(day['date']))
    .map((day) => ({ date: String(day['date']), entries: count(day['entries']), reviews: count(day['reviews']) }))
  const retention = (Array.isArray(value['retention']) ? value['retention'] : [])
    .filter(isRecord)
    .filter((week) => isDateKey(week['weekStart']) && typeof week['rate'] === 'number' && Number.isFinite(week['rate']))
    .map((week) => ({ weekStart: String(week['weekStart']), rate: Math.min(1, Math.max(0, Number(week['rate']))) }))
  const totals = isRecord(value['totals']) ? value['totals'] : {}
  return {
    days,
    streakDays: count(value['streakDays']),
    retention,
    totals: {
      entries: count(totals['entries']),
      items: count(totals['items']),
      cards: count(totals['cards']),
      mastered: count(totals['mastered']),
    },
  }
}

/** How many days `GET /v1/stats` must cover so the heatmap is full. */
export function heatmapDays(weeks: number = HEATMAP_WEEKS): number {
  return weeks * 7
}

export type HeatLevel = 0 | 1 | 2 | 3 | 4

export interface HeatCell {
  readonly date: string
  readonly entries: number
  readonly reviews: number
  readonly level: HeatLevel
  /** After today: drawn empty, no label. */
  readonly future: boolean
  /** For screen readers and the tap read-out: "11月18日 查询 3 条 · 复习 12 张". */
  readonly label: string
}

export interface HeatColumn {
  /** The column's Monday (a stable list key). */
  readonly key: string
  /** "11月" above the column where a month begins; '' elsewhere. */
  readonly month: string
  readonly cells: readonly HeatCell[]
}

export interface Heatmap {
  readonly columns: readonly HeatColumn[]
  /** Days in the window with at least one entry or review. */
  readonly activeDays: number
}

/** The darkest shade needs at least this many actions, so one quiet day is not "full". */
const MIN_SCALE = 8

/** Shade 1–4 relative to the busiest day in view; 0 for none. */
export function heatLevel(total: number, max: number): HeatLevel {
  if (total <= 0) return 0
  const level = Math.ceil((4 * total) / Math.max(max, MIN_SCALE))
  return Math.min(4, Math.max(1, level)) as HeatLevel
}

const monthDay = (key: string): string => {
  const match = DATE_RE.exec(key)
  return match === null ? key : `${Number(match[2])}月${Number(match[3])}日`
}

export function dayLabel(date: string, entries: number, reviews: number): string {
  if (entries === 0 && reviews === 0) return `${monthDay(date)} 没有记录`
  const parts: string[] = []
  if (entries > 0) parts.push(`查询 ${entries} 条`)
  if (reviews > 0) parts.push(`复习 ${reviews} 张`)
  return `${monthDay(date)} ${parts.join(' · ')}`
}

/**
 * Lays out `weeks` columns ending with the week of `today`: each column is
 * Monday → Sunday, the last one is cut at today (later cells are `future`).
 * A month label sits on the column holding the month's first day, unless the
 * previous label is too close to fit.
 */
export function buildHeatmap(days: readonly StatsDay[], today: string, weeks: number = HEATMAP_WEEKS): Heatmap {
  const byDate = new Map(days.map((day) => [day.date, day]))
  const start = addDays(mondayOf(today), -(weeks - 1) * 7)
  const todayTime = toTime(today)
  let max = 0
  let activeDays = 0
  for (let i = 0; i < weeks * 7; i += 1) {
    const day = byDate.get(addDays(start, i))
    if (day === undefined || toTime(day.date) > todayTime) continue
    const total = day.entries + day.reviews
    if (total > 0) activeDays += 1
    max = Math.max(max, total)
  }
  const columns: HeatColumn[] = []
  for (let w = 0; w < weeks; w += 1) {
    const cells: HeatCell[] = []
    let month = ''
    for (let d = 0; d < 7; d += 1) {
      const date = addDays(start, w * 7 + d)
      const future = toTime(date) > todayTime
      const day = future ? undefined : byDate.get(date)
      const entries = day?.entries ?? 0
      const reviews = day?.reviews ?? 0
      cells.push({
        date,
        entries,
        reviews,
        level: heatLevel(entries + reviews, max),
        future,
        label: future ? '' : dayLabel(date, entries, reviews),
      })
      if (date.endsWith('-01')) month = `${Number(date.slice(5, 7))}月`
    }
    columns.push({ key: addDays(start, w * 7), month, cells })
  }
  return { columns: withMonthLabels(columns, start), activeDays }
}

/** Labels need three columns of room ("11月" is wider than a column). */
const LABEL_GAP = 3

/**
 * Keeps the month labels that fit. The first column is labelled with its own
 * month only when the first month start is far enough to the right.
 */
const withMonthLabels = (columns: readonly HeatColumn[], start: string): HeatColumn[] => {
  const firstStart = columns.findIndex((column) => column.month !== '')
  const leading = firstStart === -1 || firstStart >= LABEL_GAP ? `${Number(start.slice(5, 7))}月` : ''
  let last = -LABEL_GAP
  return columns.map((column, w) => {
    const month = w === 0 && column.month === '' ? leading : column.month
    if (month === '' || w - last < LABEL_GAP) return { ...column, month: '' }
    last = w
    return { ...column, month }
  })
}

export interface MonthMark {
  readonly key: string
  readonly text: string
  /** Distance from the heatmap's left edge, in the unit of `firstColumn` / `pitch`. */
  readonly left: number
}

/**
 * Month labels as absolutely positioned marks: a label is wider than a
 * column, so it cannot live inside one. Column `i` starts at
 * `firstColumn + i × pitch`.
 */
export function monthMarks(columns: readonly HeatColumn[], firstColumn: number, pitch: number): MonthMark[] {
  return columns
    .map((column, index) => ({ key: column.key, text: column.month, left: firstColumn + index * pitch }))
    .filter((mark) => mark.text !== '')
}

export interface RetentionBar {
  readonly weekStart: string
  /** null: no reviews of learnt cards that week. */
  readonly rate: number | null
  /** Bar height in percent of the chart (0–100); a week without data gets 0. */
  readonly height: number
  /** "92%" or "". */
  readonly percent: string
  /** "11/10" — shown under the first, middle and last bar only. */
  readonly tick: string
  readonly label: string
}

const percentText = (rate: number): string => `${Math.round(rate * 100)}%`

/**
 * One bar per week for the `weeks` weeks ending with the current one
 * (oldest first). Weeks the server omitted have no bar.
 */
export function buildRetentionBars(
  retention: readonly RetentionWeek[],
  today: string,
  weeks: number = RETENTION_WEEKS,
): RetentionBar[] {
  const byWeek = new Map(retention.map((week) => [week.weekStart, week.rate]))
  const thisMonday = mondayOf(today)
  const bars: RetentionBar[] = []
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const weekStart = addDays(thisMonday, -i * 7)
    const rate = byWeek.get(weekStart) ?? null
    const index = weeks - 1 - i
    const showTick = index === 0 || index === weeks - 1 || index === Math.floor((weeks - 1) / 2)
    const [, month, day] = weekStart.split('-')
    bars.push({
      weekStart,
      rate,
      height: rate === null ? 0 : Math.round(rate * 100),
      percent: rate === null ? '' : percentText(rate),
      tick: showTick ? `${Number(month)}/${Number(day)}` : '',
      label: `${monthDay(weekStart)}那周 ${rate === null ? '没有复习' : `保持率 ${percentText(rate)}`}`,
    })
  }
  return bars
}

/** "本周 92%", "上周 88%" or "近 12 周还没有复习" — the line above the bars. */
export function retentionSummary(bars: readonly RetentionBar[]): string {
  const last = bars[bars.length - 1]
  if (last !== undefined && last.rate !== null) return `本周保持率 ${last.percent}`
  const latest = [...bars].reverse().find((bar) => bar.rate !== null)
  if (latest === undefined) return `近 ${bars.length} 周还没有复习过学过的卡片`
  return `最近一次 ${latest.percent}（${monthDay(latest.weekStart)}那周）`
}

/** 1234 → "1,234". */
export function formatCount(n: number): string {
  return String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export interface TotalCell {
  readonly label: string
  readonly value: string
}

export function totalCells(totals: StatsTotals): TotalCell[] {
  return [
    { label: '查询记录', value: formatCount(totals.entries) },
    { label: '学习单元', value: formatCount(totals.items) },
    { label: '复习卡片', value: formatCount(totals.cards) },
    { label: '已掌握', value: formatCount(totals.mastered) },
  ]
}
