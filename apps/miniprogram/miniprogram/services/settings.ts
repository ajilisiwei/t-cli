/**
 * The explanation language (设置 → 解释语言), synced with the account so the
 * CLI and the mini-program agree. Cached locally: requests send it as `lang`
 * without waiting for `GET /v1/me`.
 */
import type { ExplanationLang, Settings } from '../lib/types'
import { fetchMe, updateSettings } from './endpoints'
import { STORAGE_KEYS, readStorage, writeStorage } from './storage'

const DEFAULT_LANG: ExplanationLang = 'zh'

export function explanationLang(): ExplanationLang {
  const cached = readStorage(STORAGE_KEYS.settings)
  if (typeof cached === 'object' && cached !== null) {
    const lang = (cached as Settings).explanationLang
    if (lang === 'zh' || lang === 'en') return lang
  }
  return DEFAULT_LANG
}

const remember = (settings: Settings): ExplanationLang => {
  writeStorage(STORAGE_KEYS.settings, settings)
  return settings.explanationLang ?? DEFAULT_LANG
}

/** Re-reads the account's settings; the cached value stays on failure. */
export async function refreshSettings(): Promise<ExplanationLang> {
  const me = await fetchMe()
  return remember(me.settings)
}

export async function setExplanationLang(lang: ExplanationLang): Promise<ExplanationLang> {
  return remember(await updateSettings({ explanationLang: lang }))
}
