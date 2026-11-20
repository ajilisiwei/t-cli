/**
 * Account settings sync for the CLI (today: `explanationLang`, the /lang
 * value).
 *
 *  - /lang writes the change to `pendingSettings` in sync-state.json first,
 *    then posts it (`POST /v1/me/settings`); a success clears the pending
 *    copy. Offline, the local change stays in force and pending.
 *  - At startup (and after /login): a pending change is pushed instead of
 *    reading the server (the local change wins); with nothing pending,
 *    `GET /v1/me` and an explicit server `explanationLang` that differs from
 *    the local one is applied locally. An absent server value (the server's
 *    default) never overrides the local config.
 *
 * Nothing here prints; callers decide what to show.
 */
import { readSyncState, updateSyncState } from '../entryLog.js';
import { fetchSettings, pushSettings } from './learning.js';

/** @typedef {ReturnType<typeof import('./client.js').createSyncClient>} SyncClient */
/** @typedef {{ explanationLang: 'zh'|'en' }} SettingsPatch */
/**
 * @typedef {{ read: () => SettingsPatch | null, write: (patch: SettingsPatch | null) => void }} PendingStore
 * @typedef {{ action: 'pushed' } | { action: 'push_failed', error: string } | { action: 'apply', lang: 'zh'|'en' }
 *         | { action: 'unchanged' } | { action: 'failed', error: string }} ReconcileResult
 */

export const EXPLANATION_LANGS = Object.freeze(['zh', 'en']);

/** @param {unknown} value @returns {value is 'zh'|'en'} */
export function isExplanationLang(value) {
  return typeof value === 'string' && EXPLANATION_LANGS.includes(value);
}

/** Pending settings in sync-state.json (`pendingSettings`). */
/** @type {PendingStore} */
export const syncStatePendingStore = Object.freeze({
  read() {
    const pending = /** @type {Record<string, any>} */ (readSyncState()).pendingSettings;
    return pending && typeof pending === 'object' && isExplanationLang(pending.explanationLang)
      ? { explanationLang: pending.explanationLang }
      : null;
  },
  write(patch) {
    updateSyncState({ pendingSettings: patch });
  },
});

/**
 * Record a local /lang change as pending (call before pushing).
 * @param {'zh'|'en'} lang
 * @param {PendingStore} [store]
 */
export function markLangPending(lang, store = syncStatePendingStore) {
  store.write({ explanationLang: lang });
}

/**
 * Push the pending change, if any; clear it on success unless a newer change
 * was recorded meanwhile.
 * @param {{ client: SyncClient, store?: PendingStore, signal?: AbortSignal }} options
 * @returns {Promise<{ ok: true, pushed: boolean } | { ok: false, error: string }>}
 */
export async function flushPendingSettings({ client, store = syncStatePendingStore, signal }) {
  const pending = store.read();
  if (!pending) return { ok: true, pushed: false };
  try {
    await pushSettings(client, pending, { signal });
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
  if (store.read()?.explanationLang === pending.explanationLang) store.write(null);
  return { ok: true, pushed: true };
}

/**
 * Startup / post-login reconciliation (see the module comment).
 * @param {{ client: SyncClient, localLang: string, store?: PendingStore, signal?: AbortSignal }} options
 * @returns {Promise<ReconcileResult>}
 */
export async function reconcileSettings({ client, localLang, store = syncStatePendingStore, signal }) {
  if (store.read()) {
    const flushed = await flushPendingSettings({ client, store, signal });
    return flushed.ok ? { action: 'pushed' } : { action: 'push_failed', error: flushed.error };
  }
  let settings;
  try {
    settings = await fetchSettings(client, { signal });
  } catch (error) {
    return { action: 'failed', error: errorMessage(error) };
  }
  const remote = settings.explanationLang;
  // A /lang change made while the request was in flight wins.
  if (store.read()) return { action: 'unchanged' };
  if (isExplanationLang(remote) && remote !== localLang) return { action: 'apply', lang: remote };
  return { action: 'unchanged' };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
