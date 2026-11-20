/**
 * Account settings (设置), synced with the server so the CLI and the
 * mini-program agree. Cached locally: pages read them synchronously without
 * waiting for `GET /v1/me`. Defaults follow docs/api-v1.md ("Account").
 */
import type { ExplanationLang, Settings } from '../lib/types'
import { fetchMe, updateSettings } from './endpoints'
import { STORAGE_KEYS, readStorage, writeStorage } from './storage'

const DEFAULT_LANG: ExplanationLang = 'zh'

/** The cached settings (possibly empty). */
export function cachedSettings(): Settings {
  const cached = readStorage(STORAGE_KEYS.settings)
  return typeof cached === 'object' && cached !== null ? (cached as Settings) : {}
}

export function explanationLang(): ExplanationLang {
  const lang = cachedSettings().explanationLang
  return lang === 'zh' || lang === 'en' ? lang : DEFAULT_LANG
}

/** 单词结果自动朗读 (default on). */
export function autoSpeakWord(): boolean {
  return cachedSettings().autoSpeakWord !== false
}

/** 复习翻面自动朗读 (default on). */
export function autoSpeakOnFlip(): boolean {
  return cachedSettings().autoSpeakOnFlip !== false
}

/** 复习提醒时间 (local hour), null = off. */
export function reminderHour(): number | null {
  const hour = cachedSettings().reminderHour
  return typeof hour === 'number' ? hour : null
}

const remember = (settings: Settings): Settings => {
  writeStorage(STORAGE_KEYS.settings, settings)
  return settings
}

/** Re-reads the account's settings; the cached value stays on failure. */
export async function refreshSettings(): Promise<Settings> {
  const me = await fetchMe()
  return remember(me.settings)
}

/** Merges `patch` into the account's settings and caches the result. */
export async function saveSettings(patch: Settings): Promise<Settings> {
  return remember(await updateSettings(patch))
}

export async function setExplanationLang(lang: ExplanationLang): Promise<ExplanationLang> {
  return (await saveSettings({ explanationLang: lang })).explanationLang ?? DEFAULT_LANG
}
