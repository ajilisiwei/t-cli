/**
 * 查询记录 (v2): records grouped by local day, the day strip and the filters
 * of `GET /v1/entries/history` and `GET /v1/entries/days`
 * (docs/api-v1.md, "v2 → Records").
 *
 * Local dates are `YYYY-MM-DD` at an explicit UTC offset in minutes (the
 * device's, as the server's `utcOffsetMinutes`), so the grouping matches the
 * server's day counts and never depends on the test machine's time zone.
 */
import type { EntryDay, HistoryEntry, HistoryFilters, SourceFilter } from './types'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** Days in the strip: the last month, scrolled sideways. */
export const STRIP_DAYS = 30
/** Days shown after a date picked further back, so it has some context. */
export const STRIP_TRAILING_DAYS = 3
/** Typing pauses this long before the search runs. */
export const HISTORY_SEARCH_DEBOUNCE_MS = 300
/** The server's limit on `q`, in code points. */
export const MAX_HISTORY_QUERY = 100

const pad = (n: number): string => String(n).padStart(2, '0')

/** Midnight UTC of a valid `YYYY-MM-DD`, else null (2026-02-30 is invalid). */
const dateMs = (key: string): number | null => {
  const match = DATE_RE.exec(key)
  if (match === null) return null
  const [, y, m, d] = match
  const ms = Date.UTC(Number(y), Number(m) - 1, Number(d))
  const date = new Date(ms)
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d)
    ? ms
    : null
}

const keyOf = (ms: number): string => {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && dateMs(value) !== null
}

/** `key` moved by `days` (negative = earlier); an invalid key comes back unchanged. */
export function addDays(key: string, days: number): string {
  const ms = dateMs(key)
  return ms === null ? key : keyOf(ms + days * DAY_MS)
}

/** The local date of an instant (epoch ms) at `offsetMinutes` east of UTC. */
export function localDateAt(ms: number, offsetMinutes: number): string {
  return keyOf(ms + offsetMinutes * MINUTE_MS)
}

