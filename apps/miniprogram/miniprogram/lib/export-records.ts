/**
 * 导出记录: the PDFs this phone keeps under `${USER_DATA_PATH}/exports/`, as a
 * list in storage. A file lives 7 days; records whose file is older or gone
 * are dropped, and files no record knows are deleted. Pure: services/pdf.ts
 * does the storage and file I/O.
 */

export interface ExportRecord {
  readonly path: string
  readonly fileName: string
  /** From `X-Pdf-Pages`; null when the server did not say. */
  readonly pages: number | null
  readonly bytes: number
  /** Epoch milliseconds. */
  readonly createdAt: number
}

const DAY_MS = 86_400_000
export const EXPORT_KEEP_MS = 7 * DAY_MS
export const MAX_EXPORT_RECORDS = 30
/** The folder under the user data path. */
export const EXPORTS_DIR_NAME = 'exports'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readRecord = (value: unknown): ExportRecord | null => {
  if (!isRecord(value)) return null
  const { path, fileName, pages, bytes, createdAt } = value
  if (typeof path !== 'string' || path === '' || typeof fileName !== 'string' || fileName === '') return null
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
  const validPages = typeof pages === 'number' && Number.isInteger(pages) && pages > 0 ? pages : null
  return { path, fileName, pages: validPages, bytes, createdAt }
}

/** Whatever storage held, as records (newest first); malformed entries dropped. */
export function readRecords(value: unknown): ExportRecord[] {
  if (!Array.isArray(value)) return []
  return value
    .map(readRecord)
    .filter((record): record is ExportRecord => record !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** `record` first; an older record of the same file (overwritten) goes, and the list stays bounded. */
export function addRecord(records: readonly ExportRecord[], record: ExportRecord): ExportRecord[] {
  return [record, ...records.filter((other) => other.path !== record.path)].slice(0, MAX_EXPORT_RECORDS)
}

export const isExpired = (record: ExportRecord, now: number): boolean => now - record.createdAt >= EXPORT_KEEP_MS

export interface Pruned {
  readonly kept: readonly ExportRecord[]
  /** Records whose file must be deleted (expired, or beyond the bound). */
  readonly expired: readonly ExportRecord[]
}

/** Splits records into those to keep (fresh, file present) and those whose file to delete. */
export function pruneRecords(records: readonly ExportRecord[], now: number, exists: (path: string) => boolean): Pruned {
  const kept: ExportRecord[] = []
  const expired: ExportRecord[] = []
  for (const record of records) {
    if (isExpired(record, now) || kept.length >= MAX_EXPORT_RECORDS) expired.push(record)
    else if (exists(record.path)) kept.push(record)
  }
  return { kept, expired }
}

/** Names in the exports folder that no kept record points to. */
export function orphanFiles(names: readonly string[], dir: string, kept: readonly ExportRecord[]): string[] {
  const known = new Set(kept.map((record) => record.path))
  return names.filter((name) => !known.has(`${dir}/${name}`))
}

/** Days until the file is deleted, at least 1 while it exists. */
export function daysLeft(record: ExportRecord, now: number): number {
  return Math.max(1, Math.ceil((record.createdAt + EXPORT_KEEP_MS - now) / DAY_MS))
}

const pad = (n: number): string => String(n).padStart(2, '0')
const dayKey = (at: Date): string => `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`

/** "今天 14:03" / "昨天 09:12" / "11月24日 14:03" in local time. */
export function exportedAtLabel(createdAt: number, now: number): string {
  const at = new Date(createdAt)
  const today = new Date(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const day =
    dayKey(at) === dayKey(today) ? '今天' : dayKey(at) === dayKey(yesterday) ? '昨天' : `${at.getMonth() + 1}月${at.getDate()}日`
  return `${day} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export interface RecordRow {
  readonly path: string
  readonly fileName: string
  /** "今天 14:03 · 3 页 · 386 KB" */
  readonly meta: string
  /** "还剩 6 天" */
  readonly left: string
}

/** One row of 导出记录; `size` formats bytes (lib/account.ts formatBytes). */
export function recordRow(record: ExportRecord, now: number, size: (bytes: number) => string): RecordRow {
  return {
    path: record.path,
    fileName: record.fileName,
    meta: [exportedAtLabel(record.createdAt, now), record.pages === null ? '' : `${record.pages} 页`, size(record.bytes)]
      .filter((part) => part !== '')
      .join(' · '),
    left: `还剩 ${daysLeft(record, now)} 天`,
  }
}
