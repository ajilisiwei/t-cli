// Sync client, auth store, server settings and the device-login state
// machine. Every test gets its own XDG_CONFIG_HOME, so the real
// ~/.config/t-cli is never touched; HTTP goes to a local fake server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { authFromTokenPair, clearAuth, getAuthPath, readAuth, writeAuth } from '../src/sync/authStore.js';
import { SyncError, classifyPollError, createSyncClient, isTransientError, parseEnvelope } from '../src/sync/client.js';
import { LOGIN_IDLE, SLOW_DOWN_STEP_MS, loginReducer } from '../src/sync/deviceFlow.js';
import { defaultDeviceName, pollDeviceLogin, renderQr } from '../src/sync/login.js';
import { normalizeServerUrl, resolveServerUrl } from '../src/sync/settings.js';
import { buildSyncStatusLines, formatSyncIndicator } from '../src/sync/status.js';

// ---------------------------------------------------------------- helpers

function useTempConfig(t) {
  const previous = process.env.XDG_CONFIG_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-sync-'));
  process.env.XDG_CONFIG_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, 't-cli');
}

const okBody = (data) => ({ status: 200, body: { success: true, data, error: null } });
const failBody = (status, code, details) => ({
  status,
  body: { success: false, data: null, error: { code, message: `${code} message`, ...(details ? { details } : {}) } },
});

/**
 * Local fake API server. `handler(req)` returns { status, body } | { status, raw } | 'hang'.
 */