/** The local wall clock `HH:MM` of an instant at `offsetMinutes`. */
export function localClockAt(ms: number, offsetMinutes: number): string {
  const date = new Date(ms + offsetMinutes * MINUTE_MS)
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

/** 周一 … 周日 of a date key; '' when invalid. */
export function weekdayOf(key: string): string {
  const ms = dateMs(key)
  return ms === null ? '' : (WEEKDAYS[new Date(ms).getUTCDay()] ?? '')
}

/** "11月22日", with the year when it differs from `today`'s. */
export function monthDay(key: string, today: string): string {
  const match = DATE_RE.exec(key)
  if (match === null) return key
  const [, y, m, d] = match
  const short = `${Number(m)}月${Number(d)}日`
  return today.startsWith(`${y}-`) ? short : `${y}年${short}`
}

export interface DayHeader {
  /** 今天 / 昨天 / 11月22日. */
  readonly label: string
  /** The rest, quieter: "11月24日 周二" for today and yesterday, else the weekday. */
  readonly full: string
}

export function dayHeader(key: string, today: string): DayHeader {
  const weekday = weekdayOf(key)
  const date = monthDay(key, today)
  if (key === today) return { label: '今天', full: `${date} ${weekday}` }
  if (key === addDays(today, -1)) return { label: '昨天', full: `${date} ${weekday}` }
  return { label: date, full: weekday }
}

// ---------------------------------------------------------------- filters

export interface SourceChip {
  /** '' = 全部. */
  readonly value: '' | SourceFilter
  readonly label: string
}

export const SOURCE_CHIPS: readonly SourceChip[] = [
  { value: '', label: '全部' },
  { value: 'mp', label: '手机' },
  { value: 'cli', label: 'CLI' },
]

export function chipSource(value: unknown): SourceFilter | null {
  return value === 'mp' || value === 'cli' ? value : null
}

/** What the records list shows: one day or all, one source or both, a search. */
export interface RecordFilter {
  readonly date: string | null
  readonly source: SourceFilter | null
  /** As typed; normalized when the query is built. */
  readonly q: string
}

export const EMPTY_RECORD_FILTER: RecordFilter = { date: null, source: null, q: '' }

/** Trimmed and cut to {@link MAX_HISTORY_QUERY} code points (a literal substring: inner spaces stay). */
export function normalizeHistoryQuery(raw: string): string {
  return Array.from(raw.trim()).slice(0, MAX_HISTORY_QUERY).join('').trim()
}

/** The `GET /v1/entries/history` filters; absent ones are left out. */
export function historyFilters(filter: RecordFilter, offsetMinutes: number): HistoryFilters {
  const q = normalizeHistoryQuery(filter.q)
  return {
    ...(filter.date === null ? {} : { date: filter.date, utcOffsetMinutes: offsetMinutes }),
    ...(filter.source === null ? {} : { source: filter.source }),
    ...(q === '' ? {} : { q }),
  }
}

export function sameRecordFilter(a: RecordFilter, b: RecordFilter): boolean {
  return a.date === b.date && a.source === b.source && normalizeHistoryQuery(a.q) === normalizeHistoryQuery(b.q)
}

/** No filter at all: the list the offline cache holds. */
export function isUnfiltered(filter: RecordFilter): boolean {
  return sameRecordFilter(filter, EMPTY_RECORD_FILTER)
}

const SOURCE_NAMES: Readonly<Record<SourceFilter, string>> = { mp: '手机', cli: 'CLI' }

export function emptyRecordsText(filter: RecordFilter): string {
  const q = normalizeHistoryQuery(filter.q)
  if (q !== '') return `没有包含「${q}」的记录`
  if (filter.date !== null) return '这一天没有符合条件的记录'
  if (filter.source !== null) return `还没有来自${SOURCE_NAMES[filter.source]}的记录`
  return '还没有记录'
}

// ---------------------------------------------------------------- day strip

export interface DayRange {
  readonly from: string
  readonly to: string
}

/**
 * The strip's dates: the last {@link STRIP_DAYS} days up to today; a date
 * picked further back moves the window so it ends a few days after that date.
 */
export function stripRange(today: string, selected: string | null, length: number = STRIP_DAYS): DayRange {
  const earliest = addDays(today, -(length - 1))
  const inWindow = selected === null || !isDateKey(selected) || selected >= earliest
  const pickedEnd = selected === null ? today : addDays(selected, STRIP_TRAILING_DAYS)
  const to = inWindow || pickedEnd > today ? today : pickedEnd
  return { from: addDays(to, -(length - 1)), to }
}

export function countsByDate(days: readonly EntryDay[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const day of days) counts[day.date] = (counts[day.date] ?? 0) + day.count
  return counts
}

export interface StripChip {
  readonly date: string
  /** Element id for `scroll-into-view` (letters first, no dashes). */
  readonly anchor: string
  /** 今天, or the weekday. */
  readonly top: string
  /** The day of the month. */
  readonly mid: string
  /** "3 条"; '' while the counts are unknown. */
  readonly countLabel: string
  /** Known to have no records: greyed and not tappable. */
  readonly empty: boolean
  readonly selected: boolean
  readonly aria: string
}

export const stripAnchor = (date: string): string => `day${date.replace(/-/g, '')}`

/** The strip's chips, newest first. `counts` null = not loaded (nothing is greyed). */
export function stripChips(
  range: DayRange,
  today: string,
  counts: Readonly<Record<string, number>> | null,
  selected: string | null,
): StripChip[] {
  const chips: StripChip[] = []
  for (let date = range.to; date >= range.from && chips.length <= 366; date = addDays(date, -1)) {
    const count = counts?.[date] ?? 0
    const top = date === today ? '今天' : weekdayOf(date)
    const isSelected = date === selected
    chips.push({
      date,
      anchor: stripAnchor(date),
      top,
      mid: String(Number(date.slice(8))),
      countLabel: counts === null ? '' : `${count} 条`,
      empty: counts !== null && count === 0 && !isSelected,
      selected: isSelected,
      aria: `${monthDay(date, today)} ${weekdayOf(date)}${counts === null ? '' : `，${count} 条`}${isSelected ? '，已选' : ''}`,
    })
  }
  return chips
}

// ---------------------------------------------------------------- grouped rows

export interface DayRow {
  readonly id: string
  /** HH:MM at the device's offset. */
  readonly time: string
  readonly input: string
  /** First line of the output, markdown bold removed. */
  readonly preview: string
  readonly output: string
  readonly source: SourceFilter
  readonly sourceLabel: string
  readonly taskLabel: string
  /** Latin input reads in the serif; Chinese in the system font. */
  readonly serif: boolean
}

export interface DayGroup {
  readonly date: string
  readonly label: string
  readonly full: string
  /** "3 条". */
  readonly countLabel: string
  readonly rows: readonly DayRow[]
}

const CJK_RE = /[぀-ヿ㐀-鿿가-힯豈-﫿]/
const TASK_LABELS: Readonly<Record<string, string>> = { translate: '翻译', check: '纠错' }

const firstLine = (text: string): string =>
  text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\*\*/g, '').trim())
    .find((line) => line !== '') ?? ''

const instantOf = (entry: HistoryEntry): number => {
  const ms = Date.parse(entry.createdAt)
  return Number.isNaN(ms) ? 0 : ms
}

export function toDayRow(entry: HistoryEntry, offsetMinutes: number): DayRow {
  const ms = Date.parse(entry.createdAt)
  const source: SourceFilter = entry.source === 'cli' ? 'cli' : 'mp'
  return {
    id: entry.id,
    time: Number.isNaN(ms) ? '' : localClockAt(ms, offsetMinutes),
    input: entry.input,
    preview: firstLine(entry.output),
    output: entry.output,
    source,
    sourceLabel: SOURCE_NAMES[source],
    taskLabel: TASK_LABELS[entry.task] ?? entry.task,
    serif: !CJK_RE.test(entry.input),
  }
}

/**
 * Records grouped by local day, newest day first and newest record first in
 * a day (a CLI record pushed late has a newer seq but an older time).
 * `counts` (from the days endpoint) gives each header the day's full count
 * while only part of it is loaded; null (e.g. while searching) counts the rows.
 */
export function groupByDay(
  entries: readonly HistoryEntry[],
  offsetMinutes: number,
  today: string,
  counts: Readonly<Record<string, number>> | null,
): DayGroup[] {
  const byDate = new Map<string, HistoryEntry[]>()
  for (const entry of entries) {
    const ms = Date.parse(entry.createdAt)
    const date = Number.isNaN(ms) ? '' : localDateAt(ms, offsetMinutes)
    byDate.set(date, [...(byDate.get(date) ?? []), entry])
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, list]) => {
      const rows = [...list].sort((a, b) => instantOf(b) - instantOf(a)).map((entry) => toDayRow(entry, offsetMinutes))
      const header = date === '' ? { label: '时间未知', full: '' } : dayHeader(date, today)
      const count = Math.max(counts?.[date] ?? 0, rows.length)
      return { date, ...header, countLabel: `${count} 条`, rows }
    })
}
