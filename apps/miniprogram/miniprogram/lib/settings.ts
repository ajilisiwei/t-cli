/**
 * Account settings: defaults and the local-first sync rules (docs/api-v1.md,
 * "v2 → Settings"; the CLI does the same for explanationLang in
 * apps/cli/src/sync/settingsSync.js).
 *
 *  - A change is applied to the local copy at once and queued as pending.
 *  - A push sends the pending keys; when it succeeds, the keys whose pending
 *    value is still the one sent leave the queue (a newer change stays).
 *  - When the account's settings arrive (start-up, after login, the answer
 *    of a push), keys with a pending change keep the local value, the others
 *    take the account's value, and keys the account lacks keep the local one
 *    (an absent value is the server's default, never an override).
 *
 * Pure: no `wx`, no storage; services/settings.ts does the I/O.
 */
import type {
  Accent,
  ExplanationLang,
  ExtendTopic,
  MaterialFrequency,
  MaterialPart,
  MutedTopic,
  Settings,
  StudyLevelSetting,
  ThemeChoice,
  ThemeMode,
} from './types'

/** Every setting with its default applied. */
export interface EffectiveSettings {
  readonly explanationLang: ExplanationLang
  readonly autoSpeakWord: boolean
  readonly autoSpeakOnFlip: boolean
  readonly reminderHour: number | null
  readonly showDirection: boolean
  readonly accent: Accent
  readonly themeMode: ThemeMode
  readonly themeFixed: ThemeChoice
  readonly themeDayStart: string
  readonly themeNightStart: string
  readonly readingMode: boolean
  readonly readingFontStep: number
  readonly importanceReview: boolean
  readonly materialFrequency: MaterialFrequency
  readonly materialWeekday: number
  readonly materialParts: readonly MaterialPart[]
  readonly extendEnabled: boolean
  readonly extendTopics: readonly ExtendTopic[]
  readonly extendMuted: readonly MutedTopic[]
  readonly studyLevel: StudyLevelSetting
}

/** Every 周期资料 part, in the order the clients show them. */
export const MATERIAL_PARTS: readonly MaterialPart[] = ['words', 'phrases', 'grammar', 'story', 'exercises']

export const SETTING_DEFAULTS: EffectiveSettings = {
  explanationLang: 'zh',
  autoSpeakWord: true,
  autoSpeakOnFlip: true,
  reminderHour: null,
  showDirection: false,
  accent: 'indigo',
  themeMode: 'system',
  themeFixed: 'light',
  themeDayStart: '07:00',
  themeNightStart: '19:00',
  readingMode: false,
  readingFontStep: 0,
  importanceReview: true,
  materialFrequency: 'daily',
  materialWeekday: 1,
  materialParts: MATERIAL_PARTS,
  extendEnabled: true,
  extendTopics: [],
  extendMuted: [],
  studyLevel: 'auto',
}

const ACCENTS: readonly Accent[] = ['indigo', 'pine', 'plum', 'ochre', 'ink']
const THEME_MODES: readonly ThemeMode[] = ['system', 'time', 'fixed']
const CLOCK_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const FREQUENCIES: readonly MaterialFrequency[] = ['daily', 'weekly', 'off']
const LEVELS: readonly StudyLevelSetting[] = ['auto', 'A2', 'B1', 'B2', 'C1']

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fallback

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

const isIntIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

const int = (value: unknown, min: number, max: number, fallback: number): number =>
  isIntIn(value, min, max) ? value : fallback

/** null is a value (reminders off), not an absent one. */
const hourOrOff = (value: unknown, fallback: number | null): number | null =>
  value === null ? null : isIntIn(value, 0, 23) ? value : fallback

const clock = (value: unknown, fallback: string): string =>
  typeof value === 'string' && CLOCK_RE.test(value) ? value : fallback

/** A list read from storage or the account (lib/wire.ts checked its entries); the default unless non-empty when required. */
const list = <T>(value: readonly T[] | undefined, fallback: readonly T[], nonEmpty: boolean): readonly T[] =>
  Array.isArray(value) && (!nonEmpty || value.length > 0) ? value : fallback

/** `settings` with defaults for absent or malformed values. */
export function effectiveSettings(settings: Settings): EffectiveSettings {
  const d = SETTING_DEFAULTS
  return {
    explanationLang: oneOf<ExplanationLang>(['zh', 'en'], settings.explanationLang, d.explanationLang),
    autoSpeakWord: bool(settings.autoSpeakWord, d.autoSpeakWord),
    autoSpeakOnFlip: bool(settings.autoSpeakOnFlip, d.autoSpeakOnFlip),
    reminderHour: hourOrOff(settings.reminderHour, d.reminderHour),
    showDirection: bool(settings.showDirection, d.showDirection),
    accent: oneOf(ACCENTS, settings.accent, d.accent),
    themeMode: oneOf(THEME_MODES, settings.themeMode, d.themeMode),
    themeFixed: oneOf<ThemeChoice>(['light', 'dark'], settings.themeFixed, d.themeFixed),
    themeDayStart: clock(settings.themeDayStart, d.themeDayStart),
    themeNightStart: clock(settings.themeNightStart, d.themeNightStart),
    readingMode: bool(settings.readingMode, d.readingMode),
    readingFontStep: int(settings.readingFontStep, 0, 3, d.readingFontStep),
    importanceReview: bool(settings.importanceReview, d.importanceReview),
    materialFrequency: oneOf(FREQUENCIES, settings.materialFrequency, d.materialFrequency),
    materialWeekday: int(settings.materialWeekday, 0, 6, d.materialWeekday),
    materialParts: list(settings.materialParts, d.materialParts, true),
    extendEnabled: bool(settings.extendEnabled, d.extendEnabled),
    extendTopics: list(settings.extendTopics, d.extendTopics, false),
    extendMuted: list(settings.extendMuted, d.extendMuted, false),
    studyLevel: oneOf(LEVELS, settings.studyLevel, d.studyLevel),
  }
}

/** The local copy and the changes not yet confirmed by the account. */
export interface LocalSettings {
  readonly settings: Settings
  readonly pending: Settings
}

export const hasPending = (pending: Settings): boolean => Object.keys(pending).length > 0

/** A local change: applied at once and queued for the account. */
export function applyLocalChange(local: LocalSettings, patch: Settings): LocalSettings {
  return {
    settings: { ...local.settings, ...patch },
    pending: { ...local.pending, ...patch },
  }
}

/**
 * Values compare by content: lists (materialParts, extendMuted, …) come back
 * from storage as new arrays, so identity would never match.
 */
const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/** After `sent` was saved to the account: drops the keys whose pending value is still the one sent. */
export function settlePushed(pending: Settings, sent: Settings): Settings {
  const sentValues = new Map<string, unknown>(Object.entries(sent))
  const kept = Object.entries(pending).filter(([key, value]) => !sentValues.has(key) || !sameValue(sentValues.get(key), value))
  return Object.fromEntries(kept) as Settings
}

/** The account's settings arrived: pending keys keep the local value, the rest take the account's. */
export function mergeAccount(local: LocalSettings, account: Settings): Settings {
  return { ...local.settings, ...account, ...local.pending }
}

/** What a failed push did to the queue: only a rejected body (400 / 422) is dropped, so it is not resent forever. */
export interface PushFailure {
  readonly kind: string
  readonly status: number | null
}

export function keepsPending(failure: PushFailure): boolean {
  return !(failure.kind === 'http' && (failure.status === 400 || failure.status === 422))
}
