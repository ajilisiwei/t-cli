/**
 * 账号与数据 and the reminder setting: export file naming, response
 * validation for export / deletion / reminders, and the reminder hour picker
 * (docs/api-v1.md, "Account" and "Reminders").
 */

/** The body `POST /v1/me/delete` requires. */
export const DELETE_CONFIRM = 'DELETE'

export const EXPORT_FILE_PREFIX = 't-cli-export-'
export const EXPORT_FILE_SUFFIX = '.md'

const pad = (n: number): string => String(n).padStart(2, '0')

/** `t-cli-export-YYYYMMDD.md` for the device's local date. */
export function defaultExportFileName(now: Date): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  return `${EXPORT_FILE_PREFIX}${stamp}${EXPORT_FILE_SUFFIX}`
}

/** Case-insensitive header lookup (platforms differ in header name case). */
export function headerValue(headers: unknown, name: string): string | null {
  if (typeof headers !== 'object' || headers === null) return null
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === 'string') return value
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  }
  return null
}

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

const decodeExtended = (value: string): string | null => {
  // RFC 5987: charset'lang'percent-encoded
  const match = /^[A-Za-z0-9-]*'[^']*'(.+)$/.exec(value)
  if (match === null || match[1] === undefined) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/**
 * The file name to save the export under: the server's
 * `Content-Disposition` name when it is a plain `.md` name, otherwise
 * {@link defaultExportFileName}. Never a path: the result is used inside
 * `wx.env.USER_DATA_PATH`.
 */
export function exportFileName(contentDisposition: string | null, now: Date): string {
  if (contentDisposition !== null) {
    const extended = /filename\*\s*=\s*"?([^";]+)"?/i.exec(contentDisposition)
    const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;\s]+)/i.exec(contentDisposition)
    const candidates = [
      extended?.[1] === undefined ? null : decodeExtended(extended[1].trim()),
      plain?.[1] ?? plain?.[2] ?? null,
    ]
    for (const candidate of candidates) {
      const name = candidate?.trim() ?? ''
      if (SAFE_NAME_RE.test(name) && name.toLowerCase().endsWith(EXPORT_FILE_SUFFIX) && !name.includes('..')) {
        return name
      }
    }
  }
  return defaultExportFileName(now)
}

/** Earlier exports in the user data directory (removed before a new one is written). */
export function isExportFile(name: string): boolean {
  return name.startsWith(EXPORT_FILE_PREFIX) && name.endsWith(EXPORT_FILE_SUFFIX)
}

/** 2048 → "2.0 KB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.floor(bytes || 0))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `GET /v1/notify/config` → the template id, null when reminders are not configured; undefined when malformed. */
export function readReminderTemplate(value: unknown): string | null | undefined {
  if (!isRecord(value) || !('reminderTemplateId' in value)) return undefined
  const id = value['reminderTemplateId']
  if (id === null) return null
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined
}

/** `POST /v1/notify/grant` → reminders the server may still send; null when malformed. */
export function readGrantAvailable(value: unknown): number | null {
  if (!isRecord(value)) return null
  const available = value['available']
  return typeof available === 'number' && Number.isInteger(available) && available >= 0 ? available : null
}

/** `POST /v1/me/delete` succeeded. */
export function readDeleted(value: unknown): boolean {
  return isRecord(value) && value['deleted'] === true
}

/** `off`: the user switched subscribe messages off for this mini-program. */
export type SubscribeOutcome = 'accept' | 'reject' | 'ban' | 'filter' | 'off' | 'unknown'

/** The user's answer for `templateId` in a `wx.requestSubscribeMessage` result. */
export function subscribeOutcome(result: unknown, templateId: string): SubscribeOutcome {
  if (!isRecord(result)) return 'unknown'
  const answer = result[templateId]
  return answer === 'accept' || answer === 'reject' || answer === 'ban' || answer === 'filter' ? answer : 'unknown'
}

/** WeChat's error code when subscribe messages are switched off in the mini-program's settings. */
const SUBSCRIBE_SWITCHED_OFF = 20004

/** A failed `wx.requestSubscribeMessage` call as an outcome. */
export function subscribeFailure(errCode: unknown): SubscribeOutcome {
  return errCode === SUBSCRIBE_SWITCHED_OFF ? 'off' : 'unknown'
}

export const SUBSCRIBE_MESSAGES: Readonly<Record<Exclude<SubscribeOutcome, 'accept'>, string>> = {
  reject: '没有允许，明天不会提醒',
  ban: '提醒已被微信停用',
  filter: '提醒模板不可用',
  off: '订阅消息已关闭：右上角「···」→「设置」里可以打开',
  unknown: '没有完成授权',
}

/** Picker rows: 关闭, then 0:00 … 23:00. */
export const REMINDER_OPTIONS: readonly string[] = ['关闭', ...Array.from({ length: 24 }, (_, hour) => `${hour}:00`)]

export function hourToOption(hour: number | null): number {
  return hour === null || !Number.isInteger(hour) || hour < 0 || hour > 23 ? 0 : hour + 1
}

/** A picker index (number or numeric string) → hour, null for 关闭 or nonsense. */
export function optionToHour(index: unknown): number | null {
  const n = typeof index === 'string' ? Number(index) : index
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 24) return null
  return n - 1
}

export function reminderLabel(hour: number | null): string {
  return hour === null ? '关闭' : `每天 ${hour}:00`
}