async function startFakeServer(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const record = { method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body: raw ? JSON.parse(raw) : undefined };
      requests.push(record);
      const reply = await handler(record, requests);
      if (reply === 'hang') return;
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
      res.end(reply.raw ?? JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

const PAIR = (n) => ({
  accessToken: `access-${n}`,
  refreshToken: `device-1.refresh-${n}`,
  accessTokenExpiresIn: 900,
  user: { id: 'user-1', role: 'member' },
  deviceId: 'device-1',
});

/** Store credentials for `serverUrl` whose access token is `access-<n>`. */
function storeAuth(serverUrl, n, { expiresInMs = 900_000 } = {}) {
  const auth = authFromTokenPair(PAIR(n), { serverUrl, now: Date.now() });
  const written = writeAuth({ ...auth, accessTokenExpiresAt: new Date(Date.now() + expiresInMs).toISOString() });
  assert.equal(written.ok, true);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- envelope

test('parseEnvelope: success data, error codes, HTTP errors and malformed bodies', () => {
  assert.deepEqual(parseEnvelope(200, JSON.stringify({ success: true, data: { a: 1 }, error: null })), { a: 1 });

  const envelopeError = (() => {
    try {
      parseEnvelope(400, JSON.stringify({ success: false, data: null, error: { code: 'VALIDATION_FAILED', message: 'bad', details: [{ path: 'x', message: 'y' }] } }));
    } catch (error) {
      return error;
    }
    return null;
  })();
  assert.ok(envelopeError instanceof SyncError);
  assert.equal(envelopeError.kind, 'http');
  assert.equal(envelopeError.code, 'VALIDATION_FAILED');
  assert.equal(envelopeError.status, 400);
  assert.deepEqual(envelopeError.details, [{ path: 'x', message: 'y' }]);
  assert.equal(isTransientError(envelopeError), false);

  assert.throws(
    () => parseEnvelope(429, JSON.stringify({ success: false, data: null, error: { code: 'RATE_LIMITED', message: 'slow', details: { retryAfterSeconds: 7 } } })),
    (error) => error.code === 'RATE_LIMITED' && error.retryAfterMs === 7000 && isTransientError(error),
  );
  assert.throws(() => parseEnvelope(502, '<html>bad gateway</html>'), (error) => error.code === 'HTTP_502' && isTransientError(error));
  assert.throws(() => parseEnvelope(200, 'not json'), (error) => error.kind === 'protocol' && error.code === 'BAD_RESPONSE');
  assert.throws(() => parseEnvelope(200, JSON.stringify({ ok: true })), (error) => error.code === 'BAD_RESPONSE');
});

test('client: error envelopes from the server surface their code; requests carry the bearer token', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, () => failBody(400, 'VALIDATION_FAILED', [{ path: 'entries', message: 'too big' }]));
  storeAuth(api.url, 1);
  const client = createSyncClient({ serverUrl: api.url });
  await assert.rejects(client.pushEntries([]), (error) => error instanceof SyncError && error.code === 'VALIDATION_FAILED' && error.status === 400);
  assert.equal(api.requests[0].authorization, 'Bearer access-1');
  assert.equal(api.requests[0].url, '/v1/entries');
});

test('client: network errors and timeouts are transient SyncErrors', async (t) => {
  useTempConfig(t);
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const deadUrl = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((resolve) => closed.close(resolve));

  const dead = createSyncClient({ serverUrl: deadUrl });
  await assert.rejects(dead.startDeviceAuth({ deviceName: 'x' }), (error) => error.kind === 'network' && isTransientError(error));

  const api = await startFakeServer(t, () => 'hang');
  const slow = createSyncClient({ serverUrl: api.url, timeoutMs: 100 });
  await assert.rejects(slow.startDeviceAuth({ deviceName: 'x' }), (error) => error.kind === 'timeout' && isTransientError(error));

  const controller = new AbortController();
  const pending = slow.startDeviceAuth({ deviceName: 'x', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.kind === 'aborted');
});

// ---------------------------------------------------------------- refresh

test('refresh is single-flight: two concurrent 401s cause one refresh call', async (t) => {
  useTempConfig(t);
  let refreshCalls = 0;
  const api = await startFakeServer(t, async (req) => {
    if (req.url === '/v1/auth/refresh') {
      refreshCalls += 1;
      assert.deepEqual(req.body, { refreshToken: 'device-1.refresh-1' });
      await delay(50); // keep the refresh in flight while the second 401 arrives
      return okBody(PAIR(2));
    }
    if (req.authorization !== 'Bearer access-2') return failBody(401, 'UNAUTHORIZED');
    return okBody({ accepted: [], rejected: [], lastSeq: 0 });
  });
  storeAuth(api.url, 1); // locally "fresh", but the server rejects it
  const client = createSyncClient({ serverUrl: api.url });

  const results = await Promise.all([client.pushEntries([]), client.pushEntries([])]);
  assert.equal(results.length, 2);
  assert.equal(refreshCalls, 1);
  const stored = readAuth().auth;
  assert.equal(stored.accessToken, 'access-2');
  assert.equal(stored.refreshToken, 'device-1.refresh-2');
  assert.equal(fs.statSync(getAuthPath()).mode & 0o777, 0o600);
  // Each push: one 401 with the old token, one retry with the new one.
  assert.deepEqual(api.requests.filter((r) => r.url === '/v1/entries').map((r) => r.authorization).sort(), [
    'Bearer access-1', 'Bearer access-1', 'Bearer access-2', 'Bearer access-2',
  ]);
});

test('an access token about to expire is refreshed before the request', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, (req) => (req.url === '/v1/auth/refresh'
    ? okBody(PAIR(2))
    : okBody({ accepted: [], rejected: [], lastSeq: 0 })));
  storeAuth(api.url, 1, { expiresInMs: 10_000 }); // inside the refresh window
  const client = createSyncClient({ serverUrl: api.url });
  await client.pushEntries([]);
  assert.deepEqual(api.requests.map((r) => [r.url, r.authorization]), [
    ['/v1/auth/refresh', null],
    ['/v1/entries', 'Bearer access-2'],
  ]);
});

for (const code of ['REFRESH_INVALID', 'REFRESH_REUSED']) {
  test(`refresh failure ${code} clears auth.json and reports "login again" once`, async (t) => {
    useTempConfig(t);
    const api = await startFakeServer(t, (req) => (req.url === '/v1/auth/refresh' ? failBody(401, code) : failBody(401, 'UNAUTHORIZED')));
    storeAuth(api.url, 1);
    const lost = [];
    const client = createSyncClient({ serverUrl: api.url, onAuthLost: (c) => lost.push(c) });

    await assert.rejects(client.pushEntries([]), (error) => error.kind === 'auth' && error.code === code && !error.message.includes('refresh-1'));
    assert.equal(fs.existsSync(getAuthPath()), false);
    assert.deepEqual(lost, [code]);
    assert.equal(client.getAuth(), null);
    await assert.rejects(client.pushEntries([]), (error) => error.code === 'NOT_LOGGED_IN');
    assert.deepEqual(lost, [code], 'no second notice');
  });
}

