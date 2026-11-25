/**
 * The theme colours for code that cannot use the CSS variables: generated
 * SVG icons (scripts/icons.mjs), tab bar icons and style (scripts/tab-icons.mjs,
 * services/theme.ts) and inline colours (the 主题色 swatches). They mirror the
 * `.theme-light` / `.theme-dark` and `.accent-<accent>-<theme>` variables in
 * app.wxss; a unit test keeps the two in step.
 */
import type { Accent } from './types'

export type Theme = 'light' | 'dark'

export interface Palette {
  readonly bg: string
  readonly ink: string
  readonly inkSoft: string
  readonly muted: string
  readonly rule: string
  readonly accent: string
  readonly accentSoft: string
  readonly accentInk: string
  readonly surface: string
  readonly danger: string
}

/** The neutral colours and the default accent (indigo) per theme. */
export const PALETTES: Readonly<Record<Theme, Palette>> = {
  light: {
    bg: '#f7f5f0',
    ink: '#1d1c1a',
    inkSoft: '#46433d',
    muted: '#6f6a62',
    rule: '#e2ddd3',
    accent: '#2f3e7a',
    accentSoft: 'rgba(47, 62, 122, 0.12)',
    accentInk: '#ffffff',
    surface: '#fffefb',
    danger: '#9c3426',
  },
  dark: {
    bg: '#131312',
    ink: '#ebe8e1',
    inkSoft: '#c9c4ba',
    muted: '#8f8a80',
    rule: '#2c2b28',
    accent: '#9fb0ee',
    accentSoft: 'rgba(159, 176, 238, 0.16)',
    accentInk: '#131312',
    surface: '#1c1c1a',
    danger: '#e59a8c',
  },
}

// ---- accents (主题色) ----

export const ACCENTS: readonly Accent[] = ['indigo', 'pine', 'plum', 'ochre', 'ink']

export const DEFAULT_ACCENT: Accent = 'indigo'

export type AccentColors = Pick<Palette, 'accent' | 'accentSoft' | 'accentInk'>

/**
 * Light values from the design; dark ones are lightened to keep at least
 * 4.5:1 against the dark ground and surface (test/icons.test.ts checks).
 * `accentSoft` is the accent at 12 % (light) / 16 % (dark); `accentInk`, the
 * text on an accent fill, is the same for every accent.
 */
export const ACCENT_COLORS: Readonly<Record<Accent, Readonly<Record<Theme, AccentColors>>>> = {
  indigo: {
    light: { accent: '#2f3e7a', accentSoft: 'rgba(47, 62, 122, 0.12)', accentInk: '#ffffff' },
    dark: { accent: '#9fb0ee', accentSoft: 'rgba(159, 176, 238, 0.16)', accentInk: '#131312' },
  },
  pine: {
    light: { accent: '#2e5e46', accentSoft: 'rgba(46, 94, 70, 0.12)', accentInk: '#ffffff' },
    dark: { accent: '#86c2a0', accentSoft: 'rgba(134, 194, 160, 0.16)', accentInk: '#131312' },
  },
  plum: {
    light: { accent: '#553c7b', accentSoft: 'rgba(85, 60, 123, 0.12)', accentInk: '#ffffff' },
    dark: { accent: '#c2a6ec', accentSoft: 'rgba(194, 166, 236, 0.16)', accentInk: '#131312' },
  },
  ochre: {
    light: { accent: '#8a4b1f', accentSoft: 'rgba(138, 75, 31, 0.12)', accentInk: '#ffffff' },
    dark: { accent: '#e3a774', accentSoft: 'rgba(227, 167, 116, 0.16)', accentInk: '#131312' },
  },
  ink: {
    light: { accent: '#1d1c1a', accentSoft: 'rgba(29, 28, 26, 0.12)', accentInk: '#ffffff' },
    dark: { accent: '#ebe8e1', accentSoft: 'rgba(235, 232, 225, 0.16)', accentInk: '#131312' },
  },
}

