// /review: the pure session machine, labels and summary (utils/review.js)
// and the hint line of the React glue.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNDO_WINDOW_MS,
  checkUndo,
  createReviewSession,
  currentCard,
  formatCardFace,
  formatCardHeader,
  formatDuration,
  formatInterval,
  formatRatingOptions,
  formatReviewSummary,
  isComplete,
  ratingLabel,
  reviewReducer,
  summarizeReview,
  unsentLogs,
} from '../src/utils/review.js';
import { statusLine } from '../src/sync/useReview.js';

const CARD = (n, overrides = {}) => ({
  id: `card-${n}`, itemId: `item-${n}`, itemType: 'word', cardType: 'recognize',
  front: { text: `word${n}`, ipa: 'wɜːd' }, back: { text: 'n. 单词' }, state: 'new',
  intervals: { 1: 600, 2: 86400, 3: 259200, 4: 5184000 }, ...overrides,
});
const LOG = (n, rating = 3) => ({ id: `log-${n}`, cardId: `card-${n}`, rating, reviewedAt: '2026-11-20T01:00:00.000Z', durationMs: 1000 });

const T0 = 1_000_000;

/** Flip and rate the current card. */
function rateCurrent(session, n, rating, now) {
  const flipped = reviewReducer(session, { type: 'flip' });
  return reviewReducer(flipped, { type: 'rate', log: LOG(n, rating), now });
}

// ---------------------------------------------------------------- labels

test('formatInterval: seconds to 秒 / 分钟 / 小时 / 天 / 个月 / 年', () => {
  assert.equal(formatInterval(600), '10 分钟');
  assert.equal(formatInterval(259200), '3 天');
  assert.equal(formatInterval(5184000), '2 个月');
  assert.equal(formatInterval(30), '30 秒');
  assert.equal(formatInterval(60), '1 分钟');
  assert.equal(formatInterval(3582), '1 小时'); // 59.7 min rounds up a unit
  assert.equal(formatInterval(7200), '2 小时');
  assert.equal(formatInterval(86400), '1 天');
  assert.equal(formatInterval(29.6 * 86400), '1 个月');
  assert.equal(formatInterval(45 * 86400), '1.5 个月');
  assert.equal(formatInterval(359 * 86400), '1 年');
  assert.equal(formatInterval(730 * 86400), '2 年');
  assert.equal(formatInterval(0), '立即');
  assert.equal(formatInterval(null), '—');
  assert.equal(formatInterval(-5), '—');
  assert.equal(formatInterval(Number.NaN), '—');
});

test('formatDuration: s / min s / h min', () => {
  assert.equal(formatDuration(45_000), '45 s');
  assert.equal(formatDuration(250_000), '4 min 10 s');
  assert.equal(formatDuration(3_720_000), '1 h 2 min');
  assert.equal(formatDuration(-5), '0 s');
});

test('formatCardFace: text + IPA, sub, example', () => {
  assert.equal(formatCardFace({ text: 'meticulous', ipa: 'məˈtɪkjələs' }), 'meticulous  /məˈtɪkjələs/');
  assert.equal(formatCardFace({ text: 'x', ipa: '/ɛks/' }), 'x  /ɛks/');
  assert.equal(
    formatCardFace({ text: 'She ____ late.', sub: '她迟到了。', example: { en: 'He came late.', zh: '他来晚了。' } }),
    'She ____ late.\n她迟到了。\ne.g. He came late.\n     他来晚了。',
  );
  assert.equal(formatCardFace({ text: 'y', example: { en: 'Only English.', zh: '' } }), 'y\ne.g. Only English.');
});

test('formatRatingOptions / ratingLabel / formatCardHeader', () => {
  assert.equal(formatRatingOptions(CARD(1)), '1 忘记 10 分钟 │ 2 困难 1 天 │ 3 记得 3 天 │ 4 简单 2 个月');
  assert.equal(formatRatingOptions(CARD(1, { intervals: { 1: null, 2: 60, 3: 60, 4: 60 } })).startsWith('1 忘记 —'), true);
  assert.deepEqual([1, 2, 3, 4].map(ratingLabel), ['忘记', '困难', '记得', '简单']);
  const session = createReviewSession([CARD(1), CARD(2, { state: 'review', itemType: '' })], T0);
  assert.equal(formatCardHeader(session), 'Card 1/2 · recognize (word) · new');
  assert.equal(formatCardHeader({ ...session, index: 1 }), 'Card 2/2 · recognize');
});

