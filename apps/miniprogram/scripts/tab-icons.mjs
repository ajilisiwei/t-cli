#!/usr/bin/env node
/**
 * Generates the tab bar icons: PNG, because the native tab bar takes no SVG.
 *
 *   miniprogram/assets/tab/<theme>/<tab>.png            unselected (muted), per theme
 *   miniprogram/assets/tab/<theme>/<tab>-<accent>.png   selected, per theme × accent
 *
 * 4 tabs × 2 themes + 4 × 2 × 5 = 48 files, 81×81 px (WeChat's recommended
 * size; at most 40 kB each). The shapes are drawn on the same 24×24 grid as
 * the other icons (scripts/icons.mjs) and rasterised with @resvg/resvg-js
 * (prebuilt binaries, no install script).
 *
 * PNG bytes may differ between resvg versions, so freshness is checked on the
 * source instead: scripts/tab-icons.manifest.json records a hash of each
 * file's SVG source, and test/icons.test.ts fails when a source changed but
 * the PNGs were not regenerated.
 *
 *   npm run icons -w @t-cli/miniprogram     (runs this after scripts/icons.mjs)
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACCENTS, PALETTES, TAB_NAMES, paletteFor, tabIconPath } from '../miniprogram/lib/palette.ts'
import { svgDocument } from './icons.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MINIPROGRAM = path.join(ROOT, 'miniprogram')
export const TAB_ICON_DIR = path.join(MINIPROGRAM, 'assets', 'tab')
export const TAB_MANIFEST = path.join(ROOT, 'scripts', 'tab-icons.manifest.json')
export const TAB_ICON_PX = 81

/** The tab shapes of the design (prototype tab bar). */
const TAB_SHAPES = {
  // 文 and A: translate.
  translate:
    '<path d="M4 5h9"/><path d="M8.5 3v2"/><path d="M11 5c-.8 4-3.5 7-7 8.5"/>' +
    '<path d="M6.5 8.5c1 2 2.8 3.6 5 4.5"/><path d="M13 21l4-9 4 9"/><path d="M14.5 18h5"/>',
  // A notebook with binding tabs and two lines.
  notebook:
    '<rect x="5.5" y="3" width="14" height="18" rx="2"/><path d="M3 7.5h4M3 12h4M3 16.5h4"/>' +
    '<path d="M10 8h6.5M10 12h4.5"/>',
  // Two stacked cards.
  review: '<rect x="3" y="7" width="13" height="14" rx="2.5"/><path d="M8 4h10.5A2.5 2.5 0 0 1 21 6.5V17"/>',
  // A person.
  me: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
}

/** Package path (/assets/tab/…) → path relative to TAB_ICON_DIR. */
const relativeFile = (packagePath) => path.relative('/assets/tab', packagePath)

/** Every tab icon as { file (relative to TAB_ICON_DIR), svg }. */
export function tabIconSources() {
  const sources = []
  for (const theme of Object.keys(PALETTES)) {
    for (const tab of TAB_NAMES) {
      const shape = TAB_SHAPES[tab]
      if (shape === undefined) throw new Error(`no shape for tab "${tab}"`)
      sources.push({ file: relativeFile(tabIconPath(tab, theme, null)), svg: svgDocument(shape, PALETTES[theme].muted) })
      for (const accent of ACCENTS) {
        sources.push({
          file: relativeFile(tabIconPath(tab, theme, accent)),
          svg: svgDocument(shape, paletteFor(theme, accent).accent),
        })
      }
    }
  }
  return sources
}

export const sourceHash = (svg) => crypto.createHash('sha256').update(svg).digest('hex').slice(0, 16)

/** The manifest for the current sources: { file: hash }, sorted by file. */
export function tabIconManifest() {
  const entries = tabIconSources()
    .map(({ file, svg }) => [file.split(path.sep).join('/'), sourceHash(svg)])
    .sort(([a], [b]) => a.localeCompare(b))
  return Object.fromEntries(entries)
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  // Loaded only here, so tests can import this module without the native binary.
  const { Resvg } = createRequire(import.meta.url)('@resvg/resvg-js')
  const sources = tabIconSources()
  const wanted = new Set(sources.map(({ file }) => file))
  for (const theme of Object.keys(PALETTES)) {
    const dir = path.join(TAB_ICON_DIR, theme)
    fs.mkdirSync(dir, { recursive: true })
    for (const entry of fs.readdirSync(dir)) {
      if (entry.endsWith('.png') && !wanted.has(path.join(theme, entry))) fs.rmSync(path.join(dir, entry))
    }
  }
  for (const { file, svg } of sources) {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: TAB_ICON_PX } }).render().asPng()
    fs.writeFileSync(path.join(TAB_ICON_DIR, file), png)
  }
  fs.writeFileSync(TAB_MANIFEST, `${JSON.stringify(tabIconManifest(), null, 2)}\n`)
  console.log(`wrote ${sources.length} tab icons to ${path.relative(ROOT, TAB_ICON_DIR)}`)
}
