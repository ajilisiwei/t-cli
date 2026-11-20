/**
 * React glue for /review: drives the pure session machine in
 * utils/review.js, posts each rating at once (client ULID, idempotent),
 * undoes on the server, retries failed posts when the session ends and
 * keeps still-unsent ratings in memory for the next /review.
 *
 * Input: the App routes keys here while a session is active (the text box
 * is unfocused then), so there is one input surface and no stdin access.
 * Output: only through `notify` (the message log). The session lives in a
 * ref so two keys that arrive before a re-render never act on stale state.
 */
import { useEffect, useRef, useState } from 'react';
import { ulid } from '@t-cli/core/ulid';
import { SyncError } from './client.js';
import { REVIEW_POST_MAX, fetchReviewQueue, submitReviewLogs, undoReviewLog } from './learning.js';
import { syncOffLines } from './status.js';
import {
  checkUndo,
  createReviewSession,
  currentCard,
  formatCardFace,
  formatCardHeader,
  formatInterval,
  formatRatingOptions,
  formatReviewSummary,
  isComplete,
  ratingLabel,
  reviewReducer,
  summarizeReview,
  unsentLogs,
} from '../utils/review.js';

/** @typedef {import('./status.js').ServerSetting} ServerSetting */
/** @typedef {ReturnType<typeof import('./client.js').createSyncClient>} SyncClient */
/** @typedef {import('./learning.js').ReviewLog} ReviewLog */
/** @typedef {import('./learning.js').LogOutcome} LogOutcome */
/** @typedef {import('../utils/review.js').ReviewSession} ReviewSession */
/** @typedef {(text: string, options?: { color?: string, dim?: boolean, bold?: boolean }) => void} Notify */
/** @typedef {{ return?: boolean, escape?: boolean }} Key */

/** Time spent on one card is capped (an idle terminal is not study time). */
export const MAX_CARD_DURATION_MS = 5 * 60_000;
/**
 * An Enter this soon after a rating key ends a typed "3⏎" (the box looks
 * like an input): it must not flip the next card before the user tried to
 * recall it. Space always flips.
 */
export const ENTER_GRACE_MS = 500;

/**
 * @template T
 * @param {readonly T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {{ client: SyncClient | null, server: ServerSetting, notify: Notify }} props
 */
