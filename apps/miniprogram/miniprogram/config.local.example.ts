/**
 * Development-only settings for this machine. Copy to `config.local.ts`
 * (git-ignored) and edit:
 *
 *     cp miniprogram/config.local.example.ts miniprogram/config.local.ts
 *
 * Read only when the build runs in the develop environment (DevTools, or a
 * real-device preview of the development version); trial and release builds
 * never load it. Without the file, development uses http://127.0.0.1:3000 and
 * a real `wx.login`.
 */
import type { LocalOverrides } from './lib/env'

export const LOCAL_OVERRIDES: LocalOverrides = {
  // Log in as `dev_alice` on a local server started with WECHAT_DEV_LOGIN=1
  // (the login code sent is `dev:alice`; 1–32 of [a-z0-9_-]).
  devLoginName: 'alice',
  // A phone cannot reach 127.0.0.1 on this machine: use its LAN address
  // (`ipconfig getifaddr en0`) for real-device debugging.
  apiBaseUrl: 'http://127.0.0.1:3000',
}
