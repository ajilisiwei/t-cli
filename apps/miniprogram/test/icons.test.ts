import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACCENTS,
  ACCENT_COLORS,
  ACCENT_TONES,
  DEFAULT_ACCENT,
  ICON_NAMES,
  ICON_TONES,
  PALETTES,
  accentClass,
  iconPath,
  paletteFor,
  toneColor,
  type AccentColors,
  type Palette,
  type Theme,
} from '../miniprogram/lib/palette.ts'
import { ICON_DIR, iconFiles } from '../scripts/icons.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_WXSS = fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.wxss'), 'utf8')
const THEMES: readonly Theme[] = ['light', 'dark']

const VARIABLES: Readonly<Record<keyof Palette, string>> = {
  bg: '--bg',
  ink: '--ink',
  inkSoft: '--ink-soft',
  muted: '--muted',
  rule: '--rule',
  accent: '--accent',
  accentSoft: '--accent-soft',
  accentInk: '--accent-ink',
  surface: '--surface',
  danger: '--danger',
}

const cssBlock = (selector: string): Map<string, string> => {
  const block = new RegExp(`\\.${selector} \\{([^}]*)\\}`).exec(APP_WXSS)?.[1]
  assert.ok(block, `.${selector} block in app.wxss`)
  return new Map([...block.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]))
}

test('the palette mirrors the CSS variables of app.wxss', () => {
  for (const theme of THEMES) {
    const css = cssBlock(`theme-${theme}`)
    for (const [key, variable] of Object.entries(VARIABLES) as [keyof Palette, string][]) {
      assert.equal(PALETTES[theme][key], css.get(variable), `${theme} ${variable}`)
    }
  }
})

test('every accent class in app.wxss mirrors ACCENT_COLORS', () => {
  const keys: readonly (keyof AccentColors)[] = ['accent', 'accentSoft', 'accentInk']
  for (const accent of ACCENTS) {
    for (const theme of THEMES) {
      const css = cssBlock(accentClass(theme, accent))
      assert.equal(css.size, keys.length, `${accent}-${theme} sets only the accent variables`)
      for (const key of keys) {
        assert.equal(ACCENT_COLORS[accent][theme][key], css.get(VARIABLES[key]), `${accent}-${theme} ${VARIABLES[key]}`)
      }
    }
  }
})

test('the accent classes come after the theme blocks (same specificity: the later rule wins)', () => {
  const lastTheme = Math.max(APP_WXSS.indexOf('.theme-light {'), APP_WXSS.indexOf('.theme-dark {'))
  for (const accent of ACCENTS) {
    for (const theme of THEMES) assert.ok(APP_WXSS.indexOf(`.${accentClass(theme, accent)} {`) > lastTheme)
  }
})

test('the default accent is the theme blocks’ accent; paletteFor swaps only the accent colours', () => {
  assert.equal(DEFAULT_ACCENT, 'indigo')
  for (const theme of THEMES) {
    assert.deepEqual(paletteFor(theme), PALETTES[theme])
    const pine = paletteFor(theme, 'pine')
    assert.equal(pine.accent, ACCENT_COLORS.pine[theme].accent)
    assert.equal(pine.bg, PALETTES[theme].bg)
    assert.equal(pine.muted, PALETTES[theme].muted)
  }
  assert.equal(accentClass('dark', 'ochre'), 'accent-ochre-dark')
})

