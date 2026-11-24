/**
 * The look of the app: the light/dark theme (深浅模式) and the accent colour
 * (主题色), resolved from the settings and the system theme.
 *
 *  - themeMode 'system' follows the phone, 'time' switches at themeDayStart /
 *    themeNightStart (re-evaluated by a timer at each boundary and on return
 *    to the foreground), 'fixed' keeps themeFixed (lib/appearance.ts).
 *  - Pages put `theme-{{theme}} {{accentClass}}` on their root view; the
 *    colours are CSS variables in app.wxss. A class (rather than
 *    `prefers-color-scheme`) works the same under Skyline and WebView.
 *    `bindPageLook(this)` in onLoad keeps both data keys current.
 *  - Native chrome: theme.json styles the status bar and tab bar after the
 *    system theme and the default accent. When the look differs, the tab bar
 *    is restyled with wx.setTabBarStyle / wx.setTabBarItem (only possible on a
 *    tab page) and the status bar text with wx.setNavigationBarColor (per
 *    page). <nav-bar> calls `syncPageChrome` on every page show.
 */
import { msUntilThemeSwitch, resolveTheme, type ThemeRule } from '../lib/appearance'
import { DEFAULT_ACCENT, TAB_NAMES, accentClass, paletteFor, tabBarStyle, tabIconPath, type Theme } from '../lib/palette'
import type { Accent } from '../lib/types'
import { currentSettings, watchSettings, type EffectiveSettings } from './settings'

export type { Theme }

export type Look = {
  readonly theme: Theme
  readonly accent: Accent
  /** The root class after `theme-{{theme}}`: `accent-<accent>-<theme>` (app.wxss). */
  readonly accentClass: string
}