test('a refresh token rotated by another process meanwhile is adopted, not cleared', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, (req) => {
    if (req.url === '/v1/auth/refresh') {
      storeAuth(api.url, 3); // another t-cli process refreshed first
      return failBody(401, 'REFRESH_INVALID');
    }
    return req.authorization === 'Bearer access-3' ? okBody({ accepted: [], rejected: [], lastSeq: 0 }) : failBody(401, 'UNAUTHORIZED');
  });
  storeAuth(api.url, 1);
  const lost = [];
  const client = createSyncClient({ serverUrl: api.url, onAuthLost: (c) => lost.push(c) });
  await client.pushEntries([]);
  assert.equal(readAuth().auth.accessToken, 'access-3');
  assert.deepEqual(lost, []);
});

test('tokens saved for another server are never sent', async (t) => {
  useTempConfig(t);
  const api = await startFakeServer(t, () => okBody({ accepted: [], rejected: [], lastSeq: 0 }));
  storeAuth('https://other.example', 1);
  const client = createSyncClient({ serverUrl: api.url });
  assert.equal(client.getAuth(), null);
  await assert.rejects(client.pushEntries([]), (error) => error.code === 'NOT_LOGGED_IN');
  assert.equal(api.requests.length, 0);
});

// ---------------------------------------------------------------- auth store

test('auth store: atomic 0600 writes, corrupt files, compare-and-delete', (t) => {
  const dir = useTempConfig(t);
  assert.deepEqual(readAuth(), { auth: null, corrupt: false });
  const auth = authFromTokenPair(PAIR(1), { serverUrl: 'https://s.example', now: Date.parse('2026-11-17T00:00:00Z') });
  assert.equal(auth.accessTokenExpiresAt, '2026-11-17T00:15:00.000Z');
  assert.deepEqual(writeAuth(auth), { ok: true });
  assert.equal(fs.statSync(getAuthPath()).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  assert.deepEqual(readAuth().auth, auth);

  // Rewriting keeps 0600 even if the file was loosened meanwhile.
  fs.chmodSync(getAuthPath(), 0o644);
  writeAuth({ ...auth, accessToken: 'access-9' });
  assert.equal(fs.statSync(getAuthPath()).mode & 0o777, 0o600);

  assert.deepEqual(clearAuth({ ifRefreshToken: 'someone-else' }), { ok: true, removed: false });
  assert.ok(fs.existsSync(getAuthPath()));
  assert.deepEqual(clearAuth({ ifRefreshToken: auth.refreshToken }), { ok: true, removed: true });
  assert.equal(fs.existsSync(getAuthPath()), false);

  fs.writeFileSync(getAuthPath(), '{"v":1', 'utf8');
  assert.deepEqual(readAuth(), { auth: null, corrupt: true });
});

// ---------------------------------------------------------------- settings

test('server URL: env wins over config.json; invalid and unset are reported', (t) => {
  const dir = useTempConfig(t);
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ lang: 'en', serverUrl: 'https://cfg.example/base/' }));

  assert.deepEqual(resolveServerUrl({ env: {}, configPath }), { ok: true, url: 'https://cfg.example/base', source: 'config', insecure: false });
  assert.deepEqual(resolveServerUrl({ env: { TCLI_SERVER_URL: 'http://127.0.0.1:8080/' }, configPath }), {
    ok: true, url: 'http://127.0.0.1:8080', source: 'env', insecure: false,
  });
  assert.equal(resolveServerUrl({ env: { TCLI_SERVER_URL: 'http://sync.example' }, configPath }).insecure, true);
  assert.deepEqual(resolveServerUrl({ env: { TCLI_SERVER_URL: 'ftp://x' }, configPath }), { ok: false, reason: 'invalid', source: 'env' });
  assert.deepEqual(resolveServerUrl({ env: {}, configPath: path.join(dir, 'missing.json') }), { ok: false, reason: 'unset' });
  assert.equal(normalizeServerUrl('https://user:pw@x.example'), null);
  assert.equal(normalizeServerUrl('https://x.example/?q=1'), null);
});

// ---------------------------------------------------------------- device flow

