/**
 * 学习 home and 学习资料 list: material labels, relative dates, week groups,
 * the review scope choice and the 学习计划 summary line. Pure: dates are
 * `YYYY-MM-DD` strings of the local calendar (weeks start on Monday).
 */
import type {
  DueByScope,
  LearnSummary,
  MaterialKind,
  MaterialListItem,
  PrintableKind,
  ReviewScope,
} from './learn-types'
import type { ExportMaterial } from './pdf-export'
import type { MaterialFrequency, MaterialPart } from './types'

// ---- calendar dates ----

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const pad = (n: number): string => String(n).padStart(2, '0')

/** A valid `YYYY-MM-DD` as a UTC date (only its calendar fields are used); null when malformed. */
const toUtc = (date: string): Date | null => {
  const match = DATE_RE.exec(date)
  if (match === null) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day ? probe : null
}

const fromUtc = (date: Date): string =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`

/** `date` plus `days` (negative goes back); '' when malformed. */
export function addDays(date: string, days: number): string {
  const probe = toUtc(date)
  if (probe === null) return ''
  return fromUtc(new Date(probe.getTime() + days * 86_400_000))
}

/** 0 = Sunday … 6 = Saturday; -1 when malformed. */
export function weekdayOf(date: string): number {
  return toUtc(date)?.getUTCDay() ?? -1
}

/** The Monday of `date`'s week; '' when malformed. */
export function mondayOf(date: string): string {
  const weekday = weekdayOf(date)
  return weekday < 0 ? '' : addDays(date, -((weekday + 6) % 7))
}

/** "11月24日"; '' when malformed. */
export function monthDay(date: string): string {
  const probe = toUtc(date)
  return probe === null ? '' : `${probe.getUTCMonth() + 1}月${probe.getUTCDate()}日`
}

/** "11月24日 周一"; '' when malformed. */
export function dayLabel(date: string): string {
  const probe = toUtc(date)
  return probe === null ? '' : `${monthDay(date)} ${WEEKDAYS[probe.getUTCDay()] ?? ''}`
}

/** "11月17日–23日", or "10月27日–11月2日" across a month. */
export function rangeLabel(start: string, end: string): string {
  const from = toUtc(start)
  const to = toUtc(end)
  if (from === null || to === null) return ''
  const tail = from.getUTCMonth() === to.getUTCMonth() ? `${to.getUTCDate()}日` : monthDay(end)
  return `${monthDay(start)}–${tail}`
}

/** 今天 / 昨天 / 本周一 (earlier this week) / 11月24日. */
export function relativeDay(date: string, today: string): string {
  if (date === today) return '今天'
  if (date === addDays(today, -1)) return '昨天'
  if (date < today && mondayOf(date) === mondayOf(today)) return `本${WEEKDAYS[weekdayOf(date)] ?? ''}`
  return monthDay(date)
}

/** The local calendar day and "HH:MM" of an ISO timestamp; null when it is not one. */
export function localStamp(iso: string): { date: string; time: string } | null {
  const at = new Date(iso)
  if (iso === '' || Number.isNaN(at.getTime())) return null
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  }
}

// ---- material rows ----

export const KIND_LABELS: Readonly<Record<MaterialKind, string>> = {
  daily: '每日资料',
  digest: '每周合集',
  extend: '拓展',
  weekly: '周报',
}

export const isPrintable = (kind: MaterialKind): kind is PrintableKind => kind !== 'weekly'

/** The days a list row covers: one day, a digest's 7 days ending on `date`, or a report's week from Monday `date`. */
export function materialDateLabel(item: Pick<MaterialListItem, 'kind' | 'date'>): string {
  switch (item.kind) {
    case 'digest':
      return rangeLabel(addDays(item.date, -6), item.date)
    case 'weekly':
      return rangeLabel(item.date, addDays(item.date, 6))
    default:
      return dayLabel(item.date)
  }
}

/** On the home cards: when it came out ("今天 05:00", "本周一"), a week for a report. */
export function homeDateLabel(item: Pick<MaterialListItem, 'kind' | 'date' | 'createdAt'>, today: string): string {
  if (item.kind === 'weekly') return materialDateLabel(item)
  if (item.kind === 'extend') return relativeDay(item.date, today)
  const created = localStamp(item.createdAt)
  return created === null ? relativeDay(item.date, today) : `${relativeDay(created.date, today)} ${created.time}`
}

/** "单词 6 · 词组 2 · 语法 1 · 练习 8 题" (only the parts shown); "10 个词和表达" for an extension. */
export function materialMeta(item: Pick<MaterialListItem, 'kind' | 'counts'>, parts: readonly MaterialPart[]): string {
  const { counts } = item
  if (item.kind === 'weekly') return ''
  if (item.kind === 'extend') return counts.items > 0 ? `${counts.items} 个词和表达` : ''
  const show = (part: MaterialPart, n: number, label: string): string => (parts.includes(part) && n > 0 ? label : '')
  return [
    show('words', counts.words, `单词 ${counts.words}`),
    show('phrases', counts.phrases, `词组 ${counts.phrases}`),
    show('grammar', counts.grammar, `语法 ${counts.grammar}`),
    show('exercises', counts.exercises, `练习 ${counts.exercises} 题`),
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

export type StatusTone = 'accent' | 'muted'

/** 未读 / 新 (an unread extension) / 已学完; nothing for a report. */
export function materialStatus(item: Pick<MaterialListItem, 'kind' | 'readAt'>): { text: string; tone: StatusTone } | null {
  if (item.kind === 'weekly') return null
  if (item.readAt !== null) return { text: '已学完', tone: 'muted' }
  return { text: item.kind === 'extend' ? '新' : '未读', tone: 'accent' }
}

/** The page that shows a material (`pages` rides along for the export sheet's estimate). */
export function materialUrl(item: Pick<MaterialListItem, 'kind' | 'date' | 'pages'>): string {
  switch (item.kind) {
    case 'weekly':
      return `/pages/weekly/index?date=${item.date}`
    case 'extend':
      return `/pages/extend/index?date=${item.date}&pages=${item.pages}`
    default:
      return `/pages/materials/index?kind=${item.kind}&date=${item.date}&pages=${item.pages}`
  }
}

export interface MaterialRow {
  /** `<kind>:<date>`, unique in a list. */
  readonly key: string
  readonly kind: MaterialKind
  readonly date: string
  readonly kindLabel: string
  readonly dateLabel: string
  readonly title: string
  readonly meta: string
  readonly status: string
  /** '' without a status. */
  readonly statusTone: '' | StatusTone
  readonly printable: boolean
  readonly pages: number
  readonly url: string
}

export const materialKey = (item: Pick<MaterialListItem, 'kind' | 'date'>): string => `${item.kind}:${item.date}`

export function materialRow(item: MaterialListItem, parts: readonly MaterialPart[]): MaterialRow {
  const status = materialStatus(item)
  return {
    key: materialKey(item),
    kind: item.kind,
    date: item.date,
    kindLabel: KIND_LABELS[item.kind],
    dateLabel: materialDateLabel(item),
    title: item.title === '' ? KIND_LABELS[item.kind] : item.title,
    meta: materialMeta(item, parts),
    status: status?.text ?? '',
    statusTone: status?.tone ?? '',
    printable: isPrintable(item.kind),
    pages: item.pages,
    url: materialUrl(item),
  }
}

/** New rows after the loaded ones, without repeating a kind and date already there. */
export function appendItems(
  loaded: readonly MaterialListItem[],
  page: readonly MaterialListItem[],
): MaterialListItem[] {
  const seen = new Set(loaded.map(materialKey))
  return [...loaded, ...page.filter((item) => !seen.has(materialKey(item)))]
}

export interface WeekGroup<T> {
  /** The week's Monday. */
  readonly key: string
  readonly title: string
  readonly rows: readonly T[]
}

/** 本周 / 上周 / "11月10日–16日". */
export function weekTitle(monday: string, today: string): string {
  const thisMonday = mondayOf(today)
  if (monday === thisMonday) return '本周'
  if (monday === addDays(thisMonday, -7)) return '上周'
  return rangeLabel(monday, addDays(monday, 6))
}

/**
 * Rows grouped by the week of their `date`, in the order given (newest
 * first). A digest belongs to the week of its last day.
 */
export function groupByWeek<T extends { readonly date: string }>(rows: readonly T[], today: string): WeekGroup<T>[] {
  const groups: { key: string; rows: T[] }[] = []
  for (const row of rows) {
    const key = mondayOf(row.date)
    const last = groups[groups.length - 1]
    if (last !== undefined && last.key === key) last.rows.push(row)
    else groups.push({ key, rows: [row] })
  }
  return groups.map((group) => ({ key: group.key, title: weekTitle(group.key, today), rows: group.rows }))
}

/** At most this many materials go into one PDF (docs/api-v1.md, "PDF export"). */
export const MAX_EXPORT_MATERIALS = 8

/** This week's printable materials (Monday to today), newest first, at most 8. */
export function thisWeekPrintable(items: readonly MaterialListItem[], today: string): MaterialListItem[] {
  const monday = mondayOf(today)
  return items
    .filter((item) => isPrintable(item.kind) && item.date >= monday && item.date <= today)
    .slice(0, MAX_EXPORT_MATERIALS)
}

const EXPORT_LABELS: Readonly<Record<PrintableKind, string>> = { daily: '每日资料', digest: '每周合集', extend: '拓展资料' }

/** A material for the export sheet: "11月24日 周二 每日资料", its pages and the cards it makes. */
export function exportMaterial(kind: PrintableKind, date: string, pages: number, words: number): ExportMaterial {
  return {
    kind,
    date,
    pages: Math.max(1, Math.floor(pages)),
    words: Math.max(0, Math.floor(words)),
    label: `${materialDateLabel({ kind, date })} ${EXPORT_LABELS[kind]}`,
  }
}

/** A list row for the export sheet; null for a report (no PDF). */
export function exportMaterialOf(item: MaterialListItem): ExportMaterial | null {
  if (!isPrintable(item.kind)) return null
  const { counts } = item
  return exportMaterial(item.kind, item.date, item.pages, counts.words + counts.phrases + counts.items)
}

// ---- today's review ----

export const SCOPES: readonly ReviewScope[] = ['all', 'notes', 'stars3']

const SCOPE_LABELS: Readonly<Record<ReviewScope, string>> = { all: '全部到期', notes: '只复习笔记本', stars3: '3 星以上' }

export const isReviewScope = (value: unknown): value is ReviewScope =>
  typeof value === 'string' && (SCOPES as readonly string[]).includes(value)

export interface ScopeChip {
  readonly id: ReviewScope
  readonly label: string
  readonly checked: boolean
}

/** "全部到期 18" · "只复习笔记本 7" · "3 星以上 9". */
export function scopeChips(due: DueByScope, chosen: ReviewScope): ScopeChip[] {
  return SCOPES.map((id) => ({ id, label: `${SCOPE_LABELS[id]} ${due[id]}`, checked: id === chosen }))
}

/** The start button for a scope; empty when there is nothing to review in it. */
export function startLabel(scope: ReviewScope, count: number): string {
  if (count <= 0) return ''
  if (scope === 'notes') return `复习笔记本 · ${count} 张`
  if (scope === 'stars3') return `复习 3 星以上 · ${count} 张`
  return `开始复习 · ${count} 张`
}

export type TodayMode = 'due' | 'finished' | 'idle'

export interface TodayView {
  readonly mode: TodayMode
  /** 今天要复习 · 连续 5 天 */
  readonly caption: string
  readonly due: number
  /** 张 · 约 6 分钟 */
  readonly dueUnit: string
  readonly done: number
  /** Share done in %, for `.meter-fill`. */
  readonly meterPct: number
  readonly meterLabel: string
}

export function todayView(review: LearnSummary['review']): TodayView {
  const due = Math.max(0, review.dueByScope.all)
  const done = Math.max(0, review.doneToday)
  const mode: TodayMode = due > 0 ? 'due' : done > 0 ? 'finished' : 'idle'
  const streak = review.streakDays > 0 ? ` · 连续 ${review.streakDays} 天` : ''
  const total = due + done
  return {
    mode,
    caption: `${mode === 'due' ? '今天要复习' : '今天的复习'}${streak}`,
    due,
    dueUnit: review.estimatedMinutes > 0 && due > 0 ? `张 · 约 ${review.estimatedMinutes} 分钟` : '张',
    done,
    meterPct: total === 0 ? 0 : Math.round((done / total) * 100),
    meterLabel: `今天已完成 ${done} 张，还剩 ${due} 张`,
  }
}

// ---- 学习计划 summary ----

export interface PlanLine {
  readonly materialFrequency: MaterialFrequency
  readonly materialWeekday: number
  readonly extendEnabled: boolean
  readonly reminderHour: number | null
}

/** "每天出资料 · 拓展每周一份 · 21:00 提醒复习". */
export function planSummary(plan: PlanLine): string {
  const material =
    plan.materialFrequency === 'daily'
      ? '每天出资料'
      : plan.materialFrequency === 'weekly'
        ? `每${WEEKDAYS[plan.materialWeekday] ?? '周一'}出合集`
        : '周期资料已关闭'
  return [
    material,
    plan.extendEnabled ? '拓展每周一份' : '',
    plan.reminderHour === null ? '' : `${plan.reminderHour}:00 提醒复习`,
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

/** The 学习资料 empty state, after the plan. */
export function noMaterialsText(frequency: MaterialFrequency): string {
  if (frequency === 'off') return '周期资料已关闭。可以在学习计划里打开。'
  if (frequency === 'weekly') return '每周一份合集，整理这 7 天查过的词句和复习时忘过的。'
  return '每天早上 5 点，前一天查过的词句会整理成一份资料。'
}
