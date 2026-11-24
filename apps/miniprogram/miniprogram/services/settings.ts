/**
 * Account settings (设置), local-first and synced with the account so the CLI
 * and the mini-program agree (rules: lib/settings.ts; contract: docs/api-v1.md,
 * "v2 → Settings").
 *
 *  - `changeSettings` writes the change to the local copy and to the pending
 *    queue at once (pages read it synchronously), then pushes it with
 *    `POST /v1/me/settings`. Offline, it stays pending.
 *  - `syncSettings` (at launch, after login, when the network returns, on
 *    return to the foreground at most every 30 s) pushes what is pending and
 *    then pulls `GET /v1/me`: pending keys keep the local value, the others
 *    take the account's.
 *
 * Both are single-flight and quiet: failures are logged, never thrown.
 */
import { isApiError } from '../lib/api'
import {
  applyLocalChange,
  effectiveSettings,
  hasPending,
  keepsPending,
  mergeAccount,
  settlePushed,
  type EffectiveSettings,
  type LocalSettings,
} from '../lib/settings'
import type { Accent, ExplanationLang, Settings, ThemeChoice, ThemeMode } from '../lib/types'
import { readSettings } from '../lib/wire'
import { fetchMe, updateSettings } from './endpoints'
import { hasSession } from './session'
import { STORAGE_KEYS, readStorage, writeStorage } from './storage'

export type { EffectiveSettings }

/** Read from storage each time (cheap; services/theme.ts keeps its own resolved copy). */
const load = (): LocalSettings => ({
  settings: readSettings(readStorage(STORAGE_KEYS.settings)),
  pending: readSettings(readStorage(STORAGE_KEYS.settingsPending)),
})

type SettingsListener = (settings: EffectiveSettings) => void

const listeners = new Set<SettingsListener>()

const sameEffective = (a: Settings, b: Settings): boolean =>
  JSON.stringify(effectiveSettings(a)) === JSON.stringify(effectiveSettings(b))

const commit = (previous: Settings, next: LocalSettings): void => {
  writeStorage(STORAGE_KEYS.settings, next.settings)
  writeStorage(STORAGE_KEYS.settingsPending, next.pending)
  if (sameEffective(previous, next.settings)) return
  const current = effectiveSettings(next.settings)
  for (const listener of listeners) listener(current)
}

