import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ICON_NAMES, ICON_TONES, PALETTES, iconPath, toneColor, type Palette, type Theme } from '../miniprogram/lib/palette.ts'
import { ICON_DIR, iconFiles } from '../scripts/icons.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_WXSS = fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.wxss'), 'utf8')

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

const cssVariables = (theme: Theme): Map<string, string> => {
  const block = new RegExp(`\\.theme-${theme} \\{([^}]*)\\}`).exec(APP_WXSS)?.[1]
  assert.ok(block, `.theme-${theme} block in app.wxss`)
  return new Map([...block.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]))
}

test('the palette mirrors the CSS variables of app.wxss', () => {
  for (const theme of ['light', 'dark'] as const) {
    const css = cssVariables(theme)
    for (const [key, variable] of Object.entries(VARIABLES) as [keyof Palette, string][]) {
      assert.equal(PALETTES[theme][key], css.get(variable), `${theme} ${variable}`)
    }
  }
})

test('iconPath: theme folder, tone suffix; unknown names draw nothing', () => {
  assert.equal(iconPath('speaker', 'accent', 'dark'), '/assets/icons/dark/speaker-accent.svg')
  assert.equal(iconPath('chevron-right', 'muted', 'light'), '/assets/icons/light/chevron-right-muted.svg')
  assert.equal(iconPath('speaker', 'neon', 'light'), '/assets/icons/light/speaker-ink.svg', 'unknown tone → ink')
  assert.equal(iconPath('rocket', 'accent', 'light'), '')
})

test('toneColor: the palette entry of the tone; unknown tones are ink', () => {
  assert.equal(toneColor('accent', 'light'), PALETTES.light.accent)
  assert.equal(toneColor('danger', 'dark'), PALETTES.dark.danger)
  assert.equal(toneColor('neon', 'dark'), PALETTES.dark.ink)
})

test('the generated icon files are present and current (npm run icons)', () => {
  const expected = iconFiles()
  assert.equal(expected.length, ICON_NAMES.length * ICON_TONES.length * 2)
  for (const { file, content } of expected) {
    const onDisk = path.join(ICON_DIR, file)
    assert.ok(fs.existsSync(onDisk), `${file} missing: run npm run icons`)
    assert.equal(fs.readFileSync(onDisk, 'utf8'), content, `${file} stale: run npm run icons`)
  }
  const wanted = new Set(expected.map(({ file }) => file))
  for (const theme of ['light', 'dark']) {
    for (const entry of fs.readdirSync(path.join(ICON_DIR, theme))) {
      assert.ok(wanted.has(path.join(theme, entry)), `unexpected icon file ${theme}/${entry}`)
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
