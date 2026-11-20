/**
 * HTTP client for the t-cli sync server (docs/api-v1.md), plain `fetch`.
 *
 *  - Every JSON answer is an envelope; failures become a `SyncError` whose
 *    `code` is the server's `error.code` (clients branch on codes only).
 *  - Access tokens are refreshed single-flight: concurrent callers share one
 *    `POST /v1/auth/refresh`. A 401 triggers one refresh + one retry.
 *  - `REFRESH_INVALID` / `REFRESH_REUSED` clear auth.json and call
 *    `onAuthLost` (the UI shows "please /login again" once).
 *  - Every request has a timeout (AbortSignal) and refuses redirects, so a
 *    bearer token is only ever sent to the configured server.
 *
 * Nothing here logs or prints, and errors never carry tokens or bodies.
 */
import { authFromTokenPair, clearAuth, isTokenPair, readAuth, writeAuth } from './authStore.js';

/** @typedef {import('./authStore.js').Auth} Auth */
/** @typedef {import('./authStore.js').TokenPair} TokenPair */
/** @typedef {import('@t-cli/core/entry').Entry} Entry */
/**
 * @typedef {'network'|'timeout'|'aborted'|'http'|'protocol'|'auth'|'local'} SyncErrorKind
 * @typedef {{ deviceCode: string, userCode: string, expiresIn: number, interval: number, qrPayload: string }} DeviceStart
 * @typedef {{ accepted: string[], rejected: { index: number, id: string|null, errors: string[] }[], lastSeq: number }} PushResult
 * @typedef {{ outcome: 'approved', pair: TokenPair } | { outcome: 'pending'|'slow_down'|'expired'|'denied'|'aborted' }
 *         | { outcome: 'error', error: SyncError, transient: boolean }} PollResult
 */

export const DEFAULT_TIMEOUT_MS = 15_000;
/** Refresh proactively when the access token expires within this window. */
export const REFRESH_SKEW_MS = 60_000;
export const AUTH_LOST_CODES = Object.freeze(['REFRESH_INVALID', 'REFRESH_REUSED']);
const DEVICE_POLL_CODES = Object.freeze({
  authorization_pending: 'pending',
  slow_down: 'slow_down',
  expired_token: 'expired',
  access_denied: 'denied',
});

export class SyncError extends Error {
  /**
   * @param {{ kind: SyncErrorKind, code: string, message: string, status?: number|null,
   *           details?: unknown, retryAfterMs?: number|null }} fields
   */
  constructor({ kind, code, message, status = null, details = undefined, retryAfterMs = null }) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Worth retrying later without user action: network trouble, timeouts,
 * 5xx and rate limiting.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientError(error) {
  if (!(error instanceof SyncError)) return false;
  if (error.kind === 'network' || error.kind === 'timeout') return true;
  return error.kind === 'http' && error.status !== null && (error.status >= 500 || error.status === 429);
}

/**
 * Parse a response body as an API envelope.
 * @param {number} status
 * @param {string} text
 * @param {{ retryAfterHeader?: string|null }} [options]
 * @returns {unknown} `data` of a success envelope
 * @throws {SyncError} for error envelopes, HTTP errors and malformed bodies
 */
export function parseEnvelope(status, text, { retryAfterHeader = null } = {}) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const retryAfterMs = status === 429 ? retryAfterOf(body, retryAfterHeader) : null;
  if (isRecord(body) && body.success === true && 'data' in body && status >= 200 && status < 300) {
    return body.data;
  }
  if (isRecord(body) && body.success === false && isRecord(body.error) && typeof body.error.code === 'string') {
    const { code, message, details } = body.error;
    return throwError({ kind: 'http', status, code, message: typeof message === 'string' && message ? message : code, details, retryAfterMs });
  }
  if (status >= 400) {
    return throwError({ kind: 'http', status, code: `HTTP_${status}`, message: `HTTP ${status}`, retryAfterMs });
  }
  return throwError({ kind: 'protocol', status, code: 'BAD_RESPONSE', message: `unexpected response (HTTP ${status})` });
}

/**
 * @param {{ serverUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number, now?: () => number,
 *           onAuthLost?: (code: string) => void }} options
 */
