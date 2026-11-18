/**
 * Transport-agnostic API client for docs/api-v1.md.
 *
 *  - Unwraps the `{ success, data, error }` envelope; failures become an
 *    {@link ApiError} whose `code` is the server's `error.code`. Callers branch
 *    on `code` only, never on `message`.
 *  - Authenticated calls refresh the access token single-flight: callers that
 *    hit a 401 together share one `POST /v1/auth/refresh`, and each retries
 *    exactly once. A token already near expiry is refreshed before sending.
 *  - `REFRESH_INVALID` / `REFRESH_REUSED` drop the stored tokens and sign in
 *    again through the injected `relogin` (also single-flight).
 *
 * `wx` never appears here: the transport and the token store are injected,
 * so the whole flow runs under `node --test` with fakes.
 */
import type { TokenPair } from './types'

export type ApiErrorKind = 'network' | 'timeout' | 'aborted' | 'http' | 'protocol' | 'auth'

export interface ApiErrorFields {
  readonly kind: ApiErrorKind
  readonly code: string
  readonly message: string
  readonly status?: number | null
  readonly details?: unknown
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly code: string
  readonly status: number | null
  readonly details: unknown

  constructor(fields: ApiErrorFields) {
    super(fields.message)
    // Transpiled `extends Error` can lose the prototype; keep `instanceof` honest.
    Object.setPrototypeOf(this, new.target.prototype)
    this.name = 'ApiError'
    this.kind = fields.kind
    this.code = fields.code
    this.status = fields.status ?? null
    this.details = fields.details
  }
}

/** Structural check that also survives a transpiled class hierarchy. */
export function isApiError(value: unknown): value is ApiError {
  if (value instanceof ApiError) return true
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { name?: unknown; code?: unknown; kind?: unknown }
  return candidate.name === 'ApiError' && typeof candidate.code === 'string' && typeof candidate.kind === 'string'
}

