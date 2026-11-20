/**
 * Wording for the review screens: next intervals under the grade buttons
 * ("10 分钟", "3 天", "2 个月"), time spent, shares and date labels.
 */
import type { Intervals, Rating } from './review-types'

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Calendar-free month and year, as Anki shows them. */
const MONTH_DAYS = 30
const YEAR_DAYS = 365

const oneDecimal = (value: number): string => {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * The time until a card is due again, as the grade buttons show it. Units
 * step up once the rounded value would reach the next unit, so 59.7 minutes
 * reads "1 小时", never "60 分钟". Empty for a value that is not a number.
 */
export function formatInterval(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < MINUTE) return '1 分钟'
  const minutes = Math.round(seconds / MINUTE)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round(seconds / HOUR)
  if (hours < 24) return `${hours} 小时`
  const days = Math.round(seconds / DAY)
  if (days < MONTH_DAYS) return `${days} 天`
  const months = Math.round(days / MONTH_DAYS)
  if (months < 12 && days < YEAR_DAYS) return `${months} 个月`
  const years = days / YEAR_DAYS
  return years < 10 ? `${oneDecimal(years)} 年` : `${Math.round(years)} 年`
}

export interface GradeButton {
  readonly rating: Rating
  readonly label: string
  readonly interval: string
}

export const RATING_LABELS: Readonly<Record<Rating, string>> = { 1: '忘记', 2: '困难', 3: '记得', 4: '简单' }

/** The four grade buttons, each with the interval it would schedule. */
export function gradeButtons(intervals: Intervals): GradeButton[] {
  const ratings: Rating[] = [1, 2, 3, 4]
  return ratings.map((rating) => ({
    rating,
    label: RATING_LABELS[rating],
    interval: formatInterval(intervals[String(rating) as keyof Intervals]),
  }))
}

/** A number and its unit, set apart on the end screen (serif figure, small unit). */
export interface Quantity {
  readonly value: string
  readonly unit: string
}

/** Time spent in a session: 40 秒, 6 分钟, 1.5 小时. */
export function durationParts(ms: number): Quantity {
  if (!Number.isFinite(ms) || ms <= 0) return { value: '0', unit: '秒' }
  const seconds = Math.round(ms / 1000)
  if (seconds < MINUTE) return { value: String(Math.max(1, seconds)), unit: '秒' }
  const minutes = Math.round(seconds / MINUTE)
  if (minutes < 60) return { value: String(minutes), unit: '分钟' }
  return { value: oneDecimal(minutes / 60), unit: '小时' }
}

export function formatDuration(ms: number): string {
  const { value, unit } = durationParts(ms)
  return `${value} ${unit}`
}

/** Rounded percentage as text ("83"); empty when there is nothing to divide. */
export function percent(part: number, whole: number): string {
  if (!(whole > 0) || !(part >= 0)) return ''
  return String(Math.round((Math.min(part, whole) / whole) * 100))
}

/** "83%"; empty when there is nothing to divide. */
export function formatShare(part: number, whole: number): string {
  const value = percent(part, whole)
  return value === '' ? '' : `${value}%`
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

interface CalendarDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

const parseDate = (date: string): CalendarDate | null => {
  const match = DATE_RE.exec(date)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  return { year, month, day }
}

/** `YYYY-MM-DD` → "11月16日 周日" (the weekday of that calendar date). Empty when malformed. */
export function formatDateLabel(date: string): string {
  const parsed = parseDate(date)
  if (parsed === null) return ''
  const weekday = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay()
  return `${parsed.month}月${parsed.day}日 ${WEEKDAYS[weekday] ?? ''}`.trim()
}

/** `YYYY-MM-DD` → "11月16日", with the year when it is not `today`'s year. */
export function formatShortDate(date: string, today: string): string {
  const parsed = parseDate(date)
  if (parsed === null) return ''
  const monthDay = `${parsed.month}月${parsed.day}日`
  return today.startsWith(`${parsed.year}-`) ? monthDay : `${parsed.year}年${monthDay}`
}

/** The calendar day before `date` (`YYYY-MM-DD`), or '' when malformed. */
export function previousDate(date: string): string {
  const parsed = parseDate(date)
  if (parsed === null) return ''
  const probe = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day - 1))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${probe.getUTCFullYear()}-${pad(probe.getUTCMonth() + 1)}-${pad(probe.getUTCDate())}`
}

/** "今日材料" / "昨日材料" / "11月15日材料" for the material of `date`. */
export function materialTitle(date: string, today: string): string {
  if (date === today) return '今日材料'
  if (date === previousDate(today)) return '昨日材料'
  const short = formatShortDate(date, today)
  return short === '' ? '每日材料' : `${short}材料`
}
