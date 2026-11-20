# t-cli mini-program

The phone side of t-cli (milestone M2): translate and grammar check, plus the
account pages. WeChat native + TypeScript + Skyline, the same stack as
heji-ledger's mini-program. The API contract is `docs/api-v1.md`.

Tabs: **翻译** (default), **纠错**, **我的** (记录, 解释语言, 设备, 授权 CLI 登录).

## Structure

```
apps/miniprogram/
  project.config.json        DevTools / miniprogram-ci project (AppID wxadc6ad8824563aa0)
  tsconfig.json              type check of miniprogram/ (mini-program typings, no Node types)
  test/                      node --test unit tests for miniprogram/lib (+ test/tsconfig.json)
  scripts/sync-core.mjs      copies packages/core modules into miniprogram/vendor/core
  scripts/upload.mjs         miniprogram-ci upload / preview (used by .github/workflows/mp-upload.yml)
  miniprogram/
    app.json app.ts app.wxss theme.json sitemap.json
    config.local.example.ts  template for the git-ignored config.local.ts (dev only)
    lib/                     pure logic, no `wx`: unit-tested under Node
      api.ts                 envelope, ApiError, Chinese error text, single-flight refresh
      utf8.ts                incremental UTF-8 decoder (chunks may split a character)
      ndjson.ts              line splitter + stream event parser for /v1/ai/translate
      result.ts              result state machine, direction label / flip
      output.ts              word headline (term /IPA/ gloss), first line, markdown cleanup
      word-diff.ts           word-level diff for 纠错
      user-code.ts           tcli://device?code=NNNNNN and typed 6-digit codes
      history.ts             history paging, row and time formatting
      env.ts                 API base URL and dev login by envVersion
      tts-cache.ts           audio file naming and eviction
    services/                wx-bound glue: request transport, session, stream, TTS, voice, theme
    pages/                   translate, check, me, history, devices, authorize, invite
    components/nav-bar/      custom navigation bar (Skyline pages have no native one)
    vendor/core/detect.js    GENERATED copy of packages/core/src/detect.js
```

### How TypeScript is compiled

DevTools and miniprogram-ci compile the `.ts` files themselves
(`setting.useCompilerPlugins: ["typescript"]`): Babel strips the types and turns
ES modules into the CommonJS the runtime loads. `tsconfig.json` is only for
`tsc --noEmit`; that is why imports inside `miniprogram/` have no extensions.

### How tests import modules

`node --test` runs the tests with Node 24's type stripping. Tests import the
modules under test with explicit `.ts` extensions
(`../miniprogram/lib/utf8.ts`). Modules in `miniprogram/lib` never import
another module by value, only `import type` (erased before Node resolves
anything), and composition happens by injection (e.g. the NDJSON collector
takes the UTF-8 decoder as a parameter). `verbatimModuleSyntax` and
`erasableSyntaxOnly` enforce what type stripping needs.

### Shared logic from packages/core

The mini-program compiler only sees `miniprogram/`, so `@t-cli/core` cannot be
imported. `scripts/sync-core.mjs` copies self-contained core modules verbatim
into `miniprogram/vendor/core/` and `test/vendor-sync.test.ts` fails while a copy
is stale. After changing such a module in `packages/core`:

```sh
npm run sync:core -w @t-cli/miniprogram
```

Only `detect.js` is vendored (the 纠错 tab uses `detectSourceLang` to send
non-English input to 翻译). The translate direction comes from the server's
`meta` line, and TTS text selection happens on the server.

## Commands

From the repository root:

```sh
npm install
npm test                                   # every workspace, including these tests
npm test -w @t-cli/miniprogram             # just the mini-program
npm run typecheck -w @t-cli/miniprogram    # tsc for miniprogram/ and test/
```

## Run in WeChat DevTools against a local server

1. Start the dev database and the server with dev login enabled
   (`DATABASE_URL`, `JWT_SECRET` and the rest: see `apps/server/src/config.ts`
   and `apps/server/deploy/README.md`):

   ```sh
   docker compose -f apps/server/docker-compose.dev.yml up -d
   WECHAT_DEV_LOGIN=1 npm start -w @t-cli/server   # PORT defaults to 3000
   npm run admin -w @t-cli/server -- invite        # invite code for the first sign-in
   ```