// WCAG 2 contrast.
const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const linear = (c: number): number => {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const luminance = (rgb: readonly number[]): number =>
  0.2126 * linear(rgb[0] ?? 0) + 0.7152 * linear(rgb[1] ?? 0) + 0.0722 * linear(rgb[2] ?? 0)
const contrast = (a: readonly number[], b: readonly number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}
/** `rgba(r, g, b, a)` laid over an opaque ground. */
const over = (rgba: string, ground: readonly number[]): number[] => {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(rgba)
  assert.ok(m, rgba)
  const alpha = Number(m[4])
  return [m[1], m[2], m[3]].map((c, i) => Math.round(Number(c) * alpha + (ground[i] ?? 0) * (1 - alpha)))
}

test('every accent keeps 4.5:1: as text on the ground, the surface and its soft tint, and under accentInk', () => {
  for (const accent of ACCENTS) {
    for (const theme of THEMES) {
      const p = paletteFor(theme, accent)
      const fill = channels(p.accent)
      const label = `${accent} ${theme}`
      assert.ok(contrast(fill, channels(p.bg)) >= 4.5, `${label} on bg`)
      assert.ok(contrast(fill, channels(p.surface)) >= 4.5, `${label} on surface`)
      assert.ok(contrast(fill, over(p.accentSoft, channels(p.bg))) >= 4.5, `${label} on accent-soft`)
      assert.ok(contrast(channels(p.accentInk), fill) >= 4.5, `accentInk on ${label}`)
    }
  }
})

test('accentSoft is the accent at 12 % (light) / 16 % (dark)', () => {
  for (const accent of ACCENTS) {
    for (const theme of THEMES) {
      const { accent: hex, accentSoft } = ACCENT_COLORS[accent][theme]
      const alpha = theme === 'light' ? '0.12' : '0.16'
      assert.equal(accentSoft, `rgba(${channels(hex).join(', ')}, ${alpha})`, `${accent} ${theme}`)
    }
  }
})

test('only ACCENT_TONES vary by accent, so the other tones need one file per theme', () => {
  for (const theme of THEMES) {
    for (const tone of ICON_TONES.filter((t) => !ACCENT_TONES.includes(t))) {
      const colors = new Set(ACCENTS.map((accent) => toneColor(tone, theme, accent)))
      assert.equal(colors.size, 1, `${tone} in ${theme}`)
    }
  }
})

test('iconPath: theme folder, tone suffix, accent suffix for accent tones; unknown names draw nothing', () => {
  assert.equal(iconPath('speaker', 'accent', 'dark'), '/assets/icons/dark/speaker-accent.svg')
  assert.equal(iconPath('speaker', 'accent', 'dark', 'indigo'), '/assets/icons/dark/speaker-accent.svg')
  assert.equal(iconPath('speaker', 'accent', 'light', 'pine'), '/assets/icons/light/speaker-accent-pine.svg')
  assert.equal(iconPath('star-filled', 'accentInk', 'dark', 'plum'), '/assets/icons/dark/star-filled-accentInk.svg')
  assert.equal(iconPath('chevron-right', 'muted', 'light', 'ochre'), '/assets/icons/light/chevron-right-muted.svg')
  assert.equal(iconPath('speaker', 'neon', 'light'), '/assets/icons/light/speaker-ink.svg', 'unknown tone → ink')
  assert.equal(iconPath('rocket', 'accent', 'light'), '')
})

test('toneColor: the palette entry of the tone in the accent; unknown tones are ink', () => {
  assert.equal(toneColor('accent', 'light'), PALETTES.light.accent)
  assert.equal(toneColor('accent', 'dark', 'ink'), ACCENT_COLORS.ink.dark.accent)
  assert.equal(toneColor('danger', 'dark'), PALETTES.dark.danger)
  assert.equal(toneColor('neon', 'dark'), PALETTES.dark.ink)
})

test('the generated icon files are present and current (npm run icons)', () => {
  const expected = iconFiles()
  const variants = ICON_TONES.length + (ACCENTS.length - 1) * ACCENT_TONES.length
  assert.equal(expected.length, ICON_NAMES.length * variants * THEMES.length)
  for (const { file, content } of expected) {
    const onDisk = path.join(ICON_DIR, file)
    assert.ok(fs.existsSync(onDisk), `${file} missing: run npm run icons`)
    assert.equal(fs.readFileSync(onDisk, 'utf8'), content, `${file} stale: run npm run icons`)
  }
  const wanted = new Set(expected.map(({ file }) => file))
  for (const theme of THEMES) {
    for (const entry of fs.readdirSync(path.join(ICON_DIR, theme))) {
      assert.ok(wanted.has(path.join(theme, entry)), `unexpected icon file ${theme}/${entry}`)
    }
  }
})

test('every icon a component can ask for exists, in every theme and accent', () => {
  for (const theme of THEMES) {
    for (const accent of ACCENTS) {
      for (const name of ICON_NAMES) {
        for (const tone of ICON_TONES) {
          const file = path.join(ROOT, 'miniprogram', iconPath(name, tone, theme, accent))
          assert.ok(fs.existsSync(file), file)
        }
      }
    }
  }
})

test('icons use only what Skyline renders: no <style>, no percentages', () => {
  for (const { file, content } of iconFiles()) {
    assert.ok(!content.includes('<style'), file)
    assert.ok(!content.includes('%'), file)
    assert.match(content, /viewBox="0 0 24 24"/, file)
  }
})
