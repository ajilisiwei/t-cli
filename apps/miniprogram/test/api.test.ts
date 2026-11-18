import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ApiError,
  createApiClient,
  errorMessage,
  isApiError,
  parseEnvelope,
  type HttpRequest,
  type HttpResponse,
  type StoredTokens,
  type TokenStore,
} from '../miniprogram/lib/api.ts'

const BASE = 'https://api.test'
const NOW = 1_800_000_000_000

const ok = (data: unknown, status = 200): HttpResponse => ({ status, body: { success: true, data, error: null } })
const fail = (status: number, code: string, details?: unknown): HttpResponse => ({
  status,
  body: { success: false, data: null, error: { code, message: code.toLowerCase(), ...(details === undefined ? {} : { details }) } },
})

const tokens = (access: string, refresh: string, expiresAt = NOW + 900_000): StoredTokens => ({
  accessToken: access,
  refreshToken: refresh,
  accessTokenExpiresAt: expiresAt,
  deviceId: 'dev1',
  userId: 'user1',
})

const pair = (access: string, refresh: string) => ({
  accessToken: access,
  refreshToken: refresh,
  accessTokenExpiresIn: 900,
  user: { id: 'user1', role: 'member' },
  deviceId: 'dev1',
})

const memoryStore = (initial: StoredTokens | null): TokenStore & { current: StoredTokens | null } => {
  const store = {
    current: initial,
    read: () => store.current,
    write: (next: StoredTokens) => {
      store.current = next
    },
    clear: () => {
      store.current = null
    },
  }
  return store
}

type Handler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>

/** Records every request; `handler` plays the server. */
const fakeTransport = (handler: Handler) => {
  const calls: HttpRequest[] = []
  const transport = async (request: HttpRequest): Promise<HttpResponse> => {
    calls.push(request)
    // Yield so concurrent callers really overlap.
    await new Promise((resolve) => setImmediate(resolve))
    return handler(request)
  }
  return { calls, transport }
}

const bearer = (request: HttpRequest): string | undefined => request.headers['authorization']
const refreshCalls = (calls: readonly HttpRequest[]) => calls.filter((call) => call.url.endsWith('/v1/auth/refresh'))

test('parseEnvelope returns data and throws coded errors', () => {
  assert.deepEqual(parseEnvelope(200, { success: true, data: { a: 1 }, error: null }), { a: 1 })
  assert.deepEqual(parseEnvelope(200, '{"success":true,"data":[1],"error":null}'), [1])
  assert.throws(
    () => parseEnvelope(429, '{"success":false,"data":null,"error":{"code":"RATE_LIMITED","message":"slow","details":{"retryAfterSeconds":12}}}'),
    (error: unknown) =>
      isApiError(error) && error.code === 'RATE_LIMITED' && error.status === 429 && error.kind === 'http',
  )
  assert.throws(() => parseEnvelope(502, '<html>Bad Gateway</html>'), (error: unknown) => isApiError(error) && error.code === 'HTTP_502')
  assert.throws(() => parseEnvelope(200, 'nonsense'), (error: unknown) => isApiError(error) && error.code === 'BAD_RESPONSE')
  // A 200 that claims failure is still a failure.
  assert.throws(() => parseEnvelope(200, { success: false, error: { code: 'X' } }), (error: unknown) => isApiError(error) && error.code === 'X')
})

test('errorMessage maps codes and error kinds to Chinese text', () => {
  const http = (code: string, details?: unknown) => new ApiError({ kind: 'http', code, message: code, status: 400, details })
  assert.equal(errorMessage(new ApiError({ kind: 'network', code: 'NETWORK', message: 'request:fail' })), '需要联网')
  assert.equal(errorMessage(http('QUOTA_EXCEEDED', { limit: 200 })), '今天的 200 次已用完，明天再来')
  assert.equal(errorMessage(http('QUOTA_EXCEEDED')), '今天的次数已用完，明天再来')
  assert.equal(errorMessage(http('RATE_LIMITED', { retryAfterSeconds: 7.2 })), '操作太频繁，请 8 秒后再试')
  assert.equal(errorMessage(http('RATE_LIMITED')), '操作太频繁，请稍后再试')
  assert.equal(errorMessage(http('INVITE_INVALID')), '邀请码无效、已使用或已过期')
  assert.equal(errorMessage(http('SOMETHING_NEW')), '出了点问题，请重试')
  assert.equal(errorMessage(http('NOT_FOUND'), { NOT_FOUND: '授权码无效或已过期' }), '授权码无效或已过期')
  assert.equal(errorMessage(new Error('boom')), '出了点问题，请重试')
  // The message text from the server is never shown or branched on.
  assert.equal(errorMessage(new ApiError({ kind: 'http', code: 'AI_UPSTREAM', message: 'secret details' })), '翻译服务暂时不可用，请重试')
})

test('isApiError recognises errors whose prototype was lost in transpilation', () => {
  const plain = Object.assign(new Error('x'), { name: 'ApiError', code: 'X', kind: 'http' })
  assert.equal(isApiError(plain), true)
  assert.equal(isApiError({ code: 'X' }), false)
})