/** Codes after which the refresh token is dead and only a new login helps. */
export const AUTH_LOST_CODES: readonly string[] = ['REFRESH_INVALID', 'REFRESH_REUSED']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseBody = (body: unknown): unknown => {
  if (typeof body !== 'string') return body
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/**
 * Returns `data` of a success envelope, or throws the matching {@link ApiError}.
 * `body` may be raw text or an object the platform already parsed.
 */
export function parseEnvelope(status: number, body: unknown): unknown {
  const value = parseBody(body)
  if (isRecord(value) && value['success'] === true && 'data' in value && status >= 200 && status < 300) {
    return value['data']
  }
  const error = isRecord(value) && value['success'] === false ? value['error'] : undefined
  if (isRecord(error) && typeof error['code'] === 'string') {
    const message = typeof error['message'] === 'string' && error['message'] !== '' ? error['message'] : error['code']
    throw new ApiError({ kind: 'http', status, code: error['code'], message, details: error['details'] })
  }
  if (status >= 400) {
    throw new ApiError({ kind: 'http', status, code: `HTTP_${status}`, message: `HTTP ${status}` })
  }
  throw new ApiError({ kind: 'protocol', status, code: 'BAD_RESPONSE', message: `unexpected response (HTTP ${status})` })
}

const numberDetail = (details: unknown, key: string): number | null => {
  if (!isRecord(details)) return null
  const value = details[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null
}

const MESSAGES: Readonly<Record<string, string>> = {
  VALIDATION_FAILED: '内容不符合要求',
  NOT_FOUND: '没有找到',
  AI_UPSTREAM: '翻译服务暂时不可用，请重试',
  AI_UNAVAILABLE: '翻译服务暂未开放',
  INTERNAL: '服务出错，请重试',
  STREAM_INCOMPLETE: '连接中断，请重试',
  TTS_UPSTREAM: '朗读暂时不可用，请重试',
  TTS_UNAVAILABLE: '朗读功能未开启',
  NOTHING_TO_SPEAK: '没有可朗读的内容',
  TEXT_TOO_LONG: '内容太长，无法朗读',
  INVITE_REQUIRED: '需要邀请码',
  INVITE_INVALID: '邀请码无效、已使用或已过期',
  ACCOUNT_DISABLED: '账号已停用',
  WECHAT_CODE_INVALID: '登录失败，请重试',
  WECHAT_UNAVAILABLE: '微信登录暂时不可用，请稍后再试',
  UNAUTHORIZED: '登录已过期，请重新打开小程序',
  REFRESH_INVALID: '登录已过期，请重新打开小程序',
  REFRESH_REUSED: '登录已失效，请重新打开小程序',
  NOT_LOGGED_IN: '还没有登录',
}

const DEFAULT_MESSAGE = '出了点问题，请重试'

/**
 * The Chinese sentence shown for an error. `overrides` lets a screen word a
 * code for its own context (e.g. `NOT_FOUND` while approving a CLI login).
 */
export function errorMessage(error: unknown, overrides: Readonly<Record<string, string>> = {}): string {
  if (!isApiError(error)) return DEFAULT_MESSAGE
  const override = overrides[error.code]
  if (override !== undefined) return override
  if (error.kind === 'network') return '需要联网'
  if (error.kind === 'timeout') return '网络不太稳定，请重试'
  if (error.code === 'RATE_LIMITED') {
    const seconds = numberDetail(error.details, 'retryAfterSeconds')
    return seconds === null ? '操作太频繁，请稍后再试' : `操作太频繁，请 ${seconds} 秒后再试`
  }
  if (error.code === 'QUOTA_EXCEEDED') {
    const limit = numberDetail(error.details, 'limit')
    return limit === null ? '今天的次数已用完，明天再来' : `今天的 ${limit} 次已用完，明天再来`
  }
  return MESSAGES[error.code] ?? DEFAULT_MESSAGE
}

export type HttpMethod = 'GET' | 'POST' | 'DELETE'

export interface HttpRequest {
  readonly method: HttpMethod
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: unknown
}

export interface HttpResponse {
  readonly status: number
  /** Raw text or an already-parsed JSON value. */
  readonly body: unknown
}

/** Sends one request. Rejects with an {@link ApiError} (`network`/`timeout`/`aborted`) when no response arrives. */
export type Transport = (request: HttpRequest) => Promise<HttpResponse>

export interface StoredTokens {
  readonly accessToken: string
  readonly refreshToken: string
  /** Epoch milliseconds, computed on receipt from `accessTokenExpiresIn`. */
  readonly accessTokenExpiresAt: number
  readonly deviceId: string
  readonly userId: string
}

export interface TokenStore {
  read(): StoredTokens | null
  write(tokens: StoredTokens): void
  clear(): void
}

export function isTokenPair(value: unknown): value is TokenPair {
  return (
    isRecord(value) &&
    typeof value['accessToken'] === 'string' &&
    typeof value['refreshToken'] === 'string' &&
    typeof value['accessTokenExpiresIn'] === 'number' &&
    typeof value['deviceId'] === 'string' &&
    isRecord(value['user']) &&
    typeof value['user']['id'] === 'string'
  )
}

export function tokensFromPair(pair: TokenPair, now: number): StoredTokens {
  return {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    accessTokenExpiresAt: now + pair.accessTokenExpiresIn * 1000,
    deviceId: pair.deviceId,
    userId: pair.user.id,
  }
}

/** Refresh this long before the access token expires. */
export const REFRESH_SKEW_MS = 30_000

export interface RequestOptions {
  readonly method: HttpMethod
  readonly path: string
  readonly query?: Readonly<Record<string, string | number | null | undefined>>
  readonly body?: unknown
  /** `false` for the unauthenticated auth routes. Defaults to true. */
  readonly auth?: boolean
}

export interface ApiClientOptions {
  readonly baseUrl: string
  readonly transport: Transport
  readonly tokens: TokenStore
  /** Signs in from scratch; must store new tokens before resolving. */
  readonly relogin: () => Promise<void>
  readonly now?: () => number
}

export interface ApiClient {
  readonly baseUrl: string
  /** JSON request; resolves to the envelope's `data`. */
  request<T>(options: RequestOptions): Promise<T>
  /**
   * Runs `attempt` with a valid access token. If it rejects with a 401
   * {@link ApiError}, the token is refreshed (single-flight) and `attempt`
   * runs once more. For requests that are not plain JSON (streams, audio).
   */
  authorized<T>(attempt: (accessToken: string) => Promise<T>): Promise<T>
}

export function buildUrl(baseUrl: string, path: string, query: RequestOptions['query']): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length === 0 ? `${baseUrl}${path}` : `${baseUrl}${path}?${parts.join('&')}`
}

const isUnauthorized = (error: unknown): boolean => isApiError(error) && error.status === 401

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { baseUrl, transport, tokens, relogin } = options
  const now = options.now ?? Date.now
  let refreshing: Promise<string> | null = null
  let relogging: Promise<void> | null = null

  const send = async (request: RequestOptions, accessToken: string | null): Promise<unknown> => {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (request.body !== undefined) headers['content-type'] = 'application/json'
    if (accessToken !== null) headers['authorization'] = `Bearer ${accessToken}`
    const response = await transport({
      method: request.method,
      url: buildUrl(baseUrl, request.path, request.query),
      headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    })
    return parseEnvelope(response.status, response.body)
  }

  const reloginOnce = (): Promise<void> => {
    relogging ??= relogin().finally(() => {
      relogging = null
    })
    return relogging
  }

  const storedAccessToken = (): string => {
    const stored = tokens.read()
    if (stored === null) throw new ApiError({ kind: 'auth', code: 'NOT_LOGGED_IN', message: 'not logged in' })
    return stored.accessToken
  }

  const doRefresh = async (stale: string): Promise<string> => {
    const current = tokens.read()
    if (current === null) {
      await reloginOnce()
      return storedAccessToken()
    }
    // Someone else rotated the pair after `stale` was read: use theirs.
    if (current.accessToken !== stale && current.accessTokenExpiresAt - REFRESH_SKEW_MS > now()) {
      return current.accessToken
    }
    let pair: unknown
    try {
      pair = await send(
        { method: 'POST', path: '/v1/auth/refresh', body: { refreshToken: current.refreshToken } },
        null,
      )
    } catch (error: unknown) {
      if (!isApiError(error) || !AUTH_LOST_CODES.includes(error.code)) throw error
      tokens.clear()
      await reloginOnce()
      return storedAccessToken()
    }
    if (!isTokenPair(pair)) {
      throw new ApiError({ kind: 'protocol', code: 'BAD_RESPONSE', message: 'malformed token pair' })
    }
    tokens.write(tokensFromPair(pair, now()))
    return pair.accessToken
  }

  const refresh = (stale: string): Promise<string> => {
    refreshing ??= doRefresh(stale).finally(() => {
      refreshing = null
    })
    return refreshing
  }

  const validAccessToken = async (): Promise<string> => {
    // Wait for a rotation in progress instead of racing it with the old token.
    if (refreshing !== null) return refreshing
    const stored = tokens.read()
    if (stored === null) {
      await reloginOnce()
      return storedAccessToken()
    }
    if (stored.accessTokenExpiresAt - REFRESH_SKEW_MS <= now()) return refresh(stored.accessToken)
    return stored.accessToken
  }

  const authorized = async <T>(attempt: (accessToken: string) => Promise<T>): Promise<T> => {
    const token = await validAccessToken()
    try {
      return await attempt(token)
    } catch (error: unknown) {
      if (!isUnauthorized(error)) throw error
      return attempt(await refresh(token))
    }
  }

  return {
    baseUrl,
    async request<T>(request: RequestOptions): Promise<T> {
      if (request.auth === false) return (await send(request, null)) as T
      return (await authorized((token) => send(request, token))) as T
    },
    authorized,
  }
}
