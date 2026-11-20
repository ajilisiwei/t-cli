import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../miniprogram/lib/api.ts'
import { createOutbox, type OutboxDeps } from '../miniprogram/lib/review-queue.ts'
import type { ReviewBatchResult, ReviewLog } from '../miniprogram/lib/review-types.ts'
import { ULID_ENTROPY_BYTES, ulid } from '../miniprogram/lib/review-ulid.ts'

const T0 = Date.parse('2026-11-20T08:00:00Z')

const log = (n: number): ReviewLog => ({
  id: ulid(T0 + n, new Array<number>(ULID_ENTROPY_BYTES).fill(n)),
  cardId: `card-${n}`,
  rating: 3,
  reviewedAt: new Date(T0 + n).toISOString(),
  durationMs: 1000,
})

const offline = (): ApiError => new ApiError({ kind: 'network', code: 'NETWORK', message: 'offline' })
const http = (status: number, code: string): ApiError => new ApiError({ kind: 'http', status, code, message: code })

/** A server double: stores accepted logs by id (idempotent), can be switched offline. */
class FakeServer {
  readonly stored = new Map<string, ReviewLog>()
  readonly posts: string[][] = []
  readonly deletes: string[] = []
  online = true
  /** Resolves the next post only when released (to test undo during a post). */
  hold: Promise<void> | null = null
  deleteError: ApiError | null = null

  async post(logs: readonly ReviewLog[]): Promise<ReviewBatchResult> {
    this.posts.push(logs.map((entry) => entry.id))
    if (this.hold !== null) await this.hold
    if (!this.online) throw offline()
    for (const entry of logs) this.stored.set(entry.id, entry)
    return { accepted: logs.map((entry) => entry.id), rejected: [] }
  }

  async remove(logId: string): Promise<void> {
    this.deletes.push(logId)
    if (!this.online) throw offline()
    if (this.deleteError !== null) throw this.deleteError
    if (!this.stored.delete(logId)) throw http(404, 'NOT_FOUND')
  }
}

const setup = (server: FakeServer, overrides: Partial<OutboxDeps> = {}) => {
  let stored: unknown = null
  const outbox = createOutbox({
    load: () => stored,
    save: (logs) => {
      stored = logs.length === 0 ? null : JSON.parse(JSON.stringify(logs))
    },
    post: (logs) => server.post(logs),
    remove: (logId) => server.remove(logId),
    ...overrides,
  })
  return { outbox, storage: () => stored }
}

test('a rating is posted at once and leaves the queue', async () => {
  const server = new FakeServer()
  const { outbox, storage } = setup(server)
  outbox.record(log(1))
  await outbox.flush()
  assert.deepEqual([...server.stored.keys()], [log(1).id])
  assert.equal(storage(), null)
})

test('offline ratings stay queued and are flushed later, once each', async () => {
  const server = new FakeServer()
  server.online = false
  const { outbox } = setup(server)
  outbox.record(log(1))
  await outbox.flush()
  outbox.record(log(2))
  await outbox.flush()
  assert.deepEqual(
    outbox.pending().map((entry) => entry.cardId),
    ['card-1', 'card-2'],
  )
  assert.equal(server.stored.size, 0)

  server.online = true
  await outbox.flush()
  assert.equal(outbox.pending().length, 0)
  assert.deepEqual([...server.stored.keys()].sort(), [log(1).id, log(2).id].sort())
  // Posting the same id again is harmless (the server is idempotent by id).
  outbox.record(log(1))
  await outbox.flush()
  assert.equal(server.stored.size, 2)
})

test('a rating recorded during a post goes out in the next batch', async () => {
  const server = new FakeServer()
  let release = (): void => undefined
  server.hold = new Promise((resolve) => {
    release = resolve
  })
  const { outbox } = setup(server)
  outbox.record(log(1))
  outbox.record(log(2))
  server.hold = null
  release()
  await outbox.flush()
  assert.deepEqual(server.posts, [[log(1).id], [log(2).id]])
  assert.equal(outbox.pending().length, 0)
})

test('a batch the server refuses as invalid is dropped, not retried forever', async () => {
  const server = new FakeServer()
  const warnings: string[] = []
  const { outbox } = setup(server, {
    post: async () => {
      throw http(400, 'VALIDATION_FAILED')
    },
    warn: (message) => warnings.push(message),
  })
  outbox.record(log(1))
  await outbox.flush()
  assert.equal(outbox.pending().length, 0)
  assert.equal(warnings.length, 1)
})

test('a 404 or server error keeps the batch', async () => {
  for (const error of [http(404, 'NOT_FOUND'), http(503, 'INTERNAL'), http(429, 'RATE_LIMITED')]) {
    const { outbox } = setup(new FakeServer(), {
      post: async () => {
        throw error
      },
    })
    outbox.record(log(1))
    await outbox.flush()
    assert.equal(outbox.pending().length, 1, error.code)
  }
})

test('rejected logs are settled, not retried', async () => {
  const { outbox } = setup(new FakeServer(), {
    post: async (logs) => ({ accepted: [], rejected: logs.map((entry) => entry.id) }),
  })
  outbox.record(log(1))
  await outbox.flush()
  assert.equal(outbox.pending().length, 0)
})

test('undo of a queued rating removes it locally', async () => {
  const server = new FakeServer()
  server.online = false
  const { outbox } = setup(server)
  outbox.record(log(1))
  await outbox.flush()
  assert.equal(await outbox.undo(log(1).id), 'undone')
  assert.equal(outbox.pending().length, 0)
  assert.deepEqual(server.deletes, [])
})

test('undo of a posted rating deletes it on the server', async () => {
  const server = new FakeServer()
  const { outbox } = setup(server)
  outbox.record(log(1))
  await outbox.flush()
  assert.equal(await outbox.undo(log(1).id), 'undone')
  assert.deepEqual(server.deletes, [log(1).id])
  assert.equal(server.stored.size, 0)
})

test('undo during the post waits for it, then deletes', async () => {
  const server = new FakeServer()
  let release = (): void => undefined
  server.hold = new Promise((resolve) => {
    release = resolve
  })
  const { outbox } = setup(server)
  outbox.record(log(1))
  const undone = outbox.undo(log(1).id)
  release()
  assert.equal(await undone, 'undone')
  assert.deepEqual(server.deletes, [log(1).id])
  assert.equal(server.stored.size, 0)
})

test('undo outcomes: unknown on the server, expired, offline', async () => {
  const server = new FakeServer()
  const { outbox } = setup(server)
  // Never stored (e.g. rejected): nothing to withdraw, so it counts as undone.
  assert.equal(await outbox.undo(log(9).id), 'undone')

  outbox.record(log(1))
  await outbox.flush()
  server.deleteError = http(409, 'UNDO_EXPIRED')
  assert.equal(await outbox.undo(log(1).id), 'expired')

  server.deleteError = null
  server.online = false
  await assert.rejects(outbox.undo(log(1).id), (error: unknown) => error instanceof ApiError && error.code === 'NETWORK')
  assert.equal(server.stored.size, 1, 'the rating stands')
})

test('unreadable storage starts an empty queue', () => {
  const { outbox } = setup(new FakeServer(), { load: () => '{corrupt' })
  assert.deepEqual(outbox.pending(), [])
})
