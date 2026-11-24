import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ACCENTS, DEFAULT_ACCENT, TAB_NAMES, tabBarStyle, tabIconPath, type Theme } from '../miniprogram/lib/palette.ts'
import { TAB_ICON_DIR, TAB_ICON_PX, TAB_MANIFEST, tabIconManifest, tabIconSources } from '../scripts/tab-icons.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MINIPROGRAM = path.join(ROOT, 'miniprogram')
const THEMES: readonly Theme[] = ['light', 'dark']
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'))

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** WeChat's limit for a tab bar icon. */
const MAX_TAB_ICON_BYTES = 40 * 1024

test('tab icons: 4 tabs × 2 themes unselected, × 5 accents selected', () => {
  const files = tabIconSources().map(({ file }) => file)
  assert.equal(files.length, TAB_NAMES.length * THEMES.length * (1 + ACCENTS.length))
  assert.equal(new Set(files).size, files.length)
  assert.equal(tabIconPath('review', 'dark', null), '/assets/tab/dark/review.png')
  assert.equal(tabIconPath('me', 'light', 'pine'), '/assets/tab/light/me-pine.png')
})

test('tab icon PNGs exist, are 81×81 and under 40 kB, and nothing else is in the folder', () => {
  const wanted = new Set(tabIconSources().map(({ file }) => file))
  for (const file of wanted) {
    const onDisk = path.join(TAB_ICON_DIR, file)
    assert.ok(fs.existsSync(onDisk), `${file} missing: run npm run icons`)
    const png = fs.readFileSync(onDisk)
    assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), `${file} is a PNG`)
    // IHDR: width and height right after the chunk header.
    assert.equal(png.readUInt32BE(16), TAB_ICON_PX, `${file} width`)
    assert.equal(png.readUInt32BE(20), TAB_ICON_PX, `${file} height`)
    assert.ok(png.length <= MAX_TAB_ICON_BYTES, `${file} under 40 kB`)
  }
  for (const theme of THEMES) {
    for (const entry of fs.readdirSync(path.join(TAB_ICON_DIR, theme))) {
      assert.ok(wanted.has(path.join(theme, entry)), `unexpected tab icon ${theme}/${entry}`)
    }
  }
})

test('the tab PNGs were rendered from the current sources (manifest; npm run icons)', () => {
  assert.deepEqual(readJson(TAB_MANIFEST), tabIconManifest(), 'tab icon sources changed: run npm run icons')
})

test('tab icon sources use only what the rasteriser and Skyline agree on', () => {
  for (const { file, svg } of tabIconSources()) {
    assert.ok(!svg.includes('<style'), file)
    assert.ok(!svg.includes('%'), file)
  }
})

interface TabEntry {
  pagePath?: unknown
  iconPath?: unknown
  selectedIconPath?: unknown
}

test('app.json lists the tabs in TAB_NAMES order with theme.json icon variables', () => {
  const app = readJson(path.join(MINIPROGRAM, 'app.json')) as { tabBar: { list: TabEntry[] } }
  const themeJson = readJson(path.join(MINIPROGRAM, 'theme.json')) as Record<Theme, Record<string, string>>
  assert.deepEqual(
    app.tabBar.list.map((tab) => tab.pagePath),
    TAB_NAMES.map((tab) => `pages/${tab}/index`),
  )
  app.tabBar.list.forEach((entry, index) => {
    const tab = TAB_NAMES[index]
    assert.ok(tab)
    for (const theme of THEMES) {
      const variable = (value: unknown): string | undefined =>
        typeof value === 'string' && value.startsWith('@') ? themeJson[theme][value.slice(1)] : undefined
      // theme.json paths are relative to the package root; the API's start with "/".
      assert.equal(`/${variable(entry.iconPath)}`, tabIconPath(tab, theme, null), `${tab} ${theme} icon`)
      assert.equal(`/${variable(entry.selectedIconPath)}`, tabIconPath(tab, theme, DEFAULT_ACCENT), `${tab} ${theme} selected`)
    }
  })
})

test('theme.json tab colours are the default accent’s tabBarStyle (what services/theme.ts restores)', () => {
  const themeJson = readJson(path.join(MINIPROGRAM, 'theme.json')) as Record<Theme, Record<string, string>>
  for (const theme of THEMES) {
    const style = tabBarStyle(theme, DEFAULT_ACCENT)
    assert.equal(themeJson[theme].tabColor, style.color, `${theme} tabColor`)
    assert.equal(themeJson[theme].tabSelectedColor, style.selectedColor, `${theme} tabSelectedColor`)
    assert.equal(themeJson[theme].tabBgColor, style.backgroundColor, `${theme} tabBgColor`)
    assert.equal(themeJson[theme].tabBorderStyle, style.borderStyle, `${theme} tabBorderStyle`)
  }
})