export function useReview({ client, server, notify }) {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  /** @type {Notify} */
  const say = (text, options) => notifyRef.current(text, options);

  const sessionRef = useRef(/** @type {ReviewSession | null} */ (null));
  const [session, setSession] = useState(/** @type {ReviewSession | null} */ (null));
  const busyRef = useRef(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(/** @type {string | null} */ (null));
  /** In-flight posts by log id (an undo waits for its log's post). */
  const inflightRef = useRef(/** @type {Map<string, Promise<LogOutcome[]>>} */ (new Map()));
  /** Ratings a finished session could not save; retried at the next /review. */
  const leftoverRef = useRef(/** @type {ReviewLog[]} */ ([]));
  /** When the last rating key arrived (see ENTER_GRACE_MS). */
  const lastRatingKeyAtRef = useRef(0);
  const controllerRef = useRef(new AbortController());

  useEffect(() => () => controllerRef.current.abort(), []);

  /** @param {ReviewSession | null} next */
  const commit = (next) => {
    sessionRef.current = next;
    setSession(next);
  };
  /** @param {import('../utils/review.js').ReviewAction} action */
  const dispatch = (action) => {
    if (sessionRef.current) commit(reviewReducer(sessionRef.current, action));
  };
  /** @param {string | null} label */
  const setBusyLabel = (label) => {
    busyRef.current = label;
    setBusy(label);
  };

  /** @param {ReviewSession} current */
  const showCard = (current) => {
    const card = currentCard(current);
    if (!card) return;
    // The leading line break keeps one blank line between cards in the log.
    say(`\n${formatCardHeader(current)}`, { dim: true });
    say(formatCardFace(card.front), { color: 'cyan' });
  };

  /**
   * Post logs; their outcomes update the session (if it still holds them).
   * @param {ReviewLog[]} logs
   * @returns {Promise<LogOutcome[]>}
   */
  const post = (logs) => {
    const { signal } = controllerRef.current;
    /** @type {Promise<LogOutcome[]>} */
    const promise = submitReviewLogs(/** @type {SyncClient} */ (client), logs, { signal })
      .then((outcomes) => {
        if (!signal.aborted) dispatch({ type: 'settled', outcomes, now: Date.now() });
        return outcomes;
      })
      .finally(() => {
        for (const log of logs) {
          if (inflightRef.current.get(log.id) === promise) inflightRef.current.delete(log.id);
        }
      });
    for (const log of logs) inflightRef.current.set(log.id, promise);
    return promise;
  };

  /**
   * Retry ratings an earlier session could not save; those that fail again
   * stay in `leftoverRef`. Announces what was saved.
   * @returns {Promise<number>} how many are still unsent
   */
  const retryLeftovers = async () => {
    const logs = leftoverRef.current;
    if (logs.length === 0 || !client) return logs.length;
    const { signal } = controllerRef.current;
    const outcomes = [];
    for (const batch of chunk(logs, REVIEW_POST_MAX)) {
      outcomes.push(...(await submitReviewLogs(client, batch, { signal })));
    }
    const stillFailed = new Set(outcomes.filter((o) => o.status === 'failed').map((o) => o.id));
    leftoverRef.current = logs.filter((log) => stillFailed.has(log.id));
    const saved = outcomes.filter((o) => o.status === 'accepted').length;
    if (saved > 0) say(`Saved ${plural(saved, 'rating', 'ratings')} from the earlier review.`, { dim: true });
    return leftoverRef.current.length;
  };

  const start = async () => {
    if (sessionRef.current) return say('A review is already running.', { color: 'yellow' });
    if (!client) {
      for (const line of syncOffLines(server)) say(line, { color: 'yellow' });
      return undefined;
    }
    if (!client.getAuth()) return say('Not logged in. /review uses the cards of your account: run /login first.', { color: 'yellow' });

    const earlier = await retryLeftovers();
    if (earlier > 0) {
      say(`${plural(earlier, 'earlier rating is', 'earlier ratings are')} still not saved; retrying when this review ends.`, { color: 'yellow' });
    }
    let cards;
    try {
      cards = await fetchReviewQueue(client, { signal: controllerRef.current.signal });
    } catch (error) {
      if (controllerRef.current.signal.aborted) return undefined;
      return say(`Could not load the review queue: ${errorMessage(error)}`, { color: 'red' });
    }
    if (cards.length === 0) {
      return say('Nothing to review right now. New cards are made from your records every night.', { color: 'green' });
    }
    const next = createReviewSession(cards, Date.now());
    commit(next);
    say(`Review: ${plural(cards.length, 'card', 'cards')}. Enter/space flips · 1–4 rates · u undoes · q quits.`, { color: 'cyan', bold: true });
    showCard(next);
    return undefined;
  };

  const flip = () => {
    if (sessionRef.current?.face !== 'front') return;
    dispatch({ type: 'flip' });
    const current = sessionRef.current;
    const card = current ? currentCard(current) : null;
    if (card) say(formatCardFace(card.back), { color: 'green' });
  };

  /** @param {1|2|3|4} rating */
  const rate = (rating) => {
    const current = sessionRef.current;
    const card = current ? currentCard(current) : null;
    if (!current || !card || current.face !== 'back') return;
    const now = Date.now();
    /** @type {ReviewLog} */
    const log = {
      id: ulid({ time: now }),
      cardId: card.id,
      rating,
      reviewedAt: new Date(now).toISOString(),
      durationMs: Math.min(MAX_CARD_DURATION_MS, Math.max(0, now - current.shownAt)),
    };
    dispatch({ type: 'rate', log, now });
    say(`→ ${rating} ${ratingLabel(rating)} · next review in ${formatInterval(card.intervals[/** @type {'1'} */ (String(rating))])}`, { dim: true });
    void post([log]);
    const after = /** @type {ReviewSession} */ (sessionRef.current);
    if (isComplete(after)) {
      say(`All ${plural(after.cards.length, 'card', 'cards')} rated. u undoes the last rating; Enter or q ends the review.`, { color: 'cyan' });
    } else {
      showCard(after);
    }
  };

  const undo = async () => {
    const { signal } = controllerRef.current;
    let check = checkUndo(/** @type {ReviewSession} */ (sessionRef.current), Date.now());
    if (!check.ok && check.reason === 'pending' && check.record) {
      setBusyLabel('Waiting for the last rating to be saved...');
      try {
        await inflightRef.current.get(check.record.log.id);
      } finally {
        setBusyLabel(null);
      }
      if (!sessionRef.current) return;
      check = checkUndo(sessionRef.current, Date.now());
    }
    if (!check.ok) {
      if (check.reason === 'nothing') say('Nothing to undo yet.', { dim: true });
      else if (check.reason === 'expired') say('Too late to undo: ratings can be undone for 5 minutes.', { color: 'yellow' });
      return;
    }

    const { record, remote } = check;
    if (remote !== 'none') {
      setBusyLabel('Undoing...');
      try {
        await undoReviewLog(/** @type {SyncClient} */ (client), record.log.id, { signal });
      } catch (error) {
        const unknownToServer = error instanceof SyncError && error.status === 404;
        if (remote === 'required' && !unknownToServer) {
          if (error instanceof SyncError && error.code === 'UNDO_EXPIRED') {
            say('Too late to undo: the server only allows it for 5 minutes.', { color: 'yellow' });
          } else {
            say(`Undo failed: ${errorMessage(error)}`, { color: 'red' });
          }
          return;
        }
      } finally {
        setBusyLabel(null);
      }
    }
    if (!sessionRef.current) return;
    dispatch({ type: 'undo', id: record.log.id, now: Date.now() });
    say(`Undone: ${record.log.rating} ${ratingLabel(record.log.rating)} on card ${record.cardIndex + 1}. Rate it again:`, { color: 'yellow' });
    showCard(/** @type {ReviewSession} */ (sessionRef.current));
  };

  const finish = async () => {
    const current = sessionRef.current;
    if (!current || current.phase !== 'reviewing') return;
    dispatch({ type: 'finish' });
    setBusyLabel('Saving ratings...');
    let earlier = 0;
    try {
      await Promise.allSettled([...new Set(inflightRef.current.values())]);
      const retry = [...unsentLogs(/** @type {ReviewSession} */ (sessionRef.current))];
      for (const batch of chunk(retry, REVIEW_POST_MAX)) await post(batch);
      earlier = await retryLeftovers();
    } finally {
      setBusyLabel(null);
    }
    const final = sessionRef.current;
    if (!final) return;
    leftoverRef.current = [...leftoverRef.current, ...unsentLogs(final)];
    const summary = summarizeReview(final, Date.now());
    for (const line of formatReviewSummary({ ...summary, unsent: summary.unsent + earlier })) {
      say(line.text, line.warn ? { color: 'yellow' } : { color: 'cyan', bold: true });
    }
    commit(null);
  };

  /**
   * Keys while a session is active. Returns true when the key was consumed.
   * @param {string} input
   * @param {Key} key
   * @returns {boolean}
   */
  const handleKey = (input, key) => {
    const current = sessionRef.current;
    if (!current) return false;
    if (busyRef.current || current.phase !== 'reviewing') return true;
    // A chunk such as "3\r" (typed fast or pasted) counts as its key alone.
    const typed = input.length > 1 ? input.trim() : input;
    if (key.return || typed === ' ') {
      if (key.return && Date.now() - lastRatingKeyAtRef.current < ENTER_GRACE_MS) return true;
      if (isComplete(current)) void finish();
      else if (current.face === 'front') flip();
      return true;
    }
    if (/^[1-4]$/.test(typed)) {
      lastRatingKeyAtRef.current = Date.now();
      rate(/** @type {1|2|3|4} */ (Number(typed)));
      return true;
    }
    if (typed === 'u' || typed === 'U') {
      lastRatingKeyAtRef.current = 0; // an Enter after an undo flips the restored card
      void undo();
      return true;
    }
    if (typed === 'q' || typed === 'Q' || key.escape) {
      void finish();
      return true;
    }
    return true;
  };

  return {
    active: session !== null,
    busy: busy !== null,
    statusLine: statusLine(session, busy),
    start,
    handleKey,
  };
}

/**
 * The live hint line under the log while reviewing.
 * @param {ReviewSession | null} session
 * @param {string | null} busy
 * @returns {string}
 */
export function statusLine(session, busy) {
  if (!session) return '';
  if (busy) return busy;
  if (isComplete(session)) return `All ${session.cards.length} rated · u undo · Enter/q end`;
  const card = /** @type {import('./learning.js').QueueCard} */ (currentCard(session));
  if (session.face === 'front') return `Card ${session.index + 1}/${session.cards.length} · Enter/space flip · u undo · q quit`;
  return `${formatRatingOptions(card)} · u undo · q quit`;
}
