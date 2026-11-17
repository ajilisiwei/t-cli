/**
 * Background push scheduler. Single-flight (never two pushes at once; a
 * request made during a push runs one more pass right after it), exponential
 * backoff on network / server / local errors, no retries for auth problems
 * (those need /login). It never prints: state goes to subscribers and to
 * `sync-state.json` (`lastPush`), and /sync status shows it.
 */
import { updateSyncState } from '../entryLog.js';
import { pushOutbox } from './push.js';

/** @typedef {import('./push.js').PushSummary} PushSummary */
/** @typedef {import('./client.js').SyncError} SyncError */
/** @typedef {ReturnType<typeof import('./client.js').createSyncClient>} SyncClient */
/**
 * @typedef {{ at: string, ok: boolean, accepted: number, rejected: number, remaining: number,
 *             invalidLines: number, error: { code: string, message: string } | null }} PushRecord
 * @typedef {{ phase: 'idle'|'pushing'|'backoff', failures: number, nextRetryAt: number|null,
 *             last: PushRecord|null }} SyncSnapshot
 * @typedef {{ setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (handle: any) => void }} Timers
 */

export const BACKOFF_BASE_MS = 10_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Exponential backoff with equal jitter: failure n waits between d/2 and d,
 * where d = min(maxMs, baseMs * 2^(n-1)).
 * @param {number} failures consecutive failures so far (>= 1)
 * @param {{ baseMs?: number, maxMs?: number, random?: () => number }} [options]
 * @returns {number} milliseconds
 */
export function computeBackoffMs(failures, { baseMs = BACKOFF_BASE_MS, maxMs = BACKOFF_MAX_MS, random = Math.random } = {}) {
  if (failures <= 0) return 0;
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 30));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/**
 * A `lastPush` record from sync-state.json, if well-formed.
 * @param {unknown} value
 * @returns {PushRecord | null}
 */
export function toPushRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.at !== 'string' || typeof record.ok !== 'boolean') return null;
  return /** @type {PushRecord} */ (record);
}

/**
 * @param {{ client: SyncClient, push?: typeof pushOutbox, now?: () => number, timers?: Timers,
 *           random?: () => number, baseMs?: number, maxMs?: number,
 *           saveState?: (patch: Record<string, unknown>) => unknown, initialLast?: PushRecord | null }} options
 */
export function createSyncer({
  client,
  push = pushOutbox,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  random = Math.random,
  baseMs = BACKOFF_BASE_MS,
  maxMs = BACKOFF_MAX_MS,
  saveState = updateSyncState,
  initialLast = null,
}) {
  /** @type {Promise<PushSummary | null> | null} */
  let running = null;
  let rerun = false;
  let failures = 0;
  /** @type {number | null} */
  let nextRetryAt = null;
  /** @type {any} */
  let timer = null;
  /** @type {AbortController | null} */
  let controller = null;
  let disposed = false;
  let last = initialLast;
  /** @type {Set<(snapshot: SyncSnapshot) => void>} */
  const listeners = new Set();

  /** @returns {SyncSnapshot} */
  function getSnapshot() {
    return { phase: running ? 'pushing' : nextRetryAt !== null ? 'backoff' : 'idle', failures, nextRetryAt, last };
  }

  function emit() {
    const snapshot = getSnapshot();
    for (const listener of listeners) listener(snapshot);
  }

  function clearTimer() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  }

  function resetBackoff() {
    failures = 0;
    nextRetryAt = null;
    clearTimer();
  }

  /** @param {SyncError} error */
  function scheduleRetry(error) {
    failures += 1;
    const delay = Math.max(computeBackoffMs(failures, { baseMs, maxMs, random }), Math.min(error.retryAfterMs ?? 0, maxMs));
    nextRetryAt = now() + delay;
    clearTimer();
    timer = timers.setTimeout(() => {
      timer = null;
      void start();
    }, delay);
    if (timer && typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') timer.unref();
  }

  /** @returns {Promise<PushSummary | null>} null when not logged in */
  async function runOnce() {
    if (!client.getAuth()) return null;
    controller = new AbortController();
    try {
      return await push({ client, signal: controller.signal });
    } finally {
      controller = null;
    }
  }

  /** @param {PushSummary | null} summary */
  function settle(summary) {
    if (summary === null || summary.error?.kind === 'aborted') return;
    const { error } = summary;
    if (summary.attempted || error) {
      last = {
        at: new Date(now()).toISOString(),
        ok: error === null,
        accepted: summary.accepted,
        rejected: summary.rejected,
        remaining: summary.remaining,
        invalidLines: summary.invalidLines,
        error: error ? { code: error.code, message: error.message } : null,
      };
      saveState({ lastPush: last });
    }
    if (!error || error.kind === 'auth') resetBackoff(); // auth problems need /login, not retries
    else scheduleRetry(error);
  }

  async function loop() {
    /** @type {PushSummary | null} */
    let summary = null;
    do {
      rerun = false;
      summary = await runOnce();
      if (disposed) return summary;
      settle(summary);
    } while (rerun && summary !== null && summary.error === null);
    return summary;
  }

  /** @returns {Promise<PushSummary | null>} */
  function start() {
    if (disposed) return Promise.resolve(null);
    if (running) {
      rerun = true;
      return running;
    }
    nextRetryAt = null;
    clearTimer();
    running = loop().finally(() => {
      running = null;
      if (!disposed) emit();
    });
    emit();
    return running;
  }

  return {
    getSnapshot,

    /**
     * Push now unless backing off. `force` (/sync now, login) skips the backoff.
     * Resolves with the summary of the pass that covers this request, or null
     * when nothing ran (logged out, backing off, disposed).
     * @param {{ force?: boolean }} [options]
     * @returns {Promise<PushSummary | null>}
     */
    requestPush({ force = false } = {}) {
      if (disposed) return Promise.resolve(null);
      if (force) resetBackoff();
      else if (!running && nextRetryAt !== null && now() < nextRetryAt) return Promise.resolve(null);
      return start();
    },

    /** @param {(snapshot: SyncSnapshot) => void} listener @returns {() => void} */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Stop an in-flight push and any scheduled retry (e.g. on /logout). */
    abort() {
      rerun = false;
      controller?.abort();
      resetBackoff();
      emit();
    },

    dispose() {
      disposed = true;
      rerun = false;
      controller?.abort();
      resetBackoff();
      listeners.clear();
    },
  };
}
