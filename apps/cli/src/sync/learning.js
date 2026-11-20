/**
 * Learning endpoints (docs/api-v1.md, "Learning (M3–M5)"): review queue and
 * logs, daily/weekly materials, a day's records and account settings. Every
 * call goes through the sync client's authorized `request` (single-flight
 * refresh, timeouts, no redirects).
 *
 * Responses are external data: each one is shape-checked here, and anything
 * malformed becomes a `BAD_RESPONSE` SyncError instead of reaching the UI.
 * Nothing here prints.
 */
import { SyncError, isTransientError } from './client.js';

/** @typedef {ReturnType<typeof import('./client.js').createSyncClient>} SyncClient */
/**
 * @typedef {{ text: string, ipa?: string, sub?: string, example?: { en: string, zh: string } }} CardFace
 * @typedef {{ id: string, itemId: string, itemType: string, cardType: string, front: CardFace, back: CardFace,
 *             state: string, intervals: Record<'1'|'2'|'3'|'4', number|null> }} QueueCard
 * @typedef {{ id: string, cardId: string, rating: 1|2|3|4, reviewedAt: string, durationMs?: number }} ReviewLog
 * @typedef {{ id: string, status: 'accepted'|'rejected'|'failed', error: string|null }} LogOutcome
 * @typedef {{ date: string, content: Record<string, unknown>, createdAt: string|null }} Material
 * @typedef {{ id: string, source: string, task: string, input: string, output: string, createdAt: string }} DayEntry
 * @typedef {{ explanationLang?: 'zh'|'en' } & Record<string, unknown>} Settings
 */

export const REVIEW_QUEUE_LIMIT = 50;
/** Most logs one `POST /v1/reviews` accepts. */
export const REVIEW_POST_MAX = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RATING_KEYS = /** @type {const} */ (['1', '2', '3', '4']);

/**
 * The local UTC offset in minutes (east positive), as the server's
 * `utcOffsetMinutes` expects. For a YYYY-MM-DD date, the offset at local noon
 * of that day (DST-safe for "that local day" queries).
 * @param {string} [date]
 * @returns {number}
 */
export function utcOffsetMinutes(date) {
  const match = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  const at = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12) : new Date();
  return -at.getTimezoneOffset() || 0;
}

/**
 * Today's review cards, due cards first.
 * @param {SyncClient} client
 * @param {{ limit?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<QueueCard[]>}
 */
export async function fetchReviewQueue(client, { limit = REVIEW_QUEUE_LIMIT, signal } = {}) {
  const query = new URLSearchParams({ utcOffsetMinutes: String(utcOffsetMinutes()), limit: String(limit) });
  const data = await client.request('GET', `/v1/review/queue?${query}`, { signal });
  if (!isRecord(data) || !Array.isArray(data.cards)) throw badResponse('malformed review queue');
  const cards = data.cards.map(toQueueCard).filter((card) => card !== null);
  if (cards.length === 0 && data.cards.length > 0) throw badResponse('no usable card in the review queue');
  return cards;
}

/**
 * Post review logs and classify every log; never throws. Network trouble,
 * timeouts, 5xx, 429 and auth problems leave the logs `failed` (worth
 * retrying); other HTTP errors and per-log rejections are `rejected`.
 * @param {SyncClient} client
 * @param {readonly ReviewLog[]} logs 1..REVIEW_POST_MAX
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<LogOutcome[]>}
 */
export async function submitReviewLogs(client, logs, { signal } = {}) {
  try {
    const data = await client.request('POST', '/v1/reviews', { body: { logs }, signal });
    return classifyReviewResult(logs, data);
  } catch (error) {
    return classifyReviewError(logs, error);
  }
}

/**
 * Per-log outcome of a `POST /v1/reviews` answer. A log the answer does not
 * mention is `failed` (retried later; posts are idempotent by log id).
 * @param {readonly ReviewLog[]} logs
 * @param {unknown} data
 * @returns {LogOutcome[]}
 */
export function classifyReviewResult(logs, data) {
  if (!isRecord(data) || !Array.isArray(data.accepted) || !Array.isArray(data.rejected)) {
    return logs.map((log) => ({ id: log.id, status: 'failed', error: 'malformed response' }));
  }
  const accepted = new Set(data.accepted.filter((id) => typeof id === 'string'));
  /** @type {Map<string, string>} */
  const rejected = new Map();
  for (const item of data.rejected) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const errors = Array.isArray(item.errors) ? item.errors.filter((e) => typeof e === 'string') : [];
    rejected.set(item.id, errors.join('; ') || 'rejected');
  }
  return logs.map((log) => {
    if (accepted.has(log.id)) return { id: log.id, status: 'accepted', error: null };
    if (rejected.has(log.id)) return { id: log.id, status: 'rejected', error: rejected.get(log.id) ?? 'rejected' };
    return { id: log.id, status: 'failed', error: 'not acknowledged' };
  });
}

/**
 * @param {readonly ReviewLog[]} logs
 * @param {unknown} error
 * @returns {LogOutcome[]}
 */
export function classifyReviewError(logs, error) {
  const message = error instanceof Error ? error.message : String(error);
  const retryable = !(error instanceof SyncError)
    || isTransientError(error)
    || ['auth', 'aborted', 'timeout', 'network', 'protocol'].includes(error.kind);
  const status = retryable ? 'failed' : 'rejected';
  return logs.map((log) => ({ id: log.id, status, error: message }));
}

/**
 * Undo a review log (allowed for 5 minutes after the server accepted it).
 * Throws SyncError: `UNDO_EXPIRED` (409), `NOT_FOUND` (404), transport errors.
 * @param {SyncClient} client
 * @param {string} logId
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
export async function undoReviewLog(client, logId, { signal } = {}) {
  await client.request('DELETE', `/v1/reviews/${encodeURIComponent(logId)}`, { signal });
}

/**
 * A daily material (date omitted → the latest), or null when the server has
 * none (404).
 * @param {SyncClient} client
 * @param {string|null} date YYYY-MM-DD
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Material|null>}
 */
