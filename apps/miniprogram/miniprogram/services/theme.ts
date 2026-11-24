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

/** Theme subscriptions of mounted components (component instances take no typed custom fields). */
const followers = new WeakMap<object, () => void>()

/** For components: calls `listener` on theme changes until `unfollowTheme(owner)` (in `detached`). */
export function followTheme(owner: object, listener: ThemeListener): void {
  followers.get(owner)?.()
  followers.set(owner, watchTheme(listener))
}

export function unfollowTheme(owner: object): void {
  followers.get(owner)?.()
  followers.delete(owner)
}
