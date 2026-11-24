#!/usr/bin/env node
/**
 * Generates the icon set: one SVG per icon × tone × theme under
 * miniprogram/assets/icons/<theme>/<name>-<tone>.svg, plus one per other
 * accent for the accent-dependent tones: <name>-accent-<accent>.svg (the
 * default accent, indigo, keeps the plain name).
 *
 * Why files: Skyline has no `currentColor` and no per-side border colours on
 * rounded boxes, and emoji glyphs (▶︎) render as coloured emoji on iOS. A
 * static SVG per colour is the documented way to get a crisp, themed icon.
 * The <t-icon> component picks the file for the current theme and accent.
 *
 * Style: 24×24 grid, 2px round strokes, a few filled shapes. Skyline's SVG
 * support excludes percentages and <style>, so neither is used.
 *
 *   npm run icons -w @t-cli/miniprogram
 *
 * Adding an icon: add its shape below and its name to ICON_NAMES in
 * miniprogram/lib/palette.ts, then run the script. test/icons.test.ts fails
 * while the files are missing or stale.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACCENTS,
  ACCENT_TONES,
  DEFAULT_ACCENT,
  ICON_NAMES,
  ICON_TONES,
  PALETTES,
  iconSuffix,
  paletteFor,
} from '../miniprogram/lib/palette.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ICON_DIR = path.join(ROOT, 'miniprogram', 'assets', 'icons')

/** Inner SVG per icon; `{c}` is the colour. Strokes by default, `fill` where noted. */
const SHAPES = {
  // A filled cone and two sound waves.
  speaker:
    '<path d="M4 9.5h2.8l4.6-3.9c.5-.4 1.1-.1 1.1.5v11.8c0 .6-.6.9-1.1.5L6.8 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z" fill="{c}" stroke="none"/>' +
    '<path d="M16 9.2a4 4 0 0 1 0 5.6"/><path d="M18.8 6.4a8 8 0 0 1 0 11.2"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="{c}" stroke="none"/>',
  copy:
    '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5"/>' +
    '<path d="M15.5 8.5v-2A2.5 2.5 0 0 0 13 4H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  'chevron-left': '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  'chevron-right': '<path d="M9.5 5.5L16 12l-6.5 6.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>',
  // 收藏: the outline, and the same silhouette filled (saved).
  bookmark: '<path d="M7.5 4h9A1.5 1.5 0 0 1 18 5.5V20l-6-4.2L6 20V5.5A1.5 1.5 0 0 1 7.5 4z"/>',
  'bookmark-filled': '<path d="M7.5 4h9A1.5 1.5 0 0 1 18 5.5V20l-6-4.2L6 20V5.5A1.5 1.5 0 0 1 7.5 4z" fill="{c}"/>',
  // 重要程度: one star of <t-stars>, empty and filled.
  star: '<path d="M12 3.6L14.41 9.28L20.56 9.82L15.9 13.87L17.29 19.88L12 16.7L6.71 19.88L8.1 13.87L3.44 9.82L9.59 9.28z"/>',
  'star-filled': '<path d="M12 3.6L14.41 9.28L20.56 9.82L15.9 13.87L17.29 19.88L12 16.7L6.71 19.88L8.1 13.87L3.44 9.82L9.59 9.28z" fill="{c}"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10.5h16M8.5 3.5v4M15.5 3.5v4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  // 回到顶部.
  'arrow-up': '<path d="M12 19.5V5.5M6 11.5l6-6 6 6"/>',
  // Two opposite arrows: switch the translate direction.
  swap: '<path d="M5 8.5h13.5M15 5l3.5 3.5L15 12"/><path d="M19 15.5H5.5M9 12l-3.5 3.5L9 19"/>',
  // A cloud with a check: settings are saved to the account.
  'cloud-check': '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 7.97"/><path d="M9.5 15.5l2 2 3.5-3.5"/>',
}

/** A 24×24 icon document: `shape` (with `{c}` for the colour) stroked in `color`. Also used for the tab icons. */
export function svgDocument(shape, color) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
    `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `${shape.replaceAll('{c}', color)}</svg>\n`
  )
}

export function renderIcon(name, color) {
  const shape = SHAPES[name]
  if (shape === undefined) throw new Error(`no shape for icon "${name}"`)
  return svgDocument(shape, color)
}

/** Every (tone, accent) pair that has its own file: all tones in the default accent, accent tones in the others. */
const toneVariants = () => [
  ...ICON_TONES.map((tone) => ({ tone, accent: DEFAULT_ACCENT })),
  ...ACCENTS.filter((accent) => accent !== DEFAULT_ACCENT).flatMap((accent) =>
    ACCENT_TONES.map((tone) => ({ tone, accent })),
  ),
]

/** Every icon file as { file (relative to ICON_DIR), content }. */
export function iconFiles() {
  const files = []
  for (const theme of Object.keys(PALETTES)) {
    for (const name of ICON_NAMES) {
      for (const { tone, accent } of toneVariants()) {
        files.push({
          file: path.join(theme, `${name}-${iconSuffix(tone, accent)}.svg`),
          content: renderIcon(name, paletteFor(theme, accent)[tone]),
        })
      }
    }
  }
  return files
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const files = iconFiles()
  const wanted = new Set(files.map(({ file }) => file))
  for (const theme of Object.keys(PALETTES)) {
    const dir = path.join(ICON_DIR, theme)
    fs.mkdirSync(dir, { recursive: true })
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith('.svg') && !wanted.has(path.join(theme, entry))) fs.rmSync(path.join(dir, entry))
    }
  }
  for (const { file, content } of files) fs.writeFileSync(path.join(ICON_DIR, file), content)
  console.log(`wrote ${files.length} icons to ${path.relative(ROOT, ICON_DIR)}`)
}