export function fetchDailyMaterial(client, date, { signal } = {}) {
  return fetchMaterial(client, 'daily', date, { signal });
}

/**
 * A weekly report (`date` = the week's Monday; omitted → the latest), or null (404).
 * @param {SyncClient} client
 * @param {string|null} weekStart YYYY-MM-DD
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Material|null>}
 */
export function fetchWeeklyReport(client, weekStart, { signal } = {}) {
  return fetchMaterial(client, 'weekly', weekStart, { signal });
}

/**
 * Dates that have a material of `kind`, newest first.
 * @param {SyncClient} client
 * @param {{ kind: 'daily'|'weekly', limit?: number, signal?: AbortSignal }} options
 * @returns {Promise<string[]>}
 */
export async function listMaterialDates(client, { kind, limit = 14, signal }) {
  const query = new URLSearchParams({ kind, limit: String(limit) });
  const data = await client.request('GET', `/v1/materials?${query}`, { signal });
  if (!isRecord(data) || !Array.isArray(data.dates)) throw badResponse('malformed materials list');
  return data.dates.filter((date) => typeof date === 'string' && DATE_RE.test(date));
}

/**
 * That local day's records (every source), oldest first.
 * @param {SyncClient} client
 * @param {string} date YYYY-MM-DD (local)
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<DayEntry[]>}
 */
export async function fetchDayEntries(client, date, { signal } = {}) {
  const query = new URLSearchParams({ date, utcOffsetMinutes: String(utcOffsetMinutes(date)) });
  const data = await client.request('GET', `/v1/entries/day?${query}`, { signal });
  if (!isRecord(data) || !Array.isArray(data.entries)) throw badResponse('malformed day entries');
  return data.entries.filter(isDayEntry);
}

/**
 * The account's settings (`GET /v1/me`).
 * @param {SyncClient} client
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Settings>}
 */
export async function fetchSettings(client, { signal } = {}) {
  const data = await client.request('GET', '/v1/me', { signal });
  if (!isRecord(data)) throw badResponse('malformed /v1/me response');
  return isRecord(data.settings) ? /** @type {Settings} */ (data.settings) : {};
}

/**
 * Merge a partial settings object into the account's settings.
 * @param {SyncClient} client
 * @param {Settings} patch
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Settings>} the full settings after the merge
 */
export async function pushSettings(client, patch, { signal } = {}) {
  const data = await client.request('POST', '/v1/me/settings', { body: patch, signal });
  if (!isRecord(data) || !isRecord(data.settings)) throw badResponse('malformed settings response');
  return /** @type {Settings} */ (data.settings);
}

/**
 * @param {SyncClient} client
 * @param {'daily'|'weekly'} kind
 * @param {string|null} date
 * @param {{ signal?: AbortSignal }} options
 * @returns {Promise<Material|null>}
 */
async function fetchMaterial(client, kind, date, { signal }) {
  const query = date ? `?${new URLSearchParams({ date })}` : '';
  let data;
  try {
    data = await client.request('GET', `/v1/materials/${kind}${query}`, { signal });
  } catch (error) {
    if (error instanceof SyncError && error.status === 404) return null;
    throw error;
  }
  if (!isRecord(data) || typeof data.date !== 'string' || !isRecord(data.content)) {
    throw badResponse(`malformed ${kind} material`);
  }
  return { date: data.date, content: data.content, createdAt: typeof data.createdAt === 'string' ? data.createdAt : null };
}

/**
 * @param {unknown} value
 * @returns {QueueCard | null}
 */
export function toQueueCard(value) {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') return null;
  const front = toCardFace(value.front);
  const back = toCardFace(value.back);
  if (!front || !back) return null;
  const rawIntervals = isRecord(value.intervals) ? value.intervals : {};
  /** @type {Record<'1'|'2'|'3'|'4', number|null>} */
  const intervals = { 1: null, 2: null, 3: null, 4: null };
  for (const key of RATING_KEYS) {
    const seconds = rawIntervals[key];
    intervals[key] = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }
  return Object.freeze({
    id: value.id,
    itemId: typeof value.itemId === 'string' ? value.itemId : '',
    itemType: typeof value.itemType === 'string' ? value.itemType : '',
    cardType: typeof value.cardType === 'string' ? value.cardType : '',
    front,
    back,
    state: typeof value.state === 'string' ? value.state : '',
    intervals: Object.freeze(intervals),
  });
}

/**
 * @param {unknown} value
 * @returns {CardFace | null}
 */
function toCardFace(value) {
  if (!isRecord(value) || typeof value.text !== 'string') return null;
  /** @type {CardFace} */
  const face = { text: value.text };
  if (typeof value.ipa === 'string' && value.ipa.trim()) face.ipa = value.ipa;
  if (typeof value.sub === 'string' && value.sub.trim()) face.sub = value.sub;
  if (isRecord(value.example) && typeof value.example.en === 'string') {
    face.example = { en: value.example.en, zh: typeof value.example.zh === 'string' ? value.example.zh : '' };
  }
  return Object.freeze(face);
}

/** @param {unknown} value @returns {value is DayEntry} */
function isDayEntry(value) {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.source === 'string'
    && typeof value.input === 'string' && value.input.trim() !== ''
    && typeof value.output === 'string'
    && typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt));
}

/** @param {string} message @returns {SyncError} */
function badResponse(message) {
  return new SyncError({ kind: 'protocol', code: 'BAD_RESPONSE', message });
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
