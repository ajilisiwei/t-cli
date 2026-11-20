/**
 * Pure text for /sync status and the status-line indicator.
 */
import { toLocalIsoString } from '@t-cli/core/entry';
import { SERVER_URL_ENV, SERVER_URL_HELP } from './settings.js';

/** @typedef {import('./settings.js').ServerSetting} ServerSetting */
/** @typedef {import('./syncer.js').SyncSnapshot} SyncSnapshot */
/** @typedef {import('./syncer.js').PushRecord} PushRecord */
/** @typedef {import('./deviceFlow.js').LoginState} LoginState */
/**
 * @typedef {{ serverUrl: string, user: { id: string, role: string }, deviceId: string }} AccountInfo
 * @typedef {{ server: ServerSetting, account: AccountInfo | null, otherServer: string | null,
 *             login: LoginState, snapshot: SyncSnapshot | null,
 *             outbox: { pending: number, invalidLines: number, error: string | null },
 *             rejectedCount: number, now: number }} StatusInput
 */

/**
 * Short indicator for the status line ('' when sync is not configured).
 * @param {{ server: ServerSetting, loggedIn: boolean, login: LoginState, snapshot: SyncSnapshot | null }} input
 * @returns {string}
 */
export function formatSyncIndicator({ server, loggedIn, login, snapshot }) {
  if (!server.ok) return '';
  if (login.status === 'starting' || login.status === 'polling') return 'sync=login pending';
  if (!loggedIn) return 'sync=logged out';
  if (!snapshot) return 'sync=on';
  if (snapshot.phase === 'pushing') return 'sync=pushing';
  if (snapshot.phase === 'backoff') return 'sync=retrying';
  if (!snapshot.last) return 'sync=on';
  return snapshot.last.ok ? 'sync=ok' : 'sync=error';
}

/**
 * Message lines when sync is not configured (or misconfigured).
 * @param {ServerSetting} server
 * @returns {string[]}
 */
export function syncOffLines(server) {
  if (server.ok) return [];
  if (server.reason === 'invalid') {
    const where = server.source === 'env' ? SERVER_URL_ENV : 'serverUrl in config.json';
    return [`Sync is off: ${where} is not a valid http(s) URL (no credentials, query or fragment).`];
  }
  return [SERVER_URL_HELP];
}

/**
 * @param {StatusInput} input
 * @returns {string[]}
 */
export function buildSyncStatusLines({ server, account, otherServer, login, snapshot, outbox, rejectedCount, now }) {
  if (!server.ok) return syncOffLines(server);
  const row = (label, value) => `  ${`${label}:`.padEnd(11)}${value}`;
  const source = server.source === 'env' ? SERVER_URL_ENV : 'config.json';
  const lines = ['Sync status', row('server', `${server.url} (${source})${server.insecure ? '  warning: plain http, tokens are not encrypted' : ''}`)];

  lines.push(row('account', accountText({ account, otherServer, login })));
  const invalid = outbox.invalidLines > 0 ? `, ${outbox.invalidLines} invalid line${outbox.invalidLines === 1 ? '' : 's'} (never pushed)` : '';
  lines.push(row('outbox', outbox.error ? `unreadable (${outbox.error})` : `${outbox.pending} pending${invalid}`));
  lines.push(row('rejected', rejectedCount > 0 ? `${rejectedCount} in outbox.rejected.jsonl (not retried)` : '0'));
  lines.push(row('last push', lastPushText(snapshot?.last ?? null)));
  const next = nextText(snapshot, now);
  if (next) lines.push(row('next', next));
  return lines;
}

/**
 * Result line for /sync now.
 * @param {import('./push.js').PushSummary | null} summary
 * @returns {{ text: string, ok: boolean }}
 */
export function describePushSummary(summary) {
  if (summary === null) return { text: 'Sync: nothing ran (not logged in).', ok: false };
  if (summary.error) return { text: `Sync failed: ${summary.error.message}. ${summary.remaining} pending.`, ok: false };
  if (!summary.attempted) return { text: 'Sync: nothing to push.', ok: true };
  const rejected = summary.rejected > 0 ? `, ${summary.rejected} rejected (moved to outbox.rejected.jsonl)` : '';
  return { text: `Sync: ${summary.accepted} pushed${rejected}; ${summary.remaining} pending.`, ok: true };
}

/**
 * @param {{ account: AccountInfo | null, otherServer: string | null, login: LoginState }} input
 * @returns {string}
 */
function accountText({ account, otherServer, login }) {
  if (login.status === 'polling') return `login waiting for approval (code ${login.userCode}); /login cancel to abort`;
  if (login.status === 'starting') return 'login starting...';
  if (account) return `user ${account.user.id} (${account.user.role}), device ${account.deviceId}`;
  if (otherServer) return `not logged in here (saved login is for ${otherServer}); /logout then /login`;
  return 'not logged in; use /login';
}

/**
 * @param {PushRecord | null} last
 * @returns {string}
 */
function lastPushText(last) {
  if (!last) return 'never';
  const at = formatTime(last.at);
  if (last.ok) return `${at} ok, ${last.accepted} accepted, ${last.rejected} rejected`;
  return `${at} failed: ${last.error ? `${last.error.message} [${last.error.code}]` : 'unknown error'}`;
}

/**
 * @param {SyncSnapshot | null} snapshot
 * @param {number} now
 * @returns {string}
 */
function nextText(snapshot, now) {
  if (!snapshot) return '';
  if (snapshot.phase === 'pushing') return 'pushing now';
  if (snapshot.phase === 'backoff' && snapshot.nextRetryAt !== null) {
    const seconds = Math.max(0, Math.ceil((snapshot.nextRetryAt - now) / 1000));
    return `retry in ${seconds}s (failure ${snapshot.failures}); /sync now to retry immediately`;
  }
  return '';
}

/** @param {string} iso @returns {string} */
function formatTime(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : toLocalIsoString(new Date(ms)).slice(0, 19).replace('T', ' ');
}