const STARTED = { deviceCode: 'dc-1', userCode: '123456', expiresIn: 600, interval: 5, qrPayload: 'tcli://device?code=123456' };
const T0 = 1_000_000;
const poll = (outcome, now, extra = {}) => ({ type: 'poll', deviceCode: 'dc-1', outcome, now, ...extra });

function startedState() {
  const starting = loginReducer(LOGIN_IDLE, { type: 'start' });
  assert.deepEqual(starting, { status: 'starting' });
  return loginReducer(starting, { type: 'started', response: STARTED, now: T0 });
}

test('device flow: pending → slow_down (+5 s) → approved', () => {
  let state = startedState();
  assert.deepEqual(state, { status: 'polling', deviceCode: 'dc-1', userCode: '123456', intervalMs: 5000, expiresAt: T0 + 600_000, attempt: 0 });
  state = loginReducer(state, poll('pending', T0 + 5000));
  assert.equal(state.attempt, 1);
  assert.equal(state.intervalMs, 5000);
  state = loginReducer(state, poll('slow_down', T0 + 10_000));
  assert.equal(state.intervalMs, 5000 + SLOW_DOWN_STEP_MS);
  state = loginReducer(state, poll('pending', T0 + 20_000));
  assert.equal(state.intervalMs, 10_000, 'slow_down sticks for all later polls');
  state = loginReducer(state, poll('approved', T0 + 30_000, { user: { id: 'u1', role: 'member' }, deviceId: 'd1' }));
  assert.deepEqual(state, { status: 'done', outcome: 'approved', userCode: '123456', user: { id: 'u1', role: 'member' }, deviceId: 'd1' });
});

test('device flow: expired (server code or local expiry), denied, errors, cancel and stale events', () => {
  const polling = startedState();
  assert.equal(loginReducer(polling, poll('expired', T0 + 1)).outcome, 'expired');
  assert.equal(loginReducer(polling, poll('pending', T0 + 600_000)).outcome, 'expired', 'local expiry ends the flow');
  assert.equal(loginReducer(polling, poll('denied', T0 + 1)).outcome, 'denied');

  const transient = loginReducer(polling, poll('error', T0 + 1, { error: 'network error', transient: true }));
  assert.equal(transient.status, 'polling', 'transient errors keep polling');
  const fatal = loginReducer(polling, poll('error', T0 + 1, { error: 'boom', transient: false }));
  assert.deepEqual(fatal, { status: 'done', outcome: 'failed', userCode: '123456', error: 'boom' });

  assert.equal(loginReducer(polling, poll('aborted', T0 + 1)), polling);
  assert.equal(loginReducer(polling, { ...poll('approved', T0 + 1), deviceCode: 'other' }), polling, 'stale poll ignored');
  assert.equal(loginReducer(polling, { type: 'start' }), polling, 'start while active is a no-op');

  const cancelled = loginReducer(polling, { type: 'cancel' });
  assert.deepEqual(cancelled, { status: 'done', outcome: 'cancelled', userCode: '123456' });
  assert.equal(loginReducer(cancelled, poll('approved', T0 + 1)), cancelled, 'a poll landing after cancel is ignored');

  const starting = loginReducer(LOGIN_IDLE, { type: 'start' });
  const cancelledEarly = loginReducer(starting, { type: 'cancel' });
  assert.equal(loginReducer(cancelledEarly, { type: 'started', response: STARTED, now: T0 }), cancelledEarly);
  assert.equal(loginReducer(starting, { type: 'start_failed', error: 'offline' }).outcome, 'failed');
  assert.equal(loginReducer(LOGIN_IDLE, { type: 'cancel' }), LOGIN_IDLE);
});

test('classifyPollError maps device-token codes', () => {
  const err = (code, status = 400, kind = 'http') => new SyncError({ kind, code, status, message: code });
  assert.deepEqual(classifyPollError(err('authorization_pending')), { outcome: 'pending' });
  assert.deepEqual(classifyPollError(err('slow_down')), { outcome: 'slow_down' });
  assert.deepEqual(classifyPollError(err('expired_token')), { outcome: 'expired' });
  assert.deepEqual(classifyPollError(err('access_denied')), { outcome: 'denied' });
  assert.deepEqual(classifyPollError(err('ABORTED', null, 'aborted')), { outcome: 'aborted' });
  assert.equal(classifyPollError(err('HTTP_503', 503)).transient, true);
  assert.equal(classifyPollError(err('VALIDATION_FAILED', 400)).transient, false);
});