test('request attaches the bearer token and unwraps data', async () => {
  const store = memoryStore(tokens('a1', 'r1'))
  const { calls, transport } = fakeTransport(() => ok({ settings: { explanationLang: 'en' } }))
  const client = createApiClient({ baseUrl: BASE, transport, tokens: store, relogin: async () => {}, now: () => NOW })
  const data = await client.request({ method: 'POST', path: '/v1/me/settings', body: { explanationLang: 'en' } })
  assert.deepEqual(data, { settings: { explanationLang: 'en' } })
  assert.equal(calls[0]?.url, `${BASE}/v1/me/settings`)
  assert.equal(calls[0]?.method, 'POST')
  assert.equal(bearer(calls[0] as HttpRequest), 'Bearer a1')
  assert.equal(calls[0]?.headers['content-type'], 'application/json')
})

test('query parameters are encoded and empty ones dropped', async () => {
  const { calls, transport } = fakeTransport(() => ok({ entries: [] }))
  const client = createApiClient({ baseUrl: BASE, transport, tokens: memoryStore(tokens('a1', 'r1')), relogin: async () => {}, now: () => NOW })
  await client.request({ method: 'GET', path: '/v1/entries/history', query: { before: null, limit: 30 } })
  await client.request({ method: 'GET', path: '/v1/entries/history', query: { before: 41, limit: 30 } })
  assert.equal(calls[0]?.url, `${BASE}/v1/entries/history?limit=30`)
  assert.equal(calls[1]?.url, `${BASE}/v1/entries/history?before=41&limit=30`)
  assert.equal(calls[0]?.headers['content-type'], undefined)
})

test('a 401 refreshes once and retries with the new token', async () => {
  const store = memoryStore(tokens('a1', 'r1'))
  const { calls, transport } = fakeTransport((request) => {
    if (request.url.endsWith('/v1/auth/refresh')) return ok(pair('a2', 'r2'))
    return bearer(request) === 'Bearer a2' ? ok({ devices: [] }) : fail(401, 'UNAUTHORIZED')
  })
  const client = createApiClient({ baseUrl: BASE, transport, tokens: store, relogin: async () => {}, now: () => NOW })
  assert.deepEqual(await client.request({ method: 'GET', path: '/v1/devices' }), { devices: [] })
  assert.equal(refreshCalls(calls).length, 1)
  assert.deepEqual(refreshCalls(calls)[0]?.body, { refreshToken: 'r1' })
  assert.equal(refreshCalls(calls)[0]?.headers['authorization'], undefined)
  assert.equal(store.current?.accessToken, 'a2')
  assert.equal(store.current?.refreshToken, 'r2')
  assert.equal(store.current?.accessTokenExpiresAt, NOW + 900_000)
})

test('concurrent 401s share a single refresh', async () => {
  const store = memoryStore(tokens('a1', 'r1'))
  const { calls, transport } = fakeTransport((request) => {
    if (request.url.endsWith('/v1/auth/refresh')) return ok(pair('a2', 'r2'))
    return bearer(request) === 'Bearer a2' ? ok(request.url) : fail(401, 'UNAUTHORIZED')
  })
  const client = createApiClient({ baseUrl: BASE, transport, tokens: store, relogin: async () => {}, now: () => NOW })
  const results = await Promise.all(
    ['/v1/me', '/v1/devices', '/v1/entries/history'].map((path) => client.request({ method: 'GET', path })),
  )
  assert.deepEqual(results, [`${BASE}/v1/me`, `${BASE}/v1/devices`, `${BASE}/v1/entries/history`])
  assert.equal(refreshCalls(calls).length, 1)
})

test('a second 401 after refreshing is returned, not retried forever', async () => {
  const store = memoryStore(tokens('a1', 'r1'))
  const { calls, transport } = fakeTransport((request) =>
    request.url.endsWith('/v1/auth/refresh') ? ok(pair('a2', 'r2')) : fail(401, 'UNAUTHORIZED'),
  )
  const client = createApiClient({ baseUrl: BASE, transport, tokens: store, relogin: async () => {}, now: () => NOW })
  await assert.rejects(client.request({ method: 'GET', path: '/v1/me' }), (error: unknown) => isApiError(error) && error.status === 401)
  assert.equal(calls.length, 3) // request, refresh, retry
})

test('REFRESH_INVALID drops the tokens and logs in again', async () => {
  const store = memoryStore(tokens('a1', 'r1'))
  let relogins = 0
  const { calls, transport } = fakeTransport((request) => {
    if (request.url.endsWith('/v1/auth/refresh')) return fail(401, 'REFRESH_INVALID')
    return bearer(request) === 'Bearer fresh' ? ok('ok') : fail(401, 'UNAUTHORIZED')
  })
  const relogin = async (): Promise<void> => {
    relogins += 1
    assert.equal(store.current, null, 'stale tokens are cleared before logging in again')
    store.write(tokens('fresh', 'rfresh'))
  }
  const client = createApiClient({ baseUrl: BASE, transport, tokens: store, relogin, now: () => NOW })
  const results = await Promise.all([
    client.request({ method: 'GET', path: '/v1/me' }),
    client.request({ method: 'GET', path: '/v1/devices' }),
  ])
  assert.deepEqual(results, ['ok', 'ok'])
  assert.equal(relogins, 1)
  assert.equal(refreshCalls(calls).length, 1)
})

