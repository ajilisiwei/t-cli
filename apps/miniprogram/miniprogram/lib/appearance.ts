/**
 * 外观: which theme applies when (深浅模式), the 阅读模式 type sizes, and the
 * labels of the appearance settings. Rules from docs/api-v1.md, "v2 →
 * Settings". Pure: the clock comes in as a Date, the system theme as a value.
 */
import type { Theme } from './palette'
import type { Accent, ThemeChoice, ThemeMode } from './types'

export interface ThemeRule {
  readonly mode: ThemeMode
  readonly fixed: ThemeChoice
  /** "HH:MM": light from here (mode 'time'). */
  readonly dayStart: string
  /** "HH:MM": dark from here (mode 'time'). */
  readonly nightStart: string
}

const MINUTES_PER_DAY = 24 * 60
const DEFAULT_DAY_START = 7 * 60
const DEFAULT_NIGHT_START = 19 * 60
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Minutes after midnight of "HH:MM"; null when malformed. */
export function clockMinutes(clock: string): number | null {
  const match = CLOCK_RE.exec(clock)
  return match === null ? null : Number(match[1]) * 60 + Number(match[2])
}

/** "07:00" → "7:00" (labels); malformed text is returned as is. */
export function clockLabel(clock: string): string {
  const minutes = clockMinutes(clock)
  return minutes === null ? clock : `${Math.floor(minutes / 60)}:${clock.slice(3)}`
}

/** Light while `minute` is in [dayStart, nightStart), wrapping past midnight; equal times = light all day. */
export function isDaytime(minute: number, dayStart: number, nightStart: number): boolean {
  if (dayStart === nightStart) return true
  if (dayStart < nightStart) return minute >= dayStart && minute < nightStart
  return minute >= dayStart || minute < nightStart
}

const ruleMinutes = (rule: ThemeRule): { day: number; night: number } => ({
  day: clockMinutes(rule.dayStart) ?? DEFAULT_DAY_START,
  night: clockMinutes(rule.nightStart) ?? DEFAULT_NIGHT_START,
})

const minuteOfDay = (now: Date): number => now.getHours() * 60 + now.getMinutes()

/** The theme that applies now: the phone's, the time rule's, or the fixed one. */
export function resolveTheme(rule: ThemeRule, system: Theme, now: Date): Theme {
  if (rule.mode === 'fixed') return rule.fixed
  if (rule.mode === 'system') return system
  const { day, night } = ruleMinutes(rule)
  return isDaytime(minuteOfDay(now), day, night) ? 'light' : 'dark'
}

/** The next local time at `minute` after `now` (today or tomorrow). */
const nextAt = (now: Date, minute: number): number => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(minute / 60), minute % 60)
  if (today.getTime() > now.getTime()) return today.getTime()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, Math.floor(minute / 60), minute % 60).getTime()
}

/** Milliseconds until the time rule switches next; null when it never does (another mode, or equal times). */
export function msUntilThemeSwitch(rule: ThemeRule, now: Date): number | null {
  if (rule.mode !== 'time') return null
  const { day, night } = ruleMinutes(rule)
  if (day === night) return null
  return Math.min(nextAt(now, day), nextAt(now, night)) - now.getTime()
}

export interface DaySegment {
  readonly kind: 'day' | 'night'
  /** Share of the 24 hours, in percent. */
  readonly share: number
}

export interface DayBar {
  readonly segments: readonly DaySegment[]
  /** Where "now" sits on the bar, in percent. */
  readonly now: number
}

const percent = (minutes: number): number => Math.round((minutes / MINUTES_PER_DAY) * 1000) / 10

/** The 0:00–24:00 bar of the time rule: light and dark stretches, and the current time. */
export function dayBar(rule: ThemeRule, now: Date): DayBar {
  const { day, night } = ruleMinutes(rule)
  const bounds: { kind: DaySegment['kind']; from: number; to: number }[] =
    day === night
      ? [{ kind: 'day', from: 0, to: MINUTES_PER_DAY }]
      : day < night
        ? [
            { kind: 'night', from: 0, to: day },
            { kind: 'day', from: day, to: night },
            { kind: 'night', from: night, to: MINUTES_PER_DAY },
          ]
        : [
            { kind: 'day', from: 0, to: night },
            { kind: 'night', from: night, to: day },
            { kind: 'day', from: day, to: MINUTES_PER_DAY },
          ]
  return {
    segments: bounds.filter(({ from, to }) => to > from).map(({ kind, from, to }) => ({ kind, share: percent(to - from) })),
    now: percent(minuteOfDay(now)),
  }
}

// ---- labels ----

export const ACCENT_LABELS: Readonly<Record<Accent, string>> = {
  indigo: '靛青',
  pine: '松绿',
  plum: '黛紫',
  ochre: '赭石',
  ink: '墨色',
}

export const THEME_MODE_LABELS: Readonly<Record<ThemeMode, string>> = {
  system: '跟随系统',
  time: '跟随时间',
  fixed: '固定',
}

export const THEME_CHOICE_LABELS: Readonly<Record<ThemeChoice, string>> = {
  light: '浅色',
  dark: '深色',
}

/** The value of the 深浅模式 row: 跟随系统 / 跟随时间 / 固定浅色 / 固定深色. */
export function themeModeSummary(rule: ThemeRule): string {
  return rule.mode === 'fixed' ? `固定${THEME_CHOICE_LABELS[rule.fixed]}` : THEME_MODE_LABELS[rule.mode]
}

// ---- 阅读模式 ----

/** Font size steps of 阅读模式 (readingFontStep 0–3). */
export const READING_STEPS = 4

export interface ReadingType {
  /** Headword size, rpx. */
  readonly word: number
  /** Body text size, rpx. */
  readonly body: number
  readonly lineHeight: number
}

/** Without 阅读模式: the app's usual sizes (.head, .explanation). */
const NORMAL_TYPE: ReadingType = { word: 56, body: 30, lineHeight: 1.7 }

/** 阅读模式: larger type and wider lines; step 0 is its normal size. */
const READING_TYPES: readonly ReadingType[] = [
  { word: 64, body: 32, lineHeight: 1.8 },
  { word: 72, body: 34, lineHeight: 1.85 },
  { word: 80, body: 38, lineHeight: 1.9 },
  { word: 88, body: 42, lineHeight: 1.95 },
]

export const clampFontStep = (step: number): number =>
  Number.isFinite(step) ? Math.min(READING_STEPS - 1, Math.max(0, Math.round(step))) : 0

/** Type sizes for reading pages (每日短文, 单词详情). */
export function readingType(readingMode: boolean, step: number): ReadingType {
  return readingMode ? (READING_TYPES[clampFontStep(step)] ?? NORMAL_TYPE) : NORMAL_TYPE
}

/** Accessible label of the 字号 dots. */
export function fontStepLabel(step: number): string {
  return `字号第 ${clampFontStep(step) + 1} 档，共 ${READING_STEPS} 档`
}
