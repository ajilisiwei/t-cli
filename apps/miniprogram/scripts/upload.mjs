#!/usr/bin/env node
/**
 * Uploads the mini-program as a development version (then promoted to 体验版
 * in the admin console), or produces a preview QR code. Used by
 * .github/workflows/mp-upload.yml and runnable locally.
 *
 * miniprogram-ci is not a dependency of this repository: install it somewhere
 * else and point MINIPROGRAM_CI_DIR at that directory (the workflow does
 * this), or have it resolvable from here.
 *
 * The private key never enters the repository. Its path comes from
 * WX_UPLOAD_KEY, defaulting to ~/.wx-miniprogram/private.<appid>.key. The
 * AppID comes from WX_APPID, falling back to project.config.json.
 *
 *   node scripts/upload.mjs --version 0.1.0 --desc "M2 体验版"
 *   node scripts/upload.mjs --preview
 *
 * The package itself is environment-agnostic: the API host is chosen at
 * runtime from envVersion (lib/env.ts), so nothing is rewritten for upload.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLACEHOLDER_APPID = 'touristappid'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const flag = (name) => process.argv.includes(`--${name}`)

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const loadMiniprogramCi = () => {
  const base = process.env.MINIPROGRAM_CI_DIR
    ? path.join(path.resolve(process.env.MINIPROGRAM_CI_DIR), 'package.json')
    : import.meta.url
  try {
    return createRequire(base)('miniprogram-ci')
  } catch {
    return fail(
      'miniprogram-ci not found. Install it outside the repo, e.g.\n' +
        '  npm install --prefix /tmp/mpci miniprogram-ci@2.1.31\n' +
        'then run with MINIPROGRAM_CI_DIR=/tmp/mpci.',
    )
  }
}

const projectConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'))
const appid = (process.env.WX_APPID || projectConfig.appid || '').trim()
if (appid === '' || appid === PLACEHOLDER_APPID) {
  fail('No real AppID: set WX_APPID or replace "touristappid" in project.config.json.')
}

const keyPath = process.env.WX_UPLOAD_KEY || path.join(os.homedir(), '.wx-miniprogram', `private.${appid}.key`)
if (!fs.existsSync(keyPath)) {
  fail(
    `Upload key not found: ${keyPath}\n` +
      'Download it from 微信公众平台 → 开发 → 开发管理 → 开发设置 → 小程序代码上传, ' +
      'or point WX_UPLOAD_KEY at it.',
  )
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = String(arg('version', pkg.version))
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Version must look like 1.2.3, got "${version}".`)
const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim()
// The description distinguishes builds in the console, so it carries the commit.
const desc = String(arg('desc', `${sha} · ${new Date().toISOString().slice(0, 16)}`))
const robot = Number(arg('robot', 1))
if (!Number.isInteger(robot) || robot < 1 || robot > 30) fail('--robot must be an integer from 1 to 30.')

const ci = loadMiniprogramCi()
const project = new ci.Project({
  appid,
  type: 'miniProgram',
  projectPath: ROOT,
  privateKeyPath: keyPath,
  ignores: ['node_modules/**/*', 'scripts/**/*', 'test/**/*'],
})

// TypeScript is compiled by the project's `useCompilerPlugins` setting.
const setting = { es6: true, enhance: true, minify: true }

console.log(`appid   ${appid}`)
console.log(`version ${version}`)
console.log(`desc    ${desc}`)
console.log(`robot   ${robot}`)

if (flag('preview')) {
  const qr = path.join(ROOT, 'preview.png')
  await ci.preview({ project, desc, setting, qrcodeFormat: 'image', qrcodeOutputDest: qr, robot })
  console.log(`\npreview QR code: ${qr}`)
} else {
  const result = await ci.upload({ project, version, desc, setting, robot })
  console.log('\nuploaded')
  for (const item of result?.subPackageInfo ?? []) {
    console.log(`  ${item.name}  ${(item.size / 1024).toFixed(1)} KB`)
  }
}
