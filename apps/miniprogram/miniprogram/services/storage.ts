/**
 * Local storage, the only place keys are spelled out. Reads return `unknown`:
 * whatever comes back from disk is validated by its caller.
 */

export const STORAGE_KEYS = {
  tokens: 'tcli:tokens',
  settings: 'tcli:settings',
  /** Settings changed on this phone and not yet saved to the account (services/settings.ts). */
  settingsPending: 'tcli:settings:pending',
  historyFirstPage: 'tcli:history:first',
  /** PDFs exported to this phone (services/pdf.ts, lib/export-records.ts). */
  exportRecords: 'tcli:exports',
} as const

type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS]

export function readStorage(key: StorageKey): unknown {
  try {
    const value: unknown = wx.getStorageSync(key)
    return value === '' ? null : value
  } catch {
    return null
  }
}

export function writeStorage(key: StorageKey, value: unknown): void {
  try {
    wx.setStorageSync(key, value)
  } catch (error: unknown) {
    // Storage full or unavailable: the app still works, it only forgets.
    console.warn('[storage] write failed', key, error)
  }
}

export function removeStorage(key: StorageKey): void {
  try {
    wx.removeStorageSync(key)
  } catch (error: unknown) {
    console.warn('[storage] remove failed', key, error)
  }
}