export function createSyncClient({ serverUrl, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now, onAuthLost = () => {} }) {
  /** @type {Promise<Auth> | null} */
  let refreshing = null;
  /** Rotated credentials that could not be written to disk; used until a write succeeds. */
  /** @type {Auth | null} */
  let unsaved = null;

  /** Credentials for this server, or null (other servers' tokens are never used). */
  function getAuth() {
    if (unsaved) return unsaved;
    const { auth } = readAuth();
    return auth && auth.serverUrl === serverUrl ? auth : null;
  }

  /** @param {Auth} auth */
  function persist(auth) {
    const written = writeAuth(auth);
    unsaved = written.ok ? null : auth;
    return written;
  }

  /** @param {Auth} auth */
  function isFresh(auth) {
    return Date.parse(auth.accessTokenExpiresAt) - REFRESH_SKEW_MS > now();
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, token?: string, signal?: AbortSignal, timeout?: number }} [options]
   */
  async function send(method, path, { body, token, signal, timeout = timeoutMs } = {}) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const response = await fetchImpl(`${serverUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
        redirect: 'error',
      });
      const text = await response.text();
      return parseEnvelope(response.status, text, { retryAfterHeader: response.headers.get('retry-after') });
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw transportError(error, { signal, timeoutSignal });
    }
  }

  /**
   * Single-flight refresh. `stale` is the auth whose access token failed (or
   * expired); if another caller or process already rotated it, that newer
   * auth is used without another refresh.
   * @param {Auth} stale
   * @param {{ notifyAuthLost?: boolean }} [options]
   * @returns {Promise<Auth>}
   */
  function refresh(stale, { notifyAuthLost = true } = {}) {
    if (!refreshing) {
      refreshing = doRefresh(stale, notifyAuthLost).finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  /** @param {Auth} stale @param {boolean} notifyAuthLost @returns {Promise<Auth>} */
  async function doRefresh(stale, notifyAuthLost) {
    const latest = getAuth();
    if (!latest) throw notLoggedIn();
    if (latest.accessToken !== stale.accessToken && isFresh(latest)) return latest;
    let pair;
    try {
      // No caller signal: an abandoned refresh could lose a rotated token.
      pair = await send('POST', '/v1/auth/refresh', { body: { refreshToken: latest.refreshToken } });
    } catch (error) {
      if (!(error instanceof SyncError) || !AUTH_LOST_CODES.includes(error.code)) throw error;
      const after = getAuth();
      if (after && after.refreshToken !== latest.refreshToken) return after; // rotated elsewhere meanwhile
      if (unsaved && unsaved.refreshToken === latest.refreshToken) unsaved = null;
      clearAuth({ ifRefreshToken: latest.refreshToken });
      if (notifyAuthLost) onAuthLost(error.code);
      throw new SyncError({ kind: 'auth', code: error.code, status: error.status, message: 'session expired or revoked; please /login again' });
    }
    if (!isTokenPair(pair)) throw protocolError('malformed token pair');
    const next = authFromTokenPair(pair, { serverUrl, now: now() });
    persist(next);
    return next;
  }

  /**
   * Authenticated request: proactive refresh near expiry, then one
   * refresh + retry on 401.
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, signal?: AbortSignal, timeout?: number, notifyAuthLost?: boolean }} [options]
   */
  async function authedRequest(method, path, { body, signal, timeout, notifyAuthLost = true } = {}) {
    let auth = getAuth();
    if (!auth) throw notLoggedIn();
    if (!isFresh(auth)) auth = await refresh(auth, { notifyAuthLost });
    try {
      return await send(method, path, { body, token: auth.accessToken, signal, timeout });
    } catch (error) {
      if (!(error instanceof SyncError) || error.status !== 401) throw error;
    }
    const retryAuth = await refresh(auth, { notifyAuthLost });
    try {
      return await send(method, path, { body, token: retryAuth.accessToken, signal, timeout });
    } catch (error) {
      if (error instanceof SyncError && error.status === 401) {
        throw new SyncError({ kind: 'auth', code: error.code, status: 401, message: 'the server rejected the refreshed access token' });
      }
      throw error;
    }
  }

  return {
    serverUrl,
    getAuth,
    refresh,
    request: authedRequest,

    /**
     * Store a token pair (device login) as this server's credentials.
     * @param {TokenPair} pair
     */
    adoptTokenPair(pair) {
      const auth = authFromTokenPair(pair, { serverUrl, now: now() });
      const written = persist(auth);
      return written.ok ? { ok: true, auth } : { ok: false, error: written.error };
    },

    /**
     * @param {{ deviceName: string, signal?: AbortSignal }} args
     * @returns {Promise<DeviceStart>}
     */
    async startDeviceAuth({ deviceName, signal }) {
      const data = await send('POST', '/v1/auth/device/start', { body: { deviceName }, signal });
      if (!isDeviceStart(data)) throw protocolError('malformed device/start response');
      return data;
    },

    /**
     * One device-token poll. Never throws.
     * @param {{ deviceCode: string, signal?: AbortSignal }} args
     * @returns {Promise<PollResult>}
     */
    async pollDeviceToken({ deviceCode, signal }) {
      try {
        const data = await send('POST', '/v1/auth/device/token', { body: { deviceCode }, signal });
        if (!isTokenPair(data)) return { outcome: 'error', error: protocolError('malformed token pair'), transient: false };
        return { outcome: 'approved', pair: data };
      } catch (error) {
        return classifyPollError(error);
      }
    },

    /**
     * Revoke this device server-side (no "login again" notice on failure).
     * @param {{ signal?: AbortSignal, timeout?: number }} [options]
     */
    async logout({ signal, timeout = 5_000 } = {}) {
      return authedRequest('POST', '/v1/auth/logout', { signal, timeout, notifyAuthLost: false });
    },

    /**
     * @param {readonly Entry[]} entries
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<PushResult>}
     */
    async pushEntries(entries, { signal } = {}) {
      const data = await authedRequest('POST', '/v1/entries', { body: { entries }, signal });
      if (!isPushResult(data)) throw protocolError('malformed push response');
      return data;
    },
  };
}

/**
 * Map a device-token failure to a poll outcome.
 * @param {unknown} error
 * @returns {PollResult}
 */
export function classifyPollError(error) {
  if (error instanceof SyncError) {
    if (error.kind === 'aborted') return { outcome: 'aborted' };
    const outcome = DEVICE_POLL_CODES[/** @type {keyof typeof DEVICE_POLL_CODES} */ (error.code)];
    if (outcome) return { outcome };
    return { outcome: 'error', error, transient: isTransientError(error) };
  }
  const wrapped = new SyncError({ kind: 'protocol', code: 'CLIENT_ERROR', message: errorMessage(error) });
  return { outcome: 'error', error: wrapped, transient: false };
}

/** @returns {SyncError} */
function notLoggedIn() {
  return new SyncError({ kind: 'auth', code: 'NOT_LOGGED_IN', message: 'not logged in' });
}

/** @param {string} message @returns {SyncError} */
function protocolError(message) {
  return new SyncError({ kind: 'protocol', code: 'BAD_RESPONSE', message });
}

/**
 * @param {ConstructorParameters<typeof SyncError>[0]} fields
 * @returns {never}
 */
function throwError(fields) {
  throw new SyncError(fields);
}

/**
 * @param {unknown} error
 * @param {{ signal?: AbortSignal, timeoutSignal: AbortSignal }} signals
 * @returns {SyncError}
 */
function transportError(error, { signal, timeoutSignal }) {
  if (signal?.aborted) return new SyncError({ kind: 'aborted', code: 'ABORTED', message: 'request cancelled' });
  if (timeoutSignal.aborted) return new SyncError({ kind: 'timeout', code: 'TIMEOUT', message: 'request timed out' });
  const cause = error instanceof Error && isRecord(error.cause) ? error.cause : null;
  const code = cause && typeof cause.code === 'string' ? cause.code : null;
  const reason = code ?? (cause && typeof cause.message === 'string' ? cause.message : errorMessage(error));
  return new SyncError({ kind: 'network', code: 'NETWORK', message: `network error (${reason})` });
}

/**
 * @param {unknown} body
 * @param {string|null} header
 * @returns {number|null}
 */
function retryAfterOf(body, header) {
  const details = isRecord(body) && isRecord(body.error) ? body.error.details : undefined;
  const seconds = isRecord(details) && typeof details.retryAfterSeconds === 'number'
    ? details.retryAfterSeconds
    : header !== null && /^\d+$/.test(header) ? Number(header) : null;
  return seconds !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** @param {unknown} value @returns {value is DeviceStart} */
function isDeviceStart(value) {
  return isRecord(value)
    && typeof value.deviceCode === 'string' && value.deviceCode !== ''
    && typeof value.userCode === 'string' && value.userCode !== ''
    && typeof value.qrPayload === 'string'
    && isPositiveNumber(value.expiresIn) && isPositiveNumber(value.interval);
}

/** @param {unknown} value @returns {value is PushResult} */
function isPushResult(value) {
  return isRecord(value)
    && Array.isArray(value.accepted) && value.accepted.every((id) => typeof id === 'string')
    && Array.isArray(value.rejected)
    && value.rejected.every((r) => isRecord(r) && Number.isInteger(r.index) && (r.id === null || typeof r.id === 'string')
      && Array.isArray(r.errors));
}

/** @param {unknown} value @returns {value is number} */
function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

