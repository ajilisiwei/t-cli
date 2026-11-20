/**
 * Pure logic behind /review: the session state machine (flip, rate, undo,
 * finish), interval and duration labels, card-face text and the end summary.
 * No I/O and no React: src/sync/useReview.js drives it and posts the logs.
 *
 * Sessions are immutable; every transition returns a new object.
 */

/** @typedef {import('../sync/learning.js').QueueCard} QueueCard */
/** @typedef {import('../sync/learning.js').CardFace} CardFace */
/** @typedef {import('../sync/learning.js').ReviewLog} ReviewLog */
/** @typedef {import('../sync/learning.js').LogOutcome} LogOutcome */
/**
 * @typedef {'pending'|'accepted'|'rejected'|'failed'} LogStatus
 * @typedef {{ log: ReviewLog, cardIndex: number, ratedAt: number, status: LogStatus,
 *             settledAt: number|null, error: string|null }} RatingRecord
 * @typedef {{ cards: readonly QueueCard[], index: number, face: 'front'|'back', shownAt: number,
 *             startedAt: number, ratings: readonly RatingRecord[], phase: 'reviewing'|'finishing' }} ReviewSession
 * @typedef {{ type: 'flip' } | { type: 'rate', log: ReviewLog, now: number }
 *         | { type: 'settled', outcomes: readonly LogOutcome[], now: number }
 *         | { type: 'undo', id: string, now: number } | { type: 'finish' }} ReviewAction
 */

/** Rating values and their labels (1 Again … 4 Easy). */
export const RATINGS = Object.freeze([
  Object.freeze({ value: 1, label: '忘记' }),
  Object.freeze({ value: 2, label: '困难' }),
  Object.freeze({ value: 3, label: '记得' }),
  Object.freeze({ value: 4, label: '简单' }),
]);
/** The server allows undo for 5 minutes after it accepted a log. */
export const UNDO_WINDOW_MS = 5 * 60_000;
/** Ratings that count as remembered (Hard, Good, Easy), as the server's retention. */
export const REMEMBERED_MIN_RATING = 2;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * Next-interval label for a rating option: 600 → "10 分钟", 259200 → "3 天",
 * 5184000 → "2 个月". Units switch on the rounded value, so 59.7 minutes
 * reads "1 小时", never "60 分钟".
 * @param {number|null|undefined} seconds
 * @returns {string}
 */
export function formatInterval(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return '立即';
  if (Math.round(seconds) < MINUTE) return `${Math.round(seconds)} 秒`;
  const minutes = Math.round(seconds / MINUTE);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(seconds / HOUR);
  if (hours < 24) return `${hours} 小时`;
  const days = seconds / DAY;
  if (Math.round(days) < 30) return `${Math.round(days)} 天`;
  const months = round1(days / 30);
  if (months < 12) return `${months} 个月`;
  return `${round1(days / 365)} 年`;
}

/**
 * Session length: "45 s", "4 min 10 s", "1 h 2 min".
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

/**
 * Terminal text of a card face: text (+ IPA), then sub, then the example.
 * @param {CardFace} face
 * @returns {string}
 */
export function formatCardFace(face) {
  const ipa = face.ipa ? `  ${wrapIpa(face.ipa.trim())}` : '';
  const lines = [`${face.text}${ipa}`];
  if (face.sub) lines.push(face.sub);
  if (face.example && face.example.en) {
    lines.push(`e.g. ${face.example.en}`);
    if (face.example.zh) lines.push(`     ${face.example.zh}`);
  }
  return lines.join('\n');
}

