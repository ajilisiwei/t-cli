import test from 'node:test'
import assert from 'node:assert/strict'
import { ulid as coreUlid } from '@t-cli/core/ulid'
import { ULID_ENTROPY_BYTES, isUlid, ulid } from '../miniprogram/lib/review-ulid.ts'
import {
  MAX_BATCH,
  enqueue,
  failureAction,
  nextBatch,
  readLog,
  readQueue,
  withoutIds,
} from '../miniprogram/lib/review-queue.ts'
import { classifySwipe, dragFeedback, MAX_DRAG_PX } from '../miniprogram/lib/review-swipe.ts'
import type { ReviewLog } from '../miniprogram/lib/review-types.ts'

test('ulid matches packages/core for the same time and entropy', () => {
  const bytes = [0, 1, 2, 3, 250, 251, 252, 253, 254, 255]
  for (const time of [0, 1, Date.parse('2026-11-20T08:00:00Z'), 2 ** 48 - 1]) {
    assert.equal(ulid(time, bytes), coreUlid({ time, entropy: Uint8Array.from(bytes) }))
  }
  const id = ulid(Date.parse('2026-11-20T08:00:00Z'), bytes)
  assert.equal(id.length, 26)
  assert.ok(isUlid(id))
})

test('ulid sorts by time and rejects bad input', () => {
  const bytes = new Array<number>(ULID_ENTROPY_BYTES).fill(255)
  const zeros = new Array<number>(ULID_ENTROPY_BYTES).fill(0)
  assert.ok(ulid(1000, bytes) < ulid(1001, zeros))
  assert.throws(() => ulid(-1, bytes), RangeError)
  assert.throws(() => ulid(1.5, bytes), RangeError)
  assert.throws(() => ulid(2 ** 48, bytes), RangeError)
  assert.throws(() => ulid(1, [1, 2, 3]), RangeError)
  assert.equal(isUlid('01JD0000000000000000000000'), true)
  assert.equal(isUlid('01jd0000000000000000000000'), false)
  assert.equal(isUlid('01JD000000000000000000000U'), false)
})

const log = (n: number, overrides: Partial<ReviewLog> = {}): ReviewLog => ({
  id: ulid(Date.parse('2026-11-20T08:00:00Z') + n, new Array<number>(ULID_ENTROPY_BYTES).fill(n % 256)),
  cardId: `card-${n}`,
  rating: 3,
  reviewedAt: new Date(Date.parse('2026-11-20T08:00:00Z') + n).toISOString(),
  durationMs: 1200,
  ...overrides,
})

test('readLog accepts contract logs and rejects the rest', () => {
  const ok = log(1)
  assert.deepEqual(readLog(ok), ok)
  assert.deepEqual(readLog({ ...ok, durationMs: undefined }), {
    id: ok.id,
    cardId: ok.cardId,
    rating: 3,
    reviewedAt: ok.reviewedAt,
  })
  assert.deepEqual(readLog({ ...ok, durationMs: -5 }), readLog({ ...ok, durationMs: undefined }))
  assert.equal(readLog({ ...ok, id: 'not-a-ulid' }), null)
  assert.equal(readLog({ ...ok, cardId: '' }), null)
  assert.equal(readLog({ ...ok, rating: 5 }), null)
  assert.equal(readLog({ ...ok, rating: '3' }), null)
  assert.equal(readLog({ ...ok, reviewedAt: 'yesterday' }), null)
  assert.equal(readLog(null), null)
})

test('readQueue drops unreadable and duplicate entries', () => {
  const a = log(1)
  const b = log(2)
  assert.deepEqual(readQueue([a, { junk: true }, b, a]), [a, b])
  assert.deepEqual(readQueue('garbage'), [])
  assert.deepEqual(readQueue(null), [])
})

test('enqueue skips logs already queued and keeps the newest past the bound', () => {
  const a = log(1)
  const b = log(2)
  const c = log(3)
  assert.deepEqual(enqueue([a], [a, b]), [a, b])
  assert.deepEqual(enqueue([a, b], [c], 2), [b, c])
})

test('nextBatch and withoutIds', () => {
  const logs = Array.from({ length: MAX_BATCH + 5 }, (_, i) => log(i))
  assert.equal(nextBatch(logs).length, MAX_BATCH)
  assert.equal(nextBatch(logs)[0], logs[0])
  assert.deepEqual(nextBatch(logs, 0), [])
  const rest = withoutIds(logs, nextBatch(logs).map((entry) => entry.id))
  assert.equal(rest.length, 5)
})

test('failureAction keeps every failure a retry may fix', () => {
  assert.equal(failureAction({ kind: 'network', status: null }), 'keep')
  assert.equal(failureAction({ kind: 'timeout' }), 'keep')
  assert.equal(failureAction({ kind: 'http', status: 429 }), 'keep')
  assert.equal(failureAction({ kind: 'http', status: 503 }), 'keep')
  assert.equal(failureAction({ kind: 'http', status: 404 }), 'keep')
  assert.equal(failureAction({ kind: 'http', status: 401 }), 'keep')
  assert.equal(failureAction({ kind: 'http', status: 400 }), 'drop')
  assert.equal(failureAction({ kind: 'http', status: 422 }), 'drop')
  assert.equal(failureAction({ kind: 'protocol', status: 200 }), 'keep')
})

test('classifySwipe: far or quick horizontal moves only', () => {
  assert.equal(classifySwipe({ dx: -120, dy: 10, dt: 400 }), 'left')
  assert.equal(classifySwipe({ dx: 90, dy: -20, dt: 600 }), 'right')
  assert.equal(classifySwipe({ dx: 50, dy: 5, dt: 150 }), 'right', 'a flick')
  assert.equal(classifySwipe({ dx: 50, dy: 5, dt: 400 }), null, 'short and slow')
  assert.equal(classifySwipe({ dx: 100, dy: 90, dt: 200 }), null, 'diagonal: a scroll')
  assert.equal(classifySwipe({ dx: 5, dy: 300, dt: 200 }), null, 'vertical')
  assert.equal(classifySwipe({ dx: Number.NaN, dy: 0, dt: 100 }), null)
})

test('dragFeedback follows horizontal drags and names the grade past the threshold', () => {
  assert.deepEqual(dragFeedback(30, 4), { offset: 30, intent: null })
  assert.deepEqual(dragFeedback(-85, 10), { offset: -85, intent: 'left' })
  assert.deepEqual(dragFeedback(95, 0), { offset: 95, intent: 'right' })
  assert.deepEqual(dragFeedback(20, 60), { offset: 0, intent: null }, 'vertical drags scroll instead')
  assert.equal(dragFeedback(-1000, 0).offset, -MAX_DRAG_PX)
})
