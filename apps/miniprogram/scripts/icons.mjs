#!/usr/bin/env node
/**
 * Generates the icon set: one SVG per icon × tone × theme under
 * miniprogram/assets/icons/<theme>/<name>-<tone>.svg.
 *
 * Why files: Skyline has no `currentColor` and no per-side border colours on
 * rounded boxes, and emoji glyphs (▶︎) render as coloured emoji on iOS. A
 * static SVG per colour is the documented way to get a crisp, themed icon.
 * The <t-icon> component picks the file for the current theme.
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
import { ICON_NAMES, ICON_TONES, PALETTES } from '../miniprogram/lib/palette.ts'

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
}

export function renderIcon(name, color) {
  const shape = SHAPES[name]
  if (shape === undefined) throw new Error(`no shape for icon "${name}"`)
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
    `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `${shape.replaceAll('{c}', color)}</svg>\n`
  )
}

/** Every icon file as { file (relative to ICON_DIR), content }. */
export function iconFiles() {
  const files = []
  for (const [theme, palette] of Object.entries(PALETTES)) {
    for (const name of ICON_NAMES) {
      for (const tone of ICON_TONES) {
        files.push({ file: path.join(theme, `${name}-${tone}.svg`), content: renderIcon(name, palette[tone]) })
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