test('REFRESH_REUSED with a failing login surfaces the login error', async () => {
  const store = memoryStore(tokens('a1', 'r1'))
  const { transport } = fakeTransport((request) =>
    request.url.endsWith('/v1/auth/refresh') ? fail(401, 'REFRESH_REUSED') : fail(401, 'UNAUTHORIZED'),
  )
  const relogin = async (): Promise<void> => {
    throw new ApiError({ kind: 'http', code: 'INVITE_REQUIRED', message: 'invite', status: 403 })
  }
  const client = createApiClient({ baseUrl: BASE, transport, tokens: store, relogin, now: () => NOW })
  await assert.rejects(client.request({ method: 'GET', path: '/v1/me' }), (error: unknown) => isApiError(error) && error.code === 'INVITE_REQUIRED')
  assert.equal(store.current, null)
})

test('a network failure while refreshing keeps the tokens', async () => {
  const store = memoryStore(tokens('a1', 'r1'))
  const { transport } = fakeTransport((request) => {
    if (request.url.endsWith('/v1/auth/refresh')) throw new ApiError({ kind: 'network', code: 'NETWORK', message: 'request:fail' })
    return fail(401, 'UNAUTHORIZED')
  })
  const client = createApiClient({ baseUrl: BASE, transport, tokens: store, relogin: async () => assert.fail('must not log in'), now: () => NOW })
  await assert.rejects(client.request({ method: 'GET', path: '/v1/me' }), (error: unknown) => errorMessage(error) === '需要联网')
  assert.equal(store.current?.refreshToken, 'r1')
})

test('an expired access token is refreshed before sending', async () => {
  const store = memoryStore(tokens('a1', 'r1', NOW - 1))
  const { calls, transport } = fakeTransport((request) =>
    request.url.endsWith('/v1/auth/refresh') ? ok(pair('a2', 'r2')) : ok(bearer(request)),
  )
  const client = createApiClient({ baseUrl: BASE, transport, tokens: store, relogin: async () => {}, now: () => NOW })
  assert.equal(await client.request({ method: 'GET', path: '/v1/me' }), 'Bearer a2')
  assert.deepEqual(calls.map((call) => call.url), [`${BASE}/v1/auth/refresh`, `${BASE}/v1/me`])
})

test('a token rotated by another caller is used without refreshing again', async () => {
  const store = memoryStore(tokens('a1', 'r1'))
  const { calls, transport } = fakeTransport((request) => {
    if (bearer(request) === 'Bearer a1') {
      // Another caller rotated the pair while this request was in flight.
      store.write(tokens('a9', 'r9'))
      return fail(401, 'UNAUTHORIZED')
    }
    return ok(bearer(request))
  })
  const client = createApiClient({ baseUrl: BASE, transport, tokens: store, relogin: async () => {}, now: () => NOW })
  assert.equal(await client.request({ method: 'GET', path: '/v1/me' }), 'Bearer a9')
  assert.equal(refreshCalls(calls).length, 0)
})

test('without stored tokens the client logs in first', async () => {
  const store = memoryStore(null)
  const { transport } = fakeTransport((request) => ok(bearer(request)))
  const client = createApiClient({
    baseUrl: BASE,
    transport,
    tokens: store,
    relogin: async () => store.write(tokens('first', 'rfirst')),
    now: () => NOW,
  })
  assert.equal(await client.request({ method: 'GET', path: '/v1/me' }), 'Bearer first')
})

test('unauthenticated requests carry no token and never refresh', async () => {
  const { calls, transport } = fakeTransport(() => fail(403, 'INVITE_REQUIRED'))
  const client = createApiClient({ baseUrl: BASE, transport, tokens: memoryStore(tokens('a1', 'r1')), relogin: async () => {}, now: () => NOW })
  await assert.rejects(
    client.request({ method: 'POST', path: '/v1/auth/wechat', body: { code: 'dev:alice' }, auth: false }),
    (error: unknown) => isApiError(error) && error.code === 'INVITE_REQUIRED',
  )
  assert.equal(calls.length, 1)
  assert.equal(bearer(calls[0] as HttpRequest), undefined)
})

test('authorized() retries a custom attempt once after a 401', async () => {
  const store = memoryStore(tokens('a1', 'r1'))
  const { transport } = fakeTransport(() => ok(pair('a2', 'r2')))
  const client = createApiClient({ baseUrl: BASE, transport, tokens: store, relogin: async () => {}, now: () => NOW })
  const seen: string[] = []
  const result = await client.authorized(async (token) => {
    seen.push(token)
    if (token === 'a1') throw new ApiError({ kind: 'http', code: 'UNAUTHORIZED', message: 'x', status: 401 })
    return 'streamed'
  })
  assert.equal(result, 'streamed')
  assert.deepEqual(seen, ['a1', 'a2'])
})
