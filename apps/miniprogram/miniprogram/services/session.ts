/**
 * Sign-in and the shared API client.
 *
 * First launch: a silent `wx.login` → `POST /v1/auth/wechat`. An unknown
 * WeChat identity gets `INVITE_REQUIRED`, which sends the user to the invite
 * page; after that, every launch reuses the stored tokens, and the client
 * refreshes or signs in again on its own (lib/api.ts).
 */
import {
  ApiError,
  createApiClient,
  isApiError,
  isTokenPair,
  tokensFromPair,
  type ApiClient,
  type StoredTokens,
  type TokenStore,
} from '../lib/api'
import type { TokenPair } from '../lib/types'
import { wxTransport } from './http'
import { apiBaseUrl, devLogin, deviceName } from './platform'
import { STORAGE_KEYS, readStorage, removeStorage, writeStorage } from './storage'

const isStoredTokens = (value: unknown): value is StoredTokens => {
  if (typeof value !== 'object' || value === null) return false
  const tokens = value as Record<string, unknown>
  return (
    typeof tokens['accessToken'] === 'string' &&
    typeof tokens['refreshToken'] === 'string' &&
    typeof tokens['accessTokenExpiresAt'] === 'number' &&
    typeof tokens['deviceId'] === 'string' &&
    typeof tokens['userId'] === 'string'
  )
}

const tokenStore: TokenStore = {
  read() {
    const value = readStorage(STORAGE_KEYS.tokens)
    return isStoredTokens(value) ? value : null
  },
  write(tokens) {
    writeStorage(STORAGE_KEYS.tokens, tokens)
  },
  clear() {
    removeStorage(STORAGE_KEYS.tokens)
  },
}

/** `wx.login()` as a promise; the code is single-use and short-lived. */
const wxLoginCode = (): Promise<string> =>
  new Promise((resolve, reject) => {
    wx.login({
      success: (result) => resolve(result.code),
      // Almost always "no network" in practice.
      fail: (error) => reject(new ApiError({ kind: 'network', code: 'WX_LOGIN_FAILED', message: error.errMsg })),
    })
  })

/** A fresh login code: `dev:<name>` against a local dev server, otherwise from WeChat. */
const loginCode = async (): Promise<string> => devLogin() ?? (await wxLoginCode())

const exchange = async (body: { code: string; inviteCode?: string }): Promise<TokenPair> => {
  const pair = await api.request<unknown>({
    method: 'POST',
    path: '/v1/auth/wechat',
    body: { ...body, deviceName: deviceName() },
    auth: false,
  })
  if (!isTokenPair(pair)) {
    throw new ApiError({ kind: 'protocol', code: 'BAD_RESPONSE', message: 'malformed token pair' })
  }
  tokenStore.write(tokensFromPair(pair, Date.now()))
  return pair
}

let silentLogin: Promise<void> | null = null

/**
 * Signs in without user interaction; rejects with `INVITE_REQUIRED` for a new
 * user. Single-flight: the launch-time sign-in and a request that finds no
 * tokens share one login (each login creates a device on the server).
 */
export function loginSilently(): Promise<void> {
  silentLogin ??= loginCode()
    .then((code) => exchange({ code }))
    .then(() => undefined)
    .finally(() => {
      silentLogin = null
    })
  return silentLogin
}

/** Creates the account with an invite code (the code from `wx.login` is single-use, so a new one is fetched). */
export async function loginWithInvite(inviteCode: string): Promise<void> {
  await exchange({ code: await loginCode(), inviteCode: inviteCode.trim() })
}

export const api: ApiClient = createApiClient({
  baseUrl: apiBaseUrl(),
  transport: wxTransport,
  tokens: tokenStore,
  relogin: loginSilently,
})

export function hasSession(): boolean {
  return tokenStore.read() !== null
}

export type SessionState = 'ready' | 'invite'

/**
 * Makes sure there is a session. A failure (for example offline at launch) is
 * not remembered, so the next call or request tries again.
 */
export async function ensureSession(): Promise<SessionState> {
  if (hasSession()) return 'ready'
  try {
    await loginSilently()
    return 'ready'
  } catch (error: unknown) {
    if (isApiError(error) && error.code === 'INVITE_REQUIRED') return 'invite'
    throw error
  }
}

export const INVITE_PAGE = '/pages/invite/index'

/**
 * Sends a new user to the invite page. Returns true when `error` meant
 * "needs an invite", so the caller stops handling it.
 */
export function redirectIfInviteRequired(error: unknown): boolean {
  if (!isApiError(error) || error.code !== 'INVITE_REQUIRED') return false
  wx.reLaunch({ url: INVITE_PAGE, fail: () => undefined })
  return true
}
