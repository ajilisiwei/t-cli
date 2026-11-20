/**
 * Light/dark theme following the system. Pages put `theme-{{theme}}` on their
 * root view; the colours are CSS variables in app.wxss. A class (rather than
 * `prefers-color-scheme`) works the same under Skyline and WebView.
 */

export type Theme = 'light' | 'dark'

export function currentTheme(): Theme {
  try {
    return wx.getAppBaseInfo().theme === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

type ThemeListener = (theme: Theme) => void

const listeners = new Set<ThemeListener>()
let subscribed = false

const onSystemTheme = (result: { theme: 'dark' | 'light' }): void => {
  for (const listener of listeners) listener(result.theme)
}

/** Calls `listener` on every system theme change; returns the unsubscribe function. */
export function watchTheme(listener: ThemeListener): () => void {
  listeners.add(listener)
  if (!subscribed) {
    wx.onThemeChange(onSystemTheme)
    subscribed = true
  }
  return () => {
    listeners.delete(listener)
  }
}
