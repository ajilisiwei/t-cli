/**
 * The 翻译 page's view model: data shapes, empty states, layout constants and
 * small helpers that read the window or the input. Page-local; the page
 * (index.ts) owns the behaviour.
 */
import type { ExplanationRow, MarkedSegment } from '../../lib/check-changes'
import { SHEET_MAX_SHARE, type SheetPhrase, type SheetSense } from '../../lib/lookup-view'
import type { WordHeadline } from '../../lib/output'
import type { ResultStatus } from '../../lib/result'
import type { SpeechPhase } from '../../lib/speaker'
import type { LookupText } from '../../lib/tokens'
import type { Direction } from '../../lib/types'
import { cachedSettings } from '../../services/settings'
import { currentTheme, type Theme } from '../../services/theme'
import { detectSourceLang } from '../../vendor/core/detect'

export type Task = 'translate' | 'check'

// A complete first line of a check: the corrected text can be diffed.
export const FIRST_LINE_DONE_RE = /\S[^\n]*\n/
export const COMPOSER_MAX_LINES = 8
export const SOURCE_MAX_LINES = 6
/** The 原文 block's type (index.wxss .tokens): font size in rpx and line height. */
export const SOURCE_FONT_RPX = 34
export const SOURCE_LINE_HEIGHT = 1.7
/** Space kept between a tapped word and the sheet. */
export const REVEAL_MARGIN_PX = 16
/** Heights of the inline action row and the docked bar (index.wxss), for docking without flapping. */
export const INLINE_BAR_PX = 72
export const DOCK_BAR_PX = 60
/** How often the dock is re-measured while a result streams. */
export const STREAM_MEASURE_MS = 800

export interface TokenPartView {
  text: string
  word: number
  on: boolean
}

export interface TokenChipView {
  parts: TokenPartView[]
  breaks: number
}

export interface BarView {
  busy: boolean
  /** Word results carry their speaker next to the head word. */
  showSpeak: boolean
  canSpeak: boolean
  speakPhase: SpeechPhase
  /** "2/9" while a long text is read in parts. */
  progress: string
  canCopy: boolean
  copyLabel: string
  canNote: boolean
  noteStars: number
  docked: boolean
}

export interface SheetData {
  state: 'loading' | 'ready' | 'error'
  title: string
  ipa: string
  asWritten: string
  meaning: string
  phrase: SheetPhrase | null
  senses: SheetSense[]
  errorText: string
  canRetry: boolean
  headNote: boolean
  headStars: number
  phraseNote: boolean
  phraseStars: number
}

export interface ResultData {
  task: Task
  status: ResultStatus
  busy: boolean
  errorText: string
  /** "纠错 · 2 处修改", "英文 → 中文 · 3 段". */
  meta: string
  headline: WordHeadline | null
  /** '' | 'long' | 'xlong': smaller type for long head words. */
  headSize: string
  wordLink: string
  text: string
  english: boolean
  /** The English side, split for tap-to-look-up. */
  tokens: TokenChipView[]
  /** The tokens are the output (Chinese → English) or the 原文 block (English → Chinese). */
  outputTokens: boolean
  sourceTokens: boolean
  lookupOn: boolean
  sourceClamped: boolean
  sourceCollapsible: boolean
  sourceLines: number
  corrected: string
  pending: string
  segments: MarkedSegment[]
  rows: ExplanationRow[]
  hiddenRows: number
  rowsCollapsible: boolean
  rowsExpanded: boolean
}

export interface TranslateData extends ResultData {
  theme: Theme
  input: string
  focus: boolean
  focused: boolean
  /** After a submit the composer shows two lines; a tap opens it again. */
  collapsed: boolean
  /** More than eight lines: the box stops growing and scrolls. */
  tall: boolean
  counter: string
  canSubmit: boolean
  canCheck: boolean
  inputEnglish: boolean
  showDirection: boolean
  dirFrom: string
  dirTo: string
  dirAria: string
  voiceEnabled: boolean
  recording: boolean
  bar: BarView
  docked: boolean
  sheetOpen: boolean
  sheetHeight: number
  sheet: SheetData
  /** 单词释义 朗读 button (the word read from the shared lexicon). */
  sheetSpeakPhase: SpeechPhase
  scrollTop: number
}