/** Calls `listener` whenever a setting's effective value changes; returns the unsubscribe function. */
export function watchSettings(listener: SettingsListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ---- reading ----

/** The cached settings as stored (absent keys = defaults). */
export function cachedSettings(): Settings {
  return load().settings
}

/** Every setting, defaults applied. */
export function currentSettings(): EffectiveSettings {
  return effectiveSettings(cachedSettings())
}

/** 释义语言 (default zh). */
export const explanationLang = (): ExplanationLang => currentSettings().explanationLang
/** 查单词后自动朗读 (default on). */
export const autoSpeakWord = (): boolean => currentSettings().autoSpeakWord
/** 复习翻面自动朗读 (default on). */
export const autoSpeakOnFlip = (): boolean => currentSettings().autoSpeakOnFlip
/** 复习提醒时间 (local hour), null = off. */
export const reminderHour = (): number | null => currentSettings().reminderHour
/** 显示翻译方向按钮 (default off). */
export const showDirection = (): boolean => currentSettings().showDirection
/** 主题色 (default indigo). */
export const accent = (): Accent => currentSettings().accent
/** 深浅模式 (default system). */
export const themeMode = (): ThemeMode => currentSettings().themeMode
/** The theme of 深浅模式「固定」 (default light). */
export const themeFixed = (): ThemeChoice => currentSettings().themeFixed
/** "HH:MM": 跟随时间 turns light here (default 07:00). */
export const themeDayStart = (): string => currentSettings().themeDayStart
/** "HH:MM": 跟随时间 turns dark here (default 19:00). */
export const themeNightStart = (): string => currentSettings().themeNightStart
/** 阅读模式 (default off). */
export const readingMode = (): boolean => currentSettings().readingMode
/** 阅读模式 font size step 0–3 (default 0). */
export const readingFontStep = (): number => currentSettings().readingFontStep
/** 按重要程度安排复习 (default on). */
export const importanceReview = (): boolean => currentSettings().importanceReview

// ---- writing and sync ----

/** Local changes since start-up: a pull that raced one is dropped (the change's own push answered). */
let changeCount = 0
let pushing: Promise<void> | null = null
let pushAgain = false

const errorCode = (error: unknown): unknown => (isApiError(error) ? error.code : error)

/** One push of everything pending; the answer (the account's full settings) is merged in. */
const pushOnce = async (): Promise<void> => {
  const sent = load().pending
  if (!hasPending(sent) || !hasSession()) return
  try {
    const account = await updateSettings(sent)
    const now = load()
    const pending = settlePushed(now.pending, sent)
    commit(now.settings, { settings: mergeAccount({ settings: now.settings, pending }, account), pending })
  } catch (error: unknown) {
    if (isApiError(error) && !keepsPending(error)) {
      // Rejected as invalid: resending would fail forever. The value stays on this phone.
      const now = load()
      commit(now.settings, { settings: now.settings, pending: settlePushed(now.pending, sent) })
      console.warn('[settings] the account rejected a change', error.code)
      return
    }
    // Offline or a server error: no retry loop; the network's return or the next start sends it.
    pushAgain = false
    console.warn('[settings] saving to the account failed; kept for later', errorCode(error))
  }
}

/** Pushes pending changes (single-flight; a change made meanwhile is sent right after). */
export function flushSettings(): Promise<void> {
  if (pushing !== null) {
    pushAgain = true
    return pushing
  }
  pushing = (async () => {
    do {
      pushAgain = false
      await pushOnce()
    } while (pushAgain)
  })().finally(() => {
    pushing = null
  })
  return pushing
}

/**
 * Changes settings on this phone: in force at once, saved to the account in
 * the background (or later, when offline). Returns the new local settings.
 */
export function changeSettings(patch: Settings): Settings {
  changeCount += 1
  const now = load()
  const next = applyLocalChange(now, patch)
  commit(now.settings, next)
  void flushSettings()
  return next.settings
}

let syncing: Promise<void> | null = null
let lastSyncAt = 0
const RESYNC_MIN_MS = 30_000

const runSync = async (): Promise<void> => {
  if (!hasSession()) return
  lastSyncAt = Date.now()
  await flushSettings()
  const changesBefore = changeCount
  try {
    const me = await fetchMe()
    if (changeCount !== changesBefore) return
    const now = load()
    commit(now.settings, { settings: mergeAccount(now, me.settings), pending: now.pending })
  } catch (error: unknown) {
    console.warn('[settings] reading the account failed', errorCode(error))
  }
}

/** Start-up / after login: push pending changes, then take the account's values for the rest. Never throws. */
export function syncSettings(): Promise<void> {
  syncing ??= runSync().finally(() => {
    syncing = null
  })
  return syncing
}

/** `syncSettings` unless one ran in the last 30 s (page shows, foreground). */
export function syncSettingsSoon(): void {
  if (Date.now() - lastSyncAt >= RESYNC_MIN_MS) void syncSettings()
}

let started = false

/** At launch: sync again when the network returns and when the app comes back to the foreground. */
export function startSettingsSync(): void {
  if (started) return
  started = true
  wx.onNetworkStatusChange((result) => {
    if (result.isConnected) void syncSettings()
  })
  wx.onAppShow(() => syncSettingsSoon())
}

// ---- compatibility (v1 callers) ----

/** Re-reads the account's settings (pending local changes win); resolves with the local copy. */
export async function refreshSettings(): Promise<Settings> {
  await syncSettings()
  return cachedSettings()
}

/** Local-first `changeSettings` as a promise. */
export async function saveSettings(patch: Settings): Promise<Settings> {
  return changeSettings(patch)
}

export async function setExplanationLang(lang: ExplanationLang): Promise<ExplanationLang> {
  changeSettings({ explanationLang: lang })
  return lang
}
