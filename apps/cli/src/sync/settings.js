/**
 * Where the sync server lives. `TCLI_SERVER_URL` wins over `serverUrl` in
 * `<config>/t-cli/config.json`; with neither, sync is off and nothing runs in
 * the background.
 *
 * No stdout/stderr here — the Ink TUI owns the terminal.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { getConfigDir } from '../config.js';

export const SERVER_URL_ENV = 'TCLI_SERVER_URL';

/**
 * @typedef {{ ok: true, url: string, source: 'env'|'config', insecure: boolean }
 *         | { ok: false, reason: 'unset' }
 *         | { ok: false, reason: 'invalid', source: 'env'|'config' }} ServerSetting
 */

/** How to turn sync on, for messages shown when it is off. */
export const SERVER_URL_HELP = `Sync is off. Set ${SERVER_URL_ENV}=https://your-server (env or .env), `
  + 'or add "serverUrl": "https://your-server" to ~/.config/t-cli/config.json, then restart t-cli.';

/**
 * Normalize a base URL: http(s) only, no credentials / query / fragment,
 * no trailing slash (a path prefix such as https://host/tcli is kept).
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeServerUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Plain http is only acceptable on loopback: tokens travel in headers.
 * @param {string} url normalized server URL
 * @returns {boolean}
 */
export function isInsecureServerUrl(url) {
  const { protocol, hostname } = new URL(url);
  if (protocol === 'https:') return false;
  return !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

/**
 * @param {{ env?: Record<string, string|undefined>, configPath?: string }} [options]
 * @returns {ServerSetting}
 */
export function resolveServerUrl({ env = process.env, configPath = path.join(getConfigDir(), 'config.json') } = {}) {
  const fromEnv = env[SERVER_URL_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return settingFrom(fromEnv, 'env');
  const fromConfig = readConfigServerUrl(configPath);
  if (fromConfig !== null) return settingFrom(fromConfig, 'config');
  return { ok: false, reason: 'unset' };
}

/**
 * @param {unknown} raw
 * @param {'env'|'config'} source
 * @returns {ServerSetting}
 */
function settingFrom(raw, source) {
  const url = normalizeServerUrl(raw);
  if (url === null) return { ok: false, reason: 'invalid', source };
  return { ok: true, url, source, insecure: isInsecureServerUrl(url) };
}

/**
 * @param {string} configPath
 * @returns {unknown} the configured value, or null when absent/unreadable
 */
function readConfigServerUrl(configPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const value = parsed && typeof parsed === 'object' ? parsed.serverUrl : undefined;
    return value === undefined || value === null || value === '' ? null : value;
  } catch {
    return null;
  }
}
