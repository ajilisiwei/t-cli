import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { VENDORED, VENDOR_DIR, expectedCopy } from '../scripts/sync-core.mjs'

test('vendored packages/core modules match their source', () => {
  for (const name of VENDORED) {
    const copy = fs.readFileSync(path.join(VENDOR_DIR, name), 'utf8')
    assert.equal(
      copy,
      expectedCopy(name),
      `miniprogram/vendor/core/${name} is stale: run npm run sync:core -w @t-cli/miniprogram`,
    )
  }
})

test('no file is vendored without being listed', () => {
  assert.deepEqual(fs.readdirSync(VENDOR_DIR).sort(), [...VENDORED].sort())
})