test('device login over HTTP: start, poll until approved, credentials saved 0600', async (t) => {
  useTempConfig(t);
  const answers = [failBody(400, 'authorization_pending'), failBody(400, 'slow_down'), okBody(PAIR(1))];
  const api = await startFakeServer(t, (req) => {
    if (req.url === '/v1/auth/device/start') return okBody(STARTED);
    if (req.url === '/v1/auth/device/token') return answers.shift();
    return failBody(404, 'NOT_FOUND');
  });
  const client = createSyncClient({ serverUrl: api.url });
  const started = await client.startDeviceAuth({ deviceName: defaultDeviceName() });
  let state = loginReducer(loginReducer(LOGIN_IDLE, { type: 'start' }), { type: 'started', response: started, now: Date.now() });
  const intervals = [];
  while (state.status === 'polling') {
    intervals.push(state.intervalMs);
    state = loginReducer(state, await pollDeviceLogin({ client, deviceCode: state.deviceCode }));
  }
  assert.deepEqual(intervals, [5000, 5000, 10_000]);
  assert.equal(state.outcome, 'approved');
  assert.deepEqual(state.user, { id: 'user-1', role: 'member' });
  assert.equal(state.deviceId, 'device-1');
  assert.ok(!JSON.stringify(state).includes('access-1'), 'tokens never enter UI state');
  assert.equal(readAuth().auth.refreshToken, 'device-1.refresh-1');
  assert.equal(fs.statSync(getAuthPath()).mode & 0o777, 0o600);
  assert.ok(api.requests[0].body.deviceName.length >= 1 && api.requests[0].body.deviceName.length <= 64);
  assert.deepEqual(api.requests.slice(1).map((r) => r.body), [{ deviceCode: 'dc-1' }, { deviceCode: 'dc-1' }, { deviceCode: 'dc-1' }]);
});

test('renderQr returns a string and never prints', async () => {
  const qr = await renderQr(STARTED.qrPayload);
  assert.equal(typeof qr, 'string');
  assert.ok(qr.split('\n').length > 5);
});

// ---------------------------------------------------------------- status text

test('status text and indicator', () => {
  const server = { ok: true, url: 'https://s.example', source: 'env', insecure: false };
  const snapshot = { phase: 'backoff', failures: 2, nextRetryAt: 50_000, last: { at: '2026-11-17T02:00:00.000Z', ok: false, accepted: 0, rejected: 0, remaining: 3, invalidLines: 0, error: { code: 'NETWORK', message: 'network error (ECONNREFUSED)' } } };
  const lines = buildSyncStatusLines({
    server, account: null, otherServer: null, login: LOGIN_IDLE, snapshot,
    outbox: { pending: 3, invalidLines: 1, error: null }, rejectedCount: 2, now: 10_000,
  });
  const text = lines.join('\n');
  assert.match(text, /https:\/\/s\.example \(TCLI_SERVER_URL\)/);
  assert.match(text, /not logged in; use \/login/);
  assert.match(text, /3 pending, 1 invalid line/);
  assert.match(text, /2 in outbox\.rejected\.jsonl/);
  assert.match(text, /failed: network error \(ECONNREFUSED\) \[NETWORK\]/);
  assert.match(text, /retry in 40s/);

  assert.equal(formatSyncIndicator({ server: { ok: false, reason: 'unset' }, loggedIn: false, login: LOGIN_IDLE, snapshot: null }), '');
  assert.equal(formatSyncIndicator({ server, loggedIn: false, login: LOGIN_IDLE, snapshot: null }), 'sync=logged out');
  assert.equal(formatSyncIndicator({ server, loggedIn: true, login: LOGIN_IDLE, snapshot }), 'sync=retrying');
  const off = buildSyncStatusLines({ server: { ok: false, reason: 'unset' }, account: null, otherServer: null, login: LOGIN_IDLE, snapshot: null, outbox: { pending: 0, invalidLines: 0, error: null }, rejectedCount: 0, now: 0 });
  assert.match(off.join('\n'), /TCLI_SERVER_URL/);
});