2. `cp miniprogram/config.local.example.ts miniprogram/config.local.ts` and set
   `devLoginName` (1–32 of `[a-z0-9_-]`). In the develop environment login then
   sends `code = "dev:<name>"` instead of a `wx.login` code, so the server maps
   it to the openid `dev_<name>` without calling WeChat. Trial and release
   builds never read this file.

3. Import `apps/miniprogram` in DevTools (the folder with `project.config.json`).
   `urlCheck` is off in the project config, so the simulator may call
   `http://127.0.0.1:3000`. The first launch asks for an invite code, then
   lands on 翻译.

For a phone (真机调试), set `apiBaseUrl` in `config.local.ts` to this machine's
LAN address (`ipconfig getifaddr en0`); a phone's `127.0.0.1` is the phone.

The API host is chosen at runtime from
`wx.getAccountInfoSync().miniProgram.envVersion`: develop →
`http://127.0.0.1:3000` (or `apiBaseUrl`), trial and release →
`https://tcli.guangqingai.top`.

## What you must configure

| What | Where |
| --- | --- |
| **AppID** | Done: `project.config.json` carries the real AppID `wxadc6ad8824563aa0` (随手译记). `scripts/upload.mjs` reads it from there; the repository variable `WX_APPID` is only an optional override. |
| **WechatSI plugin** (同声传译, voice input) | Admin console → 设置 → 第三方设置 → 插件管理 → add 微信同声传译 (`wx069ba97219f66d99`). `app.json` declares version `0.3.6`. Without it voice input reports 语音输入不可用. Plugin traffic does not need entries in the server domain lists. |
| **Request domain whitelist** | Admin console → 开发 → 开发管理 → 开发设置 → 服务器域名: request `https://tcli.guangqingai.top`; DNS 预解析 `tcli.guangqingai.top` and 预连接 `https://tcli.guangqingai.top` (optional, shave the first request's DNS/TLS time). All other lists stay empty: only `wx.request` is used (JSON, the NDJSON stream and the TTS audio), no socket/upload/download/UDP/TCP. The reverse proxy must not buffer `/v1/ai/translate` (see the contract). For local development, DevTools → 详情 → 本地设置 → 不校验合法域名. |
| **Privacy guide** | Admin console → 设置 → 服务内容声明 → 用户隐私保护指引: declare microphone (voice input) and clipboard (copy) use. WeChat shows its own consent prompt before the first recording. |
| **Upload key** | Admin console → 开发 → 开发管理 → 开发设置 → 小程序代码上传: download the key, store its full text as the repository secret `WX_UPLOAD_PRIVATE_KEY`, and disable the key's IP whitelist (GitHub runners have no fixed IP). Never commit the key. |

## Upload a build

GitHub → Actions → **Mini-program upload** → Run workflow with a version
(`x.y.z`). It type-checks, runs the unit tests, installs miniprogram-ci
outside the repo, writes the key to a temporary file and uploads; pick the
uploaded version as 体验版 in the admin console. Locally:

```sh
npm install --prefix /tmp/mpci miniprogram-ci@2.1.31
MINIPROGRAM_CI_DIR=/tmp/mpci WX_APPID=wx... WX_UPLOAD_KEY=~/.wx-miniprogram/private.wx....key \
  node apps/miniprogram/scripts/upload.mjs --version 0.1.0 --desc "M2 体验版"
```

## Behaviour notes

- **Login**: silent `wx.login` → `POST /v1/auth/wechat`. `INVITE_REQUIRED` →
  invite page → 翻译. Tokens live in storage; refresh is single-flight, a 401
  refreshes once and retries, `REFRESH_INVALID`/`REFRESH_REUSED` log in again.
- **Streaming**: `wx.request` with `enableChunked` + `onChunkReceived`; bytes
  are decoded with `lib/utf8.ts` (no reliance on `TextDecoder`) and split into
  NDJSON lines; unknown line types are ignored. The HTTP status is taken from
  the completed request because DevTools does not report it in
  `onHeadersReceived`. A new submit aborts the running request.
- **Settings** are saved with `POST /v1/me/settings` (`wx.request` has no PATCH).
- **Errors** branch on `error.code` only; no network → 需要联网.
- **Theme** follows the system (`theme.json` for native chrome, CSS variables
  switched by a root class for pages, which works under Skyline and WebView).
- **Skyline**: pages use `navigationStyle: custom` + `disableScroll` with a
  `scroll-view` body, as Skyline requires. Clients without Skyline fall back to
  WebView automatically; to force WebView everywhere, remove `renderer`,
  `componentFramework` and `rendererOptions` from `app.json`.
