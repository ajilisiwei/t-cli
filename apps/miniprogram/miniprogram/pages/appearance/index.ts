/**
 * 我的 → 外观: 深浅模式 (跟随系统 / 跟随时间 / 固定) and 阅读模式 with its 字号,
 * above a live preview card. Only the 宣纸 paper ships (docs/v2-plan.html,
 * section 1): light is 宣纸, dark is 墨夜.
 *
 * Every change is a local-first setting (services/settings.ts): the page —
 * and the whole app — switch at once; the account is updated in the
 * background. The preview shows the current theme; its 浅色 / 深色 chips peek
 * at the other one without changing anything.
 */
import {
  READING_STEPS,
  THEME_CHOICE_LABELS,
  THEME_MODE_LABELS,
  clampFontStep,
  clockLabel,
  clockMinutes,
  dayBar,
  fontStepLabel,
  readingType,
  type ThemeRule,
} from '../../lib/appearance'
import { PALETTES, iconPath, paletteFor, type Theme } from '../../lib/palette'
import type { EffectiveSettings } from '../../lib/settings'
import type { Accent, ThemeChoice, ThemeMode } from '../../lib/types'
import { changeSettings, currentSettings, watchSettings } from '../../services/settings'
import { currentLook, watchLook, type Look } from '../../services/theme'

const MODES: readonly ThemeMode[] = ['system', 'time', 'fixed']
const CHOICES: readonly ThemeChoice[] = ['light', 'dark']
const PAPER_NAMES: Readonly<Record<Theme, string>> = { light: '宣纸', dark: '墨夜' }

interface Option<T extends string> {
  value: T
  label: string
  on: boolean
}

interface BarSegment {
  kind: string
  style: string
}

interface PreviewView {
  previewTheme: Theme
  previewName: string
  previewChips: Option<Theme>[]
  cardStyle: string
  mutedStyle: string
  accentStyle: string
  softStyle: string
  wordStyle: string
  bodyStyle: string
  speakerIcon: string
  bookmarkIcon: string
}

interface SettingsView {
  mode: ThemeMode
  modes: Option<ThemeMode>[]
  fixedOptions: Option<ThemeChoice>[]
  dayStart: string
  nightStart: string
  dayStartLabel: string
  nightStartLabel: string
  barSegments: BarSegment[]
  nowStyle: string
  readingMode: boolean
  fontStep: number
  fontDots: { n: number; on: boolean }[]
  fontStepText: string
  canShrink: boolean
  canGrow: boolean
}

interface AppearanceData extends SettingsView, PreviewView {
  theme: Theme
  accent: Accent
  accentClass: string
}

const options = <T extends string>(values: readonly T[], labels: Readonly<Record<T, string>>, chosen: T): Option<T>[] =>
  values.map((value) => ({ value, label: labels[value], on: value === chosen }))

const ruleOf = (s: EffectiveSettings): ThemeRule => ({
  mode: s.themeMode,
  fixed: s.themeFixed,
  dayStart: s.themeDayStart,
  nightStart: s.themeNightStart,
})

const settingsView = (s: EffectiveSettings): SettingsView => {
  const bar = dayBar(ruleOf(s), new Date())
  const step = clampFontStep(s.readingFontStep)
  return {
    mode: s.themeMode,
    modes: options(MODES, THEME_MODE_LABELS, s.themeMode),
    fixedOptions: options(CHOICES, THEME_CHOICE_LABELS, s.themeFixed),
    dayStart: s.themeDayStart,
    nightStart: s.themeNightStart,
    dayStartLabel: clockLabel(s.themeDayStart),
    nightStartLabel: clockLabel(s.themeNightStart),
    barSegments: bar.segments.map(({ kind, share }) => ({
      kind,
      style: `flex: ${share}; background-color: ${PALETTES[kind === 'day' ? 'light' : 'dark'].bg};`,
    })),
    nowStyle: `left: ${bar.now}%;`,
    readingMode: s.readingMode,
    fontStep: step,
    fontDots: Array.from({ length: READING_STEPS }, (_, n) => ({ n, on: n <= step })),
    fontStepText: fontStepLabel(step),
    canShrink: s.readingMode && step > 0,
    canGrow: s.readingMode && step < READING_STEPS - 1,
  }
}

