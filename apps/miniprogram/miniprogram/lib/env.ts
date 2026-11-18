/**
 * Which server a build talks to, decided at runtime from
 * `wx.getAccountInfoSync().miniProgram.envVersion` so one uploaded package is
 * right for 体验版 and 正式版 alike, and the DevTools simulator reaches a local
 * server without any edit.
 */

export type EnvVersion = 'develop' | 'trial' | 'release'

/** The server's default port; HTTP is fine only in DevTools with 不校验合法域名. */
export const DEVELOP_API_BASE_URL = 'http://127.0.0.1:3000'
/** HTTPS is mandatory on a device and the host must be on the request whitelist. */
export const PRODUCTION_API_BASE_URL = 'https://tcli.guangqingai.top'

export interface LocalOverrides {
  /** e.g. `http://192.168.1.10:3000` to reach the dev server from a phone. */
  readonly apiBaseUrl?: string
  /** Sends `dev:<name>` as the login code (server with `WECHAT_DEV_LOGIN=1`). */
  readonly devLoginName?: string
}

const DEV_LOGIN_NAME_RE = /^[a-z0-9_-]{1,32}$/

export function resolveApiBaseUrl(envVersion: EnvVersion, overrides: LocalOverrides): string {
  if (envVersion !== 'develop') return PRODUCTION_API_BASE_URL
  const local = overrides.apiBaseUrl?.trim().replace(/\/+$/, '')
  return local !== undefined && local !== '' ? local : DEVELOP_API_BASE_URL
}

/**
 * The fake login code for a development server, or null to use `wx.login`.
 * Never outside `develop`: a trial or release build always logs in for real.
 */
export function devLoginCode(envVersion: EnvVersion, overrides: LocalOverrides): string | null {
  if (envVersion !== 'develop') return null
  const name = overrides.devLoginName?.trim()
  return name !== undefined && DEV_LOGIN_NAME_RE.test(name) ? `dev:${name}` : null
}
