import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CARD_MS,
  UNDO_WINDOW_MS,
  currentCard,
  dropItem,
  expireUndo,
  flip,
  pause,
  progress,
  rate,
  resume,
  sessionStats,
  startSession,
  undoRating,
  type SessionState,
} from '../miniprogram/lib/review-session.ts'
import type { QueueCard, Rating } from '../miniprogram/lib/review-types.ts'

const DAY = 86_400
const T0 = Date.parse('2026-11-20T08:00:00.000Z')

const card = (id: string, itemId: string = `item-${id}`): QueueCard => ({
  id,
  itemId,
  itemType: 'word',
  cardType: 'recognize',
  front: { text: `word-${id}`, ipa: 'wɜːd' },
  back: { text: 'n. 单词' },
  state: 'new',
  intervals: { '1': 600, '2': DAY / 2, '3': DAY, '4': 4 * DAY },
})

/** Flips and rates the current card. */
const flipAndRate = (state: SessionState, rating: Rating, logId: string, now: number): SessionState => {
  const result = rate(flip(state), rating, logId, now)
  assert.ok(result, 'rate returned null')
  return result.state
}

test('a session starts on the first card, face down, without duplicates', () => {
  const state = startSession([card('a'), card('b'), card('a')], T0)
  assert.equal(state.phase, 'reviewing')
  assert.equal(state.queue.length, 2)
  assert.equal(currentCard(state)?.id, 'a')
  assert.equal(state.flipped, false)
  assert.deepEqual(progress(state), { position: 1, total: 2, share: 0 })
})

test('an empty queue is done at once', () => {
  const state = startSession([], T0)
  assert.equal(state.phase, 'done')
  assert.equal(currentCard(state), null)
  assert.equal(flip(state), state)
})

test('a card cannot be rated before it is flipped', () => {
  const state = startSession([card('a')], T0)
  assert.equal(rate(state, 3, '01JD0000000000000000000000', T0 + 1000), null)
})

test('rating returns the log and moves on', () => {
  const start = flip(startSession([card('a'), card('b')], T0))
  const result = rate(start, 3, 'log-1', T0 + 4_200)
  assert.ok(result)
  assert.deepEqual(result.log, {
    id: 'log-1',
    cardId: 'a',
    rating: 3,
    reviewedAt: '2026-11-20T08:00:04.200Z',
    durationMs: 4_200,
  })
  const next = result.state
  assert.equal(currentCard(next)?.id, 'b')
  assert.equal(next.flipped, false)
  assert.equal(next.shownAt, T0 + 4_200)
  assert.deepEqual(next.undo, { logId: 'log-1', rating: 3, until: T0 + 4_200 + UNDO_WINDOW_MS })
  assert.deepEqual(progress(next), { position: 2, total: 2, share: 0.5 })
})

test('a card left open counts at most MAX_CARD_MS', () => {
  const result = rate(flip(startSession([card('a')], T0)), 2, 'log-1', T0 + 60 * 60_000)
  assert.equal(result?.log.durationMs, MAX_CARD_MS)
})

test('rating the last card ends the session; undo brings it back flipped', () => {
  let state = startSession([card('a')], T0)
  state = flipAndRate(state, 1, 'log-1', T0 + 3_000)
  assert.equal(state.phase, 'done')
  assert.equal(currentCard(state), null)

  state = undoRating(state, 'log-1', T0 + 5_000)
  assert.equal(state.phase, 'reviewing')
  assert.equal(currentCard(state)?.id, 'a')
  assert.equal(state.flipped, true)
  assert.equal(state.undo, null)
  assert.equal(state.rated.length, 0)
  // The 3 s already spent still count when it is rated again.
  const again = rate(state, 3, 'log-2', T0 + 6_000)
  assert.equal(again?.log.durationMs, 4_000)
})

test('only the rating on the undo strip can be undone', () => {
  let state = startSession([card('a'), card('b'), card('c')], T0)
  state = flipAndRate(state, 3, 'log-1', T0 + 1_000)
  state = flipAndRate(state, 3, 'log-2', T0 + 2_000)
  assert.equal(undoRating(state, 'log-1', T0 + 2_500), state)
  state = expireUndo(state, 'log-1')
  assert.equal(state.undo?.logId, 'log-2', 'an older timer does not clear a newer strip')
  state = expireUndo(state, 'log-2')
  assert.equal(state.undo, null)
  assert.equal(undoRating(state, 'log-2', T0 + 9_000), state)
})

test('reporting drops every remaining card of the item', () => {
  let state = startSession([card('a', 'x'), card('b', 'y'), card('c', 'x'), card('d', 'z')], T0)
  state = flip(state)
  state = dropItem(state, 'x', T0 + 2_000)
  assert.deepEqual(
    state.queue.map((entry) => entry.id),
    ['b', 'd'],
  )
  assert.equal(state.flipped, false)
  assert.equal(state.shownAt, T0 + 2_000)
  assert.equal(state.dropped, 2)
  assert.deepEqual(progress(state), { position: 1, total: 2, share: 0 })
  assert.equal(dropItem(state, 'nope', T0), state)
})

test('reporting the last card ends the session and clears an undo of the same item', () => {
  let state = startSession([card('a', 'x'), card('b', 'x')], T0)
  state = flipAndRate(state, 3, 'log-1', T0 + 1_000)
  state = dropItem(state, 'x', T0 + 2_000)
  assert.equal(state.phase, 'done')
  assert.equal(state.undo, null)
})

test('time hidden does not count', () => {
  let state = flip(startSession([card('a')], T0))
  state = pause(state, T0 + 2_000)
  assert.equal(rate(state, 3, 'log-1', T0 + 3_000), null, 'no rating while hidden')
  state = resume(state, T0 + 62_000)
  const result = rate(state, 3, 'log-1', T0 + 63_000)
  assert.equal(result?.log.durationMs, 3_000)
  assert.equal(resume(state, T0), state)
})

test('sessionStats: count, time, remembered share and cards due again by tomorrow', () => {
  let state = startSession([card('a'), card('b'), card('c'), card('d')], T0)
  state = flipAndRate(state, 1, 'l1', T0 + 5_000) // due in 10 min
  state = flipAndRate(state, 3, 'l2', T0 + 9_000) // due in 1 day
  state = flipAndRate(state, 4, 'l3', T0 + 12_000) // due in 4 days
  const endOfTomorrow = T0 + 2 * DAY * 1000
  assert.deepEqual(sessionStats(state, endOfTomorrow), {
    reviewed: 3,
    durationMs: 12_000,
    remembered: 2,
    dueAgain: 2,
  })
})