/** The preview card in `theme` with the current accent and type sizes (inline styles: it may show the other theme). */
const previewView = (theme: Theme, accent: Accent, s: EffectiveSettings): PreviewView => {
  const p = paletteFor(theme, accent)
  const type = readingType(s.readingMode, s.readingFontStep)
  return {
    previewTheme: theme,
    previewName: `预览 · ${PAPER_NAMES[theme]}`,
    previewChips: options(CHOICES, THEME_CHOICE_LABELS, theme),
    cardStyle: `background-color: ${p.bg}; border-color: ${p.rule}; color: ${p.ink};`,
    mutedStyle: `color: ${p.muted};`,
    accentStyle: `color: ${p.accent};`,
    softStyle: `background-color: ${p.accentSoft};`,
    wordStyle: `font-size: ${type.word}rpx;`,
    bodyStyle: `font-size: ${type.body}rpx; line-height: ${type.lineHeight};`,
    speakerIcon: iconPath('speaker', 'accent', theme, accent),
    bookmarkIcon: iconPath('bookmark-filled', 'accent', theme, accent),
  }
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)

type TapEvent<K extends string> = WechatMiniprogram.BaseEvent<Record<string, never>, Partial<Record<K, string>>>

const initialLook = currentLook()
const initialSettings = currentSettings()

const initialData: AppearanceData = {
  ...initialLook,
  ...settingsView(initialSettings),
  ...previewView(initialLook.theme, initialLook.accent, initialSettings),
}

Page({
  data: initialData,
  stopWatching: [] as (() => void)[],

  onLoad() {
    // A new look (this page's own changes included) shows the preview in the theme now in force.
    const onLook = (look: Look): void =>
      this.setData({ ...look, ...previewView(look.theme, look.accent, currentSettings()) })
    const onSettings = (s: EffectiveSettings): void =>
      this.setData({ ...settingsView(s), ...previewView(this.data.previewTheme, this.data.accent, s) })
    this.stopWatching = [watchLook(onLook), watchSettings(onSettings)]
    onLook(currentLook())
    this.setData(settingsView(currentSettings()))
  },

  onShow() {
    // The "now" marker of the day bar.
    this.setData(settingsView(currentSettings()))
  },

  onUnload() {
    for (const stop of this.stopWatching) stop()
    this.stopWatching = []
  },

  onMode(event: TapEvent<'mode'>) {
    const mode = event.currentTarget.dataset.mode
    if (!isOneOf(MODES, mode) || mode === currentSettings().themeMode) return
    changeSettings({ themeMode: mode })
  },

  onFixed(event: TapEvent<'value'>) {
    const value = event.currentTarget.dataset.value
    if (!isOneOf(CHOICES, value) || value === currentSettings().themeFixed) return
    changeSettings({ themeFixed: value })
  },

  onDayStart(event: WechatMiniprogram.PickerChange) {
    const clock = String(event.detail.value)
    if (clockMinutes(clock) === null || clock === currentSettings().themeDayStart) return
    changeSettings({ themeDayStart: clock })
  },

  onNightStart(event: WechatMiniprogram.PickerChange) {
    const clock = String(event.detail.value)
    if (clockMinutes(clock) === null || clock === currentSettings().themeNightStart) return
    changeSettings({ themeNightStart: clock })
  },

  onPreview(event: TapEvent<'value'>) {
    const theme = event.currentTarget.dataset.value
    if (!isOneOf(CHOICES, theme) || theme === this.data.previewTheme) return
    this.setData(previewView(theme, this.data.accent, currentSettings()))
  },

  onReading() {
    changeSettings({ readingMode: !currentSettings().readingMode })
  },

  onFontStep(event: TapEvent<'delta'>) {
    const s = currentSettings()
    if (!s.readingMode) return
    const step = clampFontStep(s.readingFontStep + Number(event.currentTarget.dataset.delta))
    if (step !== s.readingFontStep) changeSettings({ readingFontStep: step })
  },
})