// ---------------------------------------------------------------- state machine

test('session: flip then rate advances; rating needs the back; nothing past the end', () => {
  const cards = [CARD(1), CARD(2)];
  const s0 = createReviewSession(cards, T0);
  assert.equal(s0.face, 'front');
  assert.equal(currentCard(s0).id, 'card-1');
  assert.equal(Object.isFrozen(s0), true);

  // Rating the front is ignored.
  assert.equal(reviewReducer(s0, { type: 'rate', log: LOG(1), now: T0 }), s0);

  const s1 = reviewReducer(s0, { type: 'flip' });
  assert.equal(s1.face, 'back');
  assert.equal(s0.face, 'front', 'immutable');
  assert.equal(reviewReducer(s1, { type: 'flip' }), s1, 'flipping the back is a no-op');

  const s2 = reviewReducer(s1, { type: 'rate', log: LOG(1, 3), now: T0 + 5000 });
  assert.equal(s2.index, 1);
  assert.equal(s2.face, 'front');
  assert.equal(s2.shownAt, T0 + 5000);
  assert.deepEqual(s2.ratings.map((r) => [r.log.id, r.cardIndex, r.status]), [['log-1', 0, 'pending']]);

  const s3 = rateCurrent(s2, 2, 1, T0 + 9000);
  assert.equal(isComplete(s3), true);
  assert.equal(currentCard(s3), null);
  assert.equal(reviewReducer(s3, { type: 'flip' }), s3);
  assert.throws(() => createReviewSession([], T0), TypeError);
});

test('session: settled outcomes update matching ratings; accepted/rejected are final', () => {
  let s = rateCurrent(createReviewSession([CARD(1), CARD(2)], T0), 1, 3, T0 + 1000);
  s = rateCurrent(s, 2, 2, T0 + 2000);
  s = reviewReducer(s, { type: 'settled', outcomes: [{ id: 'log-1', status: 'accepted', error: null }, { id: 'log-2', status: 'failed', error: 'network' }], now: T0 + 3000 });
  assert.deepEqual(s.ratings.map((r) => [r.status, r.settledAt]), [['accepted', T0 + 3000], ['failed', T0 + 3000]]);
  assert.deepEqual(unsentLogs(s).map((log) => log.id), ['log-2']);

  const same = reviewReducer(s, { type: 'settled', outcomes: [{ id: 'log-1', status: 'failed', error: 'x' }, { id: 'zzz', status: 'accepted', error: null }], now: T0 + 4000 });
  assert.equal(same, s, 'accepted stays accepted; unknown ids are ignored');

  const retried = reviewReducer(s, { type: 'settled', outcomes: [{ id: 'log-2', status: 'accepted', error: null }], now: T0 + 5000 });
  assert.deepEqual(unsentLogs(retried), []);
});

test('undo: back to the rated card, front up; only the last rating; stack of undos', () => {
  let s = rateCurrent(createReviewSession([CARD(1), CARD(2), CARD(3)], T0), 1, 3, T0 + 1000);
  s = rateCurrent(s, 2, 4, T0 + 2000);
  assert.equal(reviewReducer(s, { type: 'undo', id: 'log-1', now: T0 }), s, 'not the last rating');

  const u1 = reviewReducer(s, { type: 'undo', id: 'log-2', now: T0 + 3000 });
  assert.equal(u1.index, 1);
  assert.equal(u1.face, 'front');
  assert.equal(u1.shownAt, T0 + 3000);
  assert.deepEqual(u1.ratings.map((r) => r.log.id), ['log-1']);

  const u2 = reviewReducer(u1, { type: 'undo', id: 'log-1', now: T0 + 4000 });
  assert.equal(u2.index, 0);
  assert.deepEqual(u2.ratings, []);

  // Undo works after the last card too (the "all rated" step).
  let done = rateCurrent(createReviewSession([CARD(1)], T0), 1, 3, T0 + 1000);
  assert.equal(isComplete(done), true);
  done = reviewReducer(done, { type: 'undo', id: 'log-1', now: T0 + 2000 });
  assert.equal(isComplete(done), false);
  assert.equal(currentCard(done).id, 'card-1');
});