const readSystemTheme = (): Theme => {
  try {
    return wx.getAppBaseInfo().theme === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

const ruleOf = (settings: EffectiveSettings): ThemeRule => ({
  mode: settings.themeMode,
  fixed: settings.themeFixed,
  dayStart: settings.themeDayStart,
  nightStart: settings.themeNightStart,
})

const computeLook = (system: Theme): Look => {
  const settings = currentSettings()
  const theme = resolveTheme(ruleOf(settings), system, new Date())
  return { theme, accent: settings.accent, accentClass: accentClass(theme, settings.accent) }
}

type ThemeListener = (theme: Theme) => void
type LookListener = (look: Look) => void

const themeListeners = new Set<ThemeListener>()
const lookListeners = new Set<LookListener>()

let systemTheme: Theme | null = null
let look: Look | null = null
let switchTimer: number | null = null

/** Starts on first use: reads the system theme and subscribes to every input of the look. */
const ensureStarted = (): Look => {
  if (look !== null) return look
  systemTheme = readSystemTheme()
  look = computeLook(systemTheme)
  wx.onThemeChange((result) => {
    systemTheme = result.theme === 'dark' ? 'dark' : 'light'
    // The platform may restyle the tab bar from theme.json on its own.
    tabBarStale = tabBarShown !== null
    reevaluate()
  })
  watchSettings(() => reevaluate())
  // Timers may not fire while the app is in the background.
  wx.onAppShow(() => reevaluate())
  scheduleSwitch()
  return look
}

/** A timer for the next 跟随时间 boundary (one second late, so the new minute has begun). */
const scheduleSwitch = (): void => {
  if (switchTimer !== null) clearTimeout(switchTimer)
  switchTimer = null
  const ms = msUntilThemeSwitch(ruleOf(currentSettings()), new Date())
  if (ms === null) return
  switchTimer = setTimeout(() => {
    switchTimer = null
    reevaluate()
  }, ms + 1000)
}

function reevaluate(): void {
  const previous = ensureStarted()
  const next = computeLook(systemTheme ?? readSystemTheme())
  look = next
  scheduleSwitch()
  const themeChanged = next.theme !== previous.theme
  if (themeChanged) for (const listener of themeListeners) listener(next.theme)
  if (themeChanged || next.accent !== previous.accent) {
    for (const listener of lookListeners) listener(next)
  }
  syncPageChrome()
}

// ---- reading and following ----

/** The resolved theme (深浅模式 applied). */
export function currentTheme(): Theme {
  return ensureStarted().theme
}

export function currentAccent(): Accent {
  return ensureStarted().accent
}

export function currentLook(): Look {
  return ensureStarted()
}

/** Calls `listener` on every change of the resolved theme; returns the unsubscribe function. */
export function watchTheme(listener: ThemeListener): () => void {
  ensureStarted()
  themeListeners.add(listener)
  return () => {
    themeListeners.delete(listener)
  }
}

/** Calls `listener` when the theme or the accent changes; returns the unsubscribe function. */
export function watchLook(listener: LookListener): () => void {
  ensureStarted()
  lookListeners.add(listener)
  return () => {
    lookListeners.delete(listener)
  }
}

interface LookTarget {
  setData(data: Look): void
}

/**
 * For pages, in onLoad: sets `theme`, `accent` and `accentClass` in the page's
 * data now and on every change; returns the unsubscribe function for onUnload.
 * The page root is `<view class="page theme-{{theme}} {{accentClass}}">`.
 */
export function bindPageLook(page: LookTarget): () => void {
  page.setData(currentLook())
  return watchLook((next) => page.setData(next))
}

/** Subscriptions of mounted components (component instances take no typed custom fields). */
const followers = new WeakMap<object, () => void>()

/** For components: calls `listener` on theme changes until `unfollowTheme(owner)` (in `detached`). */
export function followTheme(owner: object, listener: ThemeListener): void {
  followers.get(owner)?.()
  followers.set(owner, watchTheme(listener))
}

/** For components: calls `listener` on theme or accent changes until `unfollowTheme(owner)` (in `detached`). */
export function followLook(owner: object, listener: LookListener): void {
  followers.get(owner)?.()
  followers.set(owner, watchLook(listener))
}

export function unfollowTheme(owner: object): void {
  followers.get(owner)?.()
  followers.delete(owner)
}

// ---- native chrome ----

const TAB_ROUTES: readonly string[] = TAB_NAMES.map((tab) => `pages/${tab}/index`)

/** What the tab bar was last set to (`<theme>-<accent>`); null = theme.json is still in charge. */
let tabBarShown: string | null = null
let tabBarStale = false
/** Set once a page's status bar was styled by hand; from then on every page show sets it. */
let statusBarStyled = false

const currentRoute = (): string => {
  const pages = getCurrentPages()
  return pages[pages.length - 1]?.route ?? ''
}

const syncTabBar = (current: Look, system: Theme): void => {
  const key = `${current.theme}-${current.accent}`
  const upToDate =
    tabBarShown === null
      ? current.theme === system && current.accent === DEFAULT_ACCENT
      : tabBarShown === key && !tabBarStale
  // The tab bar APIs fail on pages without the tab bar: the next tab page's show retries.
  if (upToDate || !TAB_ROUTES.includes(currentRoute())) return
  tabBarShown = key
  tabBarStale = false
  const retryLater = (): void => {
    tabBarStale = true
  }
  wx.setTabBarStyle({ ...tabBarStyle(current.theme, current.accent), fail: retryLater })
  TAB_NAMES.forEach((tab, index) => {
    wx.setTabBarItem({
      index,
      iconPath: tabIconPath(tab, current.theme, null),
      selectedIconPath: tabIconPath(tab, current.theme, current.accent),
      fail: retryLater,
    })
  })
}

const syncStatusBar = (current: Look, system: Theme): void => {
  if (current.theme === system && !statusBarStyled) return
  statusBarStyled = true
  wx.setNavigationBarColor({
    frontColor: current.theme === 'dark' ? '#ffffff' : '#000000',
    backgroundColor: paletteFor(current.theme, current.accent).bg,
    fail: () => undefined,
  })
}

/** Styles the current page's status bar and, on a tab page, the tab bar to match the look. */
export function syncPageChrome(): void {
  const current = ensureStarted()
  const system = systemTheme ?? readSystemTheme()
  syncStatusBar(current, system)
  syncTabBar(current, system)
}