/** @param {string} ipa @returns {string} */
function wrapIpa(ipa) {
  return /^[/[]/.test(ipa) ? ipa : `/${ipa}/`;
}

/**
 * Header line above a card: "Card 2/12 · recognize (word) · new".
 * @param {ReviewSession} session
 * @returns {string}
 */
export function formatCardHeader(session) {
  const card = session.cards[session.index];
  const kind = [card.cardType, card.itemType ? `(${card.itemType})` : ''].filter(Boolean).join(' ');
  const parts = [`Card ${session.index + 1}/${session.cards.length}`];
  if (kind) parts.push(kind);
  if (card.state === 'new') parts.push('new');
  return parts.join(' · ');
}

/**
 * The four rating options with their next intervals:
 * "1 忘记 10 分钟 │ 2 困难 1 天 │ 3 记得 3 天 │ 4 简单 2 个月".
 * @param {QueueCard} card
 * @returns {string}
 */
export function formatRatingOptions(card) {
  return RATINGS
    .map(({ value, label }) => `${value} ${label} ${formatInterval(card.intervals[/** @type {'1'} */ (String(value))])}`)
    .join(' │ ');
}

/**
 * @param {number} rating
 * @returns {string}
 */
export function ratingLabel(rating) {
  return RATINGS.find((r) => r.value === rating)?.label ?? String(rating);
}

/**
 * @param {readonly QueueCard[]} cards at least one
 * @param {number} now
 * @returns {ReviewSession}
 */
export function createReviewSession(cards, now) {
  if (!Array.isArray(cards) || cards.length === 0) throw new TypeError('a review session needs at least one card');
  return Object.freeze({
    cards: Object.freeze([...cards]),
    index: 0,
    face: 'front',
    shownAt: now,
    startedAt: now,
    ratings: Object.freeze([]),
    phase: 'reviewing',
  });
}

/** @param {ReviewSession} session @returns {boolean} every card rated */
export function isComplete(session) {
  return session.index >= session.cards.length;
}

/** @param {ReviewSession} session @returns {QueueCard | null} */
export function currentCard(session) {
  return isComplete(session) ? null : session.cards[session.index];
}

/**
 * @param {ReviewSession} session
 * @param {ReviewAction} action
 * @returns {ReviewSession} the same object when the action does not apply
 */
export function reviewReducer(session, action) {
  switch (action.type) {
    case 'flip':
      if (session.phase !== 'reviewing' || isComplete(session) || session.face !== 'front') return session;
      return Object.freeze({ ...session, face: 'back' });

    case 'rate': {
      if (session.phase !== 'reviewing' || isComplete(session) || session.face !== 'back') return session;
      /** @type {RatingRecord} */
      const record = Object.freeze({
        log: Object.freeze({ ...action.log }),
        cardIndex: session.index,
        ratedAt: action.now,
        status: 'pending',
        settledAt: null,
        error: null,
      });
      return Object.freeze({
        ...session,
        index: session.index + 1,
        face: 'front',
        shownAt: action.now,
        ratings: Object.freeze([...session.ratings, record]),
      });
    }

    case 'settled': {
      const byId = new Map(action.outcomes.map((outcome) => [outcome.id, outcome]));
      let changed = false;
      const ratings = session.ratings.map((record) => {
        const outcome = byId.get(record.log.id);
        if (!outcome || record.status === 'accepted' || record.status === 'rejected') return record;
        changed = true;
        return Object.freeze({ ...record, status: outcome.status, settledAt: action.now, error: outcome.error });
      });
      return changed ? Object.freeze({ ...session, ratings: Object.freeze(ratings) }) : session;
    }

    case 'undo': {
      const last = session.ratings.at(-1);
      if (session.phase !== 'reviewing' || !last || last.log.id !== action.id) return session;
      return Object.freeze({
        ...session,
        index: last.cardIndex,
        face: 'front',
        shownAt: action.now,
        ratings: Object.freeze(session.ratings.slice(0, -1)),
      });
    }

    case 'finish':
      return session.phase === 'finishing' ? session : Object.freeze({ ...session, phase: 'finishing' });

    default:
      return session;
  }
}

/**
 * Whether `u` can undo the last rating now, and how (`remote`):
 *  - accepted → 'required': DELETE on the server, within UNDO_WINDOW_MS of acceptance;
 *  - failed → 'best-effort': the post may have reached the server before the
 *    error (e.g. a timeout), so try a DELETE, but undo locally regardless;
 *  - rejected → 'none': the server never stored it;
 *  - pending → not yet: wait for the post first.
 * @param {ReviewSession} session
 * @param {number} now
 * @returns {{ ok: true, record: RatingRecord, remote: 'required'|'best-effort'|'none' }
 *         | { ok: false, reason: 'nothing'|'pending'|'expired'|'finishing', record?: RatingRecord }}
 */
export function checkUndo(session, now) {
  if (session.phase !== 'reviewing') return { ok: false, reason: 'finishing' };
  const record = session.ratings.at(-1);
  if (!record) return { ok: false, reason: 'nothing' };
  if (record.status === 'pending') return { ok: false, reason: 'pending', record };
  const since = record.status === 'accepted' ? record.settledAt ?? record.ratedAt : record.ratedAt;
  if (now - since > UNDO_WINDOW_MS) return { ok: false, reason: 'expired', record };
  const remote = record.status === 'accepted' ? 'required' : record.status === 'failed' ? 'best-effort' : 'none';
  return { ok: true, record, remote };
}

/**
 * Logs that still need a post (failed ones; pending ones are in flight).
 * @param {ReviewSession} session
 * @returns {ReviewLog[]}
 */
export function unsentLogs(session) {
  return session.ratings.filter((record) => record.status === 'failed').map((record) => record.log);
}

/**
 * @param {ReviewSession} session
 * @param {number} now
 * @returns {{ reviewed: number, remembered: number, elapsedMs: number,
 *             unsent: number, rejected: number, rejectedErrors: string[] }}
 */
export function summarizeReview(session, now) {
  const { ratings } = session;
  const rejected = ratings.filter((record) => record.status === 'rejected');
  return {
    reviewed: ratings.length,
    remembered: ratings.filter((record) => record.log.rating >= REMEMBERED_MIN_RATING).length,
    elapsedMs: now - session.startedAt,
    unsent: ratings.filter((record) => record.status === 'failed' || record.status === 'pending').length,
    rejected: rejected.length,
    rejectedErrors: [...new Set(rejected.map((record) => record.error ?? 'rejected'))],
  };
}

/**
 * End-of-session lines: the summary, then warnings (each `{ text, warn }`).
 * @param {ReturnType<typeof summarizeReview>} summary
 * @returns {{ text: string, warn: boolean }[]}
 */
export function formatReviewSummary(summary) {
  if (summary.reviewed === 0) {
    return [{ text: `Review ended: no cards rated (${formatDuration(summary.elapsedMs)}).`, warn: false }];
  }
  const share = Math.round((summary.remembered / summary.reviewed) * 100);
  const cards = `${summary.reviewed} ${summary.reviewed === 1 ? 'card' : 'cards'}`;
  const lines = [{
    text: `Review done: ${cards} · remembered ${summary.remembered}/${summary.reviewed} (${share}%) · ${formatDuration(summary.elapsedMs)}`,
    warn: false,
  }];
  if (summary.unsent > 0) {
    lines.push({
      text: `${summary.unsent} ${summary.unsent === 1 ? 'rating was' : 'ratings were'} not saved (server unreachable); `
        + 'they are kept in memory and retried at the next /review while t-cli stays open.',
      warn: true,
    });
  }
  if (summary.rejected > 0) {
    lines.push({
      text: `${summary.rejected} ${summary.rejected === 1 ? 'rating was' : 'ratings were'} rejected by the server: ${summary.rejectedErrors.join('; ')}`,
      warn: true,
    });
  }
  return lines;
}