export type Rect = WechatMiniprogram.BoundingClientRectCallbackResult

export const EMPTY_SHEET: SheetData = {
  state: 'loading',
  title: '',
  ipa: '',
  asWritten: '',
  meaning: '',
  phrase: null,
  senses: [],
  errorText: '',
  canRetry: true,
  headNote: false,
  headStars: 0,
  phraseNote: false,
  phraseStars: 0,
}

export const EMPTY_BAR: BarView = {
  busy: false,
  showSpeak: true,
  canSpeak: false,
  speakPhase: 'idle',
  progress: '',
  canCopy: false,
  copyLabel: '复制',
  canNote: false,
  noteStars: 0,
  docked: false,
}

/** Everything a result shows, cleared (the task stays). */
export const EMPTY_RESULT: Omit<ResultData, 'task' | 'status' | 'busy' | 'errorText' | 'rowsExpanded'> = {
  meta: '',
  headline: null,
  headSize: '',
  wordLink: '',
  text: '',
  english: false,
  tokens: [],
  outputTokens: false,
  sourceTokens: false,
  lookupOn: false,
  sourceClamped: true,
  sourceCollapsible: false,
  sourceLines: 0,
  corrected: '',
  pending: '',
  segments: [],
  rows: [],
  hiddenRows: 0,
  rowsCollapsible: false,
}

export const windowInfo = (): { width: number; height: number } => {
  try {
    const info = wx.getWindowInfo()
    return { width: info.windowWidth, height: info.windowHeight }
  } catch {
    return { width: 375, height: 667 }
  }
}

export const sheetHeightPx = (): number => Math.round(windowInfo().height * SHEET_MAX_SHARE)
export const sourceLinePx = (): number => (SOURCE_FONT_RPX * SOURCE_LINE_HEIGHT * windowInfo().width) / 750
export const showDirectionSetting = (): boolean => cachedSettings().showDirection === true

export const headSizeOf = (head: string): string => (head.length > 24 ? 'xlong' : head.length > 14 ? 'long' : '')

export const chipViews = (lookup: LookupText): TokenChipView[] =>
  lookup.chips.map((chip) => ({
    parts: chip.parts.map((part) => ({ text: part.text, word: part.word, on: false })),
    breaks: chip.breaks,
  }))

/** The translate direction of `input` when the user has not chosen one. Empty → 中文 to 英文. */
export const autoDirection = (input: string): Direction =>
  input.trim() === '' || detectSourceLang(input) === 'zh' ? 'toEn' : 'toZh'

export const directionView = (input: string, direction: Direction): Pick<TranslateData, 'dirFrom' | 'dirTo' | 'dirAria'> =>
  direction === 'toEn'
    ? { dirFrom: '中文', dirTo: '英文', dirAria: '翻译方向：中文到英文，点按切换' }
    : {
        dirFrom: input.trim() !== '' && detectSourceLang(input) === 'other' ? '外语' : '英文',
        dirTo: '中文',
        dirAria: '翻译方向：译成中文，点按切换',
      }

export const isScrollContext = (node: unknown): node is WechatMiniprogram.ScrollViewContext =>
  typeof node === 'object' && node !== null && typeof (node as { scrollTo?: unknown }).scrollTo === 'function'

export const initialData: TranslateData = {
  theme: currentTheme(),
  input: '',
  focus: true,
  focused: false,
  collapsed: false,
  tall: false,
  counter: '',
  canSubmit: false,
  canCheck: false,
  inputEnglish: false,
  showDirection: false,
  ...directionView('', 'toEn'),
  voiceEnabled: false,
  recording: false,
  task: 'translate',
  status: 'idle',
  busy: false,
  errorText: '',
  rowsExpanded: false,
  ...EMPTY_RESULT,
  bar: EMPTY_BAR,
  docked: false,
  sheetOpen: false,
  sheetHeight: 0,
  sheet: EMPTY_SHEET,
  sheetSpeakPhase: 'idle',
  scrollTop: 0,
}
