/**
 * The theme colours for code that cannot use the CSS variables: generated
 * SVG icons (scripts/icons.mjs) and inline gradients (the 复习 ring). They
 * mirror the `.theme-light` / `.theme-dark` variables in app.wxss; a unit
 * test keeps the two in step.
 */

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

/** Icon colours: each is a palette entry. */
export type IconTone = 'ink' | 'muted' | 'accent' | 'danger' | 'accentInk'

export const ICON_TONES: readonly IconTone[] = ['ink', 'muted', 'accent', 'danger', 'accentInk']

export const ICON_NAMES = [
  'speaker',
  'stop',
  'copy',
  'close',
  'check',
  'chevron-left',
  'chevron-right',
  'mic',
] as const

export type IconName = (typeof ICON_NAMES)[number]

const isIconName = (name: string): name is IconName => (ICON_NAMES as readonly string[]).includes(name)
const isIconTone = (tone: string): tone is IconTone => (ICON_TONES as readonly string[]).includes(tone)

/** The colour of `tone` in `theme`; an unknown tone is ink. */
export function toneColor(tone: string, theme: Theme): string {
  return PALETTES[theme][isIconTone(tone) ? tone : 'ink']
}

/**
 * Package path of a generated icon. Unknown names give '' (nothing is drawn);
 * an unknown tone falls back to ink.
 */
export function iconPath(name: string, tone: string, theme: Theme): string {
  if (!isIconName(name)) return ''
  return `/assets/icons/${theme}/${name}-${isIconTone(tone) ? tone : 'ink'}.svg`
}