test('checkUndo: remote for accepted within 5 min, best-effort for failed, local for rejected', () => {
  const base = rateCurrent(createReviewSession([CARD(1), CARD(2)], T0), 1, 3, T0);
  assert.deepEqual(checkUndo(createReviewSession([CARD(1)], T0), T0), { ok: false, reason: 'nothing' });
  assert.equal(checkUndo(base, T0).reason, 'pending');

  const settle = (status) => reviewReducer(base, { type: 'settled', outcomes: [{ id: 'log-1', status, error: null }], now: T0 + 1000 });
  const accepted = checkUndo(settle('accepted'), T0 + 1000 + UNDO_WINDOW_MS);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.remote, 'required');
  assert.equal(checkUndo(settle('accepted'), T0 + 1001 + UNDO_WINDOW_MS).reason, 'expired', 'window starts at acceptance');
  assert.equal(checkUndo(settle('failed'), T0 + 10).remote, 'best-effort');
  assert.equal(checkUndo(settle('rejected'), T0 + 10).remote, 'none');
  assert.equal(checkUndo(settle('failed'), T0 + UNDO_WINDOW_MS + 1).reason, 'expired');
  assert.equal(checkUndo(reviewReducer(settle('accepted'), { type: 'finish' }), T0).reason, 'finishing');
});

test('finish: ratings and undo stop applying; finishing twice is a no-op', () => {
  const s = reviewReducer(createReviewSession([CARD(1)], T0), { type: 'flip' });
  const f = reviewReducer(s, { type: 'finish' });
  assert.equal(f.phase, 'finishing');
  assert.equal(reviewReducer(f, { type: 'finish' }), f);
  assert.equal(reviewReducer(f, { type: 'rate', log: LOG(1), now: T0 }), f);
  assert.equal(reviewReducer(f, { type: 'flip' }), f);
});

// ---------------------------------------------------------------- summary

test('summary: remembered = ratings 2–4; unsent and rejected are reported', () => {
  let s = createReviewSession([CARD(1), CARD(2), CARD(3), CARD(4)], T0);
  s = rateCurrent(s, 1, 1, T0 + 1000);
  s = rateCurrent(s, 2, 2, T0 + 2000);
  s = rateCurrent(s, 3, 4, T0 + 3000);
  s = reviewReducer(s, {
    type: 'settled',
    outcomes: [
      { id: 'log-1', status: 'accepted', error: null },
      { id: 'log-2', status: 'failed', error: 'network' },
      { id: 'log-3', status: 'rejected', error: 'unknown card' },
    ],
    now: T0 + 4000,
  });
  const summary = summarizeReview(s, T0 + 250_000);
  assert.deepEqual(summary, { reviewed: 3, remembered: 2, elapsedMs: 250_000, unsent: 1, rejected: 1, rejectedErrors: ['unknown card'] });
  const lines = formatReviewSummary(summary);
  assert.equal(lines[0].text, 'Review done: 3 cards · remembered 2/3 (67%) · 4 min 10 s');
  assert.equal(lines[0].warn, false);
  assert.match(lines[1].text, /^1 rating was not saved/);
  assert.match(lines[2].text, /^1 rating was rejected by the server: unknown card$/);
  assert.equal(lines.slice(1).every((line) => line.warn), true);
});

test('summary: nothing rated', () => {
  const lines = formatReviewSummary(summarizeReview(createReviewSession([CARD(1)], T0), T0 + 3000));
  assert.deepEqual(lines, [{ text: 'Review ended: no cards rated (3 s).', warn: false }]);
});

// ---------------------------------------------------------------- hint line

test('statusLine: front, back with intervals, all rated, busy', () => {
  const s0 = createReviewSession([CARD(1)], T0);
  assert.equal(statusLine(null, null), '');
  assert.equal(statusLine(s0, null), 'Card 1/1 · Enter/space flip · u undo · q quit');
  const back = reviewReducer(s0, { type: 'flip' });
  assert.equal(statusLine(back, null), '1 忘记 10 分钟 │ 2 困难 1 天 │ 3 记得 3 天 │ 4 简单 2 个月 · u undo · q quit');
  const done = reviewReducer(back, { type: 'rate', log: LOG(1), now: T0 });
  assert.equal(statusLine(done, null), 'All 1 rated · u undo · Enter/q end');
  assert.equal(statusLine(done, 'Undoing...'), 'Undoing...');
});
