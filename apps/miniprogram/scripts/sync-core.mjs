#!/usr/bin/env node
/**
 * Copies the packages/core modules the mini-program needs into
 * miniprogram/vendor/core/.
 *
 * The mini-program compiler only sees files under `miniprogram/`, so it cannot
 * import `@t-cli/core` from the workspace. Instead of hand-copying logic, the
 * files are copied verbatim with a generated header, and
 * test/vendor-sync.test.ts fails whenever a copy differs from its source.
 *
 *   node scripts/sync-core.mjs           # rewrite the copies
 *   node scripts/sync-core.mjs --check   # exit 1 if any copy is stale
 *
 * Only self-contained modules may be vendored: a copied relative import would
 * point at a file that is not there.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CORE_SRC = path.resolve(APP_DIR, '..', '..', 'packages', 'core', 'src')
export const VENDOR_DIR = path.join(APP_DIR, 'miniprogram', 'vendor', 'core')

/** Modules copied from packages/core/src. */
export const VENDORED = ['detect.js']

const header = (name) =>
  [
    `// GENERATED from packages/core/src/${name} by apps/miniprogram/scripts/sync-core.mjs. Do not edit.`,
    '// Change the source, then run `npm run sync:core -w @t-cli/miniprogram`;',
    '// apps/miniprogram/test/vendor-sync.test.ts fails while this copy is stale.',
    '',
  ].join('\n')

/** The exact content the vendored copy of `name` must have. */
export function expectedCopy(name) {
  const source = fs.readFileSync(path.join(CORE_SRC, name), 'utf8')
  if (/^\s*(import|export)\s[^;]*\sfrom\s/m.test(source)) {
    throw new Error(`${name} imports other modules and cannot be vendored as a single file`)
  }
  return header(name) + source
}

export function staleCopies() {
  return VENDORED.filter((name) => {
    const target = path.join(VENDOR_DIR, name)
    return !fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== expectedCopy(name)
  })
}

const main = () => {
  if (process.argv.includes('--check')) {
    const stale = staleCopies()
    if (stale.length > 0) {
      console.error(`stale vendored core modules: ${stale.join(', ')} (run npm run sync:core -w @t-cli/miniprogram)`)
      process.exit(1)
    }
    return
  }
  fs.mkdirSync(VENDOR_DIR, { recursive: true })
  for (const name of VENDORED) {
    fs.writeFileSync(path.join(VENDOR_DIR, name), expectedCopy(name))
    console.log(`vendored ${name}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
