/**
 * 我的 → 记录: paging state and row formatting for
 * `GET /v1/entries/history` (newest first).
 */
import type { HistoryEntry, HistoryPage } from './types'

export interface HistoryState {
  readonly entries: readonly HistoryEntry[]
  readonly nextBefore: number | null
  readonly hasMore: boolean
}

export const EMPTY_HISTORY: HistoryState = { entries: [], nextBefore: null, hasMore: true }

/**
 * Appends an older page. Entries already shown are skipped, so a page that
 * overlaps (a record synced between two loads) never duplicates a row.
 */
export function appendPage(state: HistoryState, page: HistoryPage): HistoryState {
  const seen = new Set(state.entries.map((entry) => entry.id))
  const fresh = page.entries.filter((entry) => !seen.has(entry.id))
  return {
    entries: [...state.entries, ...fresh],
    nextBefore: page.hasMore ? page.nextBefore : null,
    hasMore: page.hasMore && page.nextBefore !== null,
  }
}

export interface HistoryRow {
  readonly id: string
  readonly sourceLabel: string
  readonly taskLabel: string
  readonly time: string
  readonly input: string
  /** First line of the output: what the collapsed row shows. */
  readonly preview: string
  readonly output: string
}

const SOURCE_LABELS: Readonly<Record<string, string>> = { cli: 'CLI', mp: '小程序' }
const TASK_LABELS: Readonly<Record<string, string>> = { translate: '翻译', check: '纠错' }

const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/

/** `YYYY-MM-DD` of a date in the device's local time. */
export function localDateKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * When a record was made, in the wall-clock time it was recorded with
 * (`createdAt` carries the recording device's offset): "今天 14:03",
 * "昨天 09:12", "11月16日 08:30", or with the year when it is not this year.
 */
export function formatEntryTime(createdAt: string, today: string, yesterday: string): string {
  const match = STAMP_RE.exec(createdAt)
  if (match === null) return ''
  const [, year, month, day, hour, minute] = match
  const date = `${year}-${month}-${day}`
  const clock = `${hour}:${minute}`
  if (date === today) return `今天 ${clock}`
  if (date === yesterday) return `昨天 ${clock}`
  const monthDay = `${Number(month)}月${Number(day)}日`
  return today.startsWith(`${year}-`) ? `${monthDay} ${clock}` : `${year}年${monthDay}`
}

/** `YYYY-MM-DD` keys for today and yesterday on this device. */
export function dayKeys(now: Date): { today: string; yesterday: string } {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  return { today: localDateKey(now), yesterday: localDateKey(yesterday) }
}

/**
 * A server timestamp (an instant, usually UTC) in this device's local time,
 * same wording as {@link formatEntryTime}.
 */
export function formatInstant(iso: string, now: Date): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  const local = `${localDateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  const { today, yesterday } = dayKeys(now)
  return formatEntryTime(local, today, yesterday)
}

const firstLine = (text: string): string =>
  text
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/\*\*/g, '').trim())
    .find((line) => line !== '') ?? ''

export function toHistoryRow(entry: HistoryEntry, today: string, yesterday: string): HistoryRow {
  return {
    id: entry.id,
    sourceLabel: SOURCE_LABELS[entry.source] ?? entry.source,
    taskLabel: TASK_LABELS[entry.task] ?? entry.task,
    time: formatEntryTime(entry.createdAt, today, yesterday),
    input: entry.input,
    preview: firstLine(entry.output),
    output: entry.output,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isHistoryEntry = (entry: unknown): entry is HistoryEntry =>
  isRecord(entry) &&
  typeof entry['id'] === 'string' &&
  typeof entry['seq'] === 'number' &&
  typeof entry['source'] === 'string' &&
  typeof entry['task'] === 'string' &&
  typeof entry['input'] === 'string' &&
  typeof entry['output'] === 'string' &&
  typeof entry['createdAt'] === 'string'

/**
 * Validates a history page, from the API or read back from the offline
 * cache; null when unusable. Malformed entries are dropped.
 */
export function readHistoryPage(value: unknown): HistoryPage | null {
  if (!isRecord(value) || !Array.isArray(value['entries'])) return null
  const entries = value['entries'].filter(isHistoryEntry)
  const nextBefore = typeof value['nextBefore'] === 'number' ? value['nextBefore'] : null
  return { entries, nextBefore, hasMore: value['hasMore'] === true && nextBefore !== null }
}