export const isAccent = (value: unknown): value is Accent =>
  typeof value === 'string' && (ACCENTS as readonly string[]).includes(value)

/** The full palette of `theme` with `accent`'s colours. */
export function paletteFor(theme: Theme, accent: Accent = DEFAULT_ACCENT): Palette {
  return { ...PALETTES[theme], ...ACCENT_COLORS[accent][theme] }
}

/** The root class that switches a page to `accent` (app.wxss); goes after `theme-<theme>`. */
export function accentClass(theme: Theme, accent: Accent): string {
  return `accent-${accent}-${theme}`
}

// ---- icons ----

/** Icon colours: each is a palette entry. */
export type IconTone = 'ink' | 'muted' | 'accent' | 'danger' | 'accentInk'

export const ICON_TONES: readonly IconTone[] = ['ink', 'muted', 'accent', 'danger', 'accentInk']

/**
 * Tones whose colour depends on the accent: one file per accent. (accentInk
 * is the same for every accent, so one file per theme serves all of them.)
 */
export const ACCENT_TONES: readonly IconTone[] = ['accent']

export const ICON_NAMES = [
  'speaker',
  'stop',
  'copy',
  'close',
  'check',
  'chevron-left',
  'chevron-right',
  'mic',
  'bookmark',
  'bookmark-filled',
  'star',
  'star-filled',
  'calendar',
  'search',
  'arrow-up',
  'swap',
  'cloud-check',
  'book',
  'printer',
  'doc',
  'cards',
  'checklist',
  'info',
  'share',
] as const

export type IconName = (typeof ICON_NAMES)[number]

const isIconName = (name: string): name is IconName => (ICON_NAMES as readonly string[]).includes(name)
const isIconTone = (tone: string): tone is IconTone => (ICON_TONES as readonly string[]).includes(tone)

/** The colour of `tone` in `theme` with `accent`; an unknown tone is ink. */
export function toneColor(tone: string, theme: Theme, accent: Accent = DEFAULT_ACCENT): string {
  return paletteFor(theme, accent)[isIconTone(tone) ? tone : 'ink']
}

/**
 * File name suffix of an icon: the tone, plus the accent for accent-dependent
 * tones of a non-default accent (`accent-pine`).
 */
export function iconSuffix(tone: IconTone, accent: Accent): string {
  return ACCENT_TONES.includes(tone) && accent !== DEFAULT_ACCENT ? `${tone}-${accent}` : tone
}

/**
 * Package path of a generated icon. Unknown names give '' (nothing is drawn);
 * an unknown tone falls back to ink.
 */
export function iconPath(name: string, tone: string, theme: Theme, accent: Accent = DEFAULT_ACCENT): string {
  if (!isIconName(name)) return ''
  return `/assets/icons/${theme}/${name}-${iconSuffix(isIconTone(tone) ? tone : 'ink', accent)}.svg`
}

// ---- tab bar ----

/** The tabs in app.json order. */
export const TAB_NAMES = ['translate', 'notebook', 'review', 'me'] as const

export type TabName = (typeof TAB_NAMES)[number]

/**
 * Package path of a tab bar icon (PNG: the native tab bar takes no SVG).
 * `accent` null → the unselected icon (muted); otherwise the selected one in
 * that accent.
 */
export function tabIconPath(tab: TabName, theme: Theme, accent: Accent | null): string {
  return `/assets/tab/${theme}/${tab}${accent === null ? '' : `-${accent}`}.png`
}

export interface TabBarStyle {
  readonly color: string
  readonly selectedColor: string
  readonly backgroundColor: string
  readonly borderStyle: 'black' | 'white'
}

/** The native tab bar's colours for a theme and accent (theme.json holds the system/indigo ones). */
export function tabBarStyle(theme: Theme, accent: Accent): TabBarStyle {
  const palette = paletteFor(theme, accent)
  return {
    color: palette.muted,
    selectedColor: palette.accent,
    backgroundColor: palette.bg,
    borderStyle: theme === 'dark' ? 'white' : 'black',
  }
}
