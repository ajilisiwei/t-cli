/**
 * Credentials for the sync server: `<config>/t-cli/auth.json`, mode 0600,
 * always written atomically (temp file + rename). Honours XDG_CONFIG_HOME /
 * APPDATA through getConfigDir(), resolved on every call.
 *
 * Tokens never leave this module except to the HTTP client; nothing here
 * prints anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { getConfigDir } from '../config.js';

export const AUTH_FILE_MODE = 0o600;
const AUTH_VERSION = 1;

/**
 * @typedef {Object} Auth
 * @property {number} v
 * @property {string} serverUrl            tokens are only ever sent here
 * @property {string} deviceId
 * @property {{ id: string, role: string }} user
 * @property {string} refreshToken
 * @property {string} accessToken
 * @property {string} accessTokenExpiresAt ISO 8601
 * @property {string} savedAt              ISO 8601
 *
 * @typedef {{ accessToken: string, refreshToken: string, accessTokenExpiresIn: number,
 *             user: { id: string, role: string }, deviceId: string }} TokenPair
 * @typedef {{ ok: true } | { ok: false, error: string }} WriteResult
 */

export function getAuthPath() {
  return path.join(getConfigDir(), 'auth.json');
}

/**
 * Validate an untrusted TokenPair (server response).
 * @param {unknown} value
 * @returns {value is TokenPair}
 */
export function isTokenPair(value) {
  if (!isRecord(value)) return false;
  const { accessToken, refreshToken, accessTokenExpiresIn, user, deviceId } = value;
  return nonEmpty(accessToken) && nonEmpty(refreshToken) && nonEmpty(deviceId)
    && typeof accessTokenExpiresIn === 'number' && Number.isFinite(accessTokenExpiresIn) && accessTokenExpiresIn > 0
    && isRecord(user) && nonEmpty(user.id) && nonEmpty(user.role);
}

/**
 * @param {TokenPair} pair
 * @param {{ serverUrl: string, now: number }} context
 * @returns {Auth}
 */
export function authFromTokenPair(pair, { serverUrl, now }) {
  return {
    v: AUTH_VERSION,
    serverUrl,
    deviceId: pair.deviceId,
    user: { id: pair.user.id, role: pair.user.role },
    refreshToken: pair.refreshToken,
    accessToken: pair.accessToken,
    accessTokenExpiresAt: new Date(now + pair.accessTokenExpiresIn * 1000).toISOString(),
    savedAt: new Date(now).toISOString(),
  };
}

/**
 * Read the stored credentials. Missing → `auth: null`; a corrupt file is
 * reported as `corrupt` (and treated as logged out by callers).
 * @returns {{ auth: Auth | null, corrupt: boolean }}
 */
export function readAuth() {
  let raw;
  try {
    raw = fs.readFileSync(getAuthPath(), 'utf8');
  } catch {
    return { auth: null, corrupt: false };
  }
  try {
    const parsed = JSON.parse(raw);
    return isAuth(parsed) ? { auth: parsed, corrupt: false } : { auth: null, corrupt: true };
  } catch {
    return { auth: null, corrupt: true };
  }
}

/**
 * Write credentials atomically with mode 0600.
 * @param {Auth} auth
 * @returns {WriteResult}
 */
export function writeAuth(auth) {
  const target = getAuthPath();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(tmp, 'wx', AUTH_FILE_MODE);
    try {
      fs.fchmodSync(fd, AUTH_FILE_MODE); // openSync's mode is filtered by the umask; set it exactly
      fs.writeFileSync(fd, `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    return { ok: true };
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Delete auth.json. With `ifRefreshToken`, only when the stored refresh
 * token is still that one (another process may have logged in again).
 * @param {{ ifRefreshToken?: string }} [options]
 * @returns {WriteResult & { removed?: boolean }}
 */
export function clearAuth({ ifRefreshToken } = {}) {
  if (ifRefreshToken !== undefined) {
    const { auth } = readAuth();
    if (auth && auth.refreshToken !== ifRefreshToken) return { ok: true, removed: false };
  }
  try {
    fs.rmSync(getAuthPath(), { force: true });
    return { ok: true, removed: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * @param {unknown} value
 * @returns {value is Auth}
 */
function isAuth(value) {
  if (!isRecord(value)) return false;
  return value.v === AUTH_VERSION && nonEmpty(value.serverUrl) && nonEmpty(value.deviceId)
    && isRecord(value.user) && nonEmpty(value.user.id) && nonEmpty(value.user.role)
    && nonEmpty(value.refreshToken) && nonEmpty(value.accessToken)
    && nonEmpty(value.accessTokenExpiresAt) && !Number.isNaN(Date.parse(value.accessTokenExpiresAt));
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function nonEmpty(value) {
  return typeof value === 'string' && value !== '';
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
