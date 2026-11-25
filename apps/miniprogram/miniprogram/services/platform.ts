/**
 * Facts about where this build runs: environment, server, device.
 */
import { devLoginCode, resolveApiBaseUrl, type EnvVersion, type LocalOverrides } from '../lib/env'

export function envVersion(): EnvVersion {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion
  } catch {
    return 'release'
  }
}

let overrides: LocalOverrides | null = null

/**
 * `config.local.ts` (git-ignored, copied from `config.local.example.ts`) holds
 * machine-specific development settings. It may not exist, so it is loaded
 * with a guarded `require` — and only in the develop environment: trial and
 * release builds never read it.
 */
function localOverrides(): LocalOverrides {
  if (overrides !== null) return overrides
  overrides = {}
  if (envVersion() !== 'develop') return overrides
  try {
    const loaded: unknown = require('../config.local')
    const value =
      typeof loaded === 'object' && loaded !== null ? (loaded as { LOCAL_OVERRIDES?: unknown }).LOCAL_OVERRIDES : undefined
    if (typeof value === 'object' && value !== null) overrides = value as LocalOverrides
  } catch {
    // No config.local.ts: defaults apply.
  }
  return overrides
}

export function apiBaseUrl(): string {
  return resolveApiBaseUrl(envVersion(), localOverrides())
}

/** `dev:<name>` for a local server with `WECHAT_DEV_LOGIN=1`, else null (use `wx.login`). */
export function devLogin(): string | null {
  return devLoginCode(envVersion(), localOverrides())
}

/** Shown in 我的 → 设备 and on the server: "iPhone 15", "HUAWEI Mate 60". */
export function deviceName(): string {
  try {
    const info = wx.getDeviceInfo()
    const name = `${info.brand ?? ''} ${info.model ?? ''}`.replace(/\s+/g, ' ').trim()
    return (name === '' ? '微信小程序' : name).slice(0, 64)
  } catch {
    return '微信小程序'
  }
}

/** The device's offset from UTC in minutes, as the AI proxy expects (+480 in China). */
export function utcOffsetMinutes(): number {
  return -new Date().getTimezoneOffset()
}

/** Height of the home indicator area below the safe area, in px (docked bars pad by it). */
export function safeBottomInset(): number {
  try {
    const info = wx.getWindowInfo()
    return info.safeArea ? Math.max(0, info.screenHeight - info.safeArea.bottom) : 0
  } catch {
    return 0
  }
}
