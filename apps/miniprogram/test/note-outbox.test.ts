import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../miniprogram/lib/api.ts'
import {
  MAX_PENDING_NOTES,
  createNoteOutbox,
  enqueueNoteOp,
  noteFailureAction,
  noteKey,
  readNoteQueue,
  toNoteInput,
  type NoteOp,
} from '../miniprogram/lib/note-outbox.ts'
import { ULID_ENTROPY_BYTES, ulid } from '../miniprogram/lib/review-ulid.ts'
import type { NoteInput } from '../miniprogram/lib/types.ts'

const T0 = Date.parse('2026-11-24T08:00:00Z')
const id = (n: number): string => ulid(T0 + n, new Array<number>(ULID_ENTROPY_BYTES).fill(n))
const ENTRY = id(99)

const input = (text: string, stars: 1 | 2 | 3 | 4 = 1): NoteInput => ({ kind: 'word', text, lang: 'en', stars })
const put = (n: number, text: string, stars: 1 | 2 | 3 | 4 = 1): NoteOp => ({ type: 'put', id: id(n), input: input(text, stars) })
const del = (n: number): NoteOp => ({ type: 'delete', id: id(n) })

const offline = (): ApiError => new ApiError({ kind: 'network', code: 'NETWORK', message: 'offline' })
const http = (status: number, code: string): ApiError => new ApiError({ kind: 'http', status, code, message: code })

test('toNoteInput cleans the target as the server would, or refuses it', () => {
  assert.deepEqual(toNoteInput({ kind: 'phrase', text: '  focus\n on ', translation: ' 聚焦于 ', entryId: ENTRY, lemma: 'focus on' }, 1), {
    kind: 'phrase',
    text: 'focus on',
    lang: 'en',
    stars: 1,
    translation: '聚焦于',
    entryId: ENTRY,
    lemma: 'focus on',
  })
  assert.deepEqual(toNoteInput({ kind: 'word', text: 'don’t', translation: null, entryId: 'not-a-ulid' }, 2), {
    kind: 'word',
    text: "don't",
    lang: 'en',
    stars: 2,
  })
  assert.deepEqual(
    toNoteInput({ kind: 'sentence', text: ' Keep  it.\n', translation: '', lemma: 'ignored' }, 4),
    { kind: 'sentence', text: 'Keep  it.', lang: 'en', stars: 4 },
    'sentences keep their spacing and take no lemma',
  )
  assert.equal(toNoteInput({ kind: 'word', text: '  ' }, 1), null)
  assert.equal(toNoteInput({ kind: 'word', text: '截止日期' }, 1), null, 'a word needs a Latin letter')
  assert.equal(toNoteInput({ kind: 'phrase', text: 'a'.repeat(65) }, 1), null)
  assert.equal(toNoteInput({ kind: 'sentence', text: 'x'.repeat(2001) }, 1), null)
  assert.equal(toNoteInput({ kind: 'sentence', text: 'ok', translation: '字'.repeat(2001) }, 1), null)
  assert.equal(toNoteInput({ kind: 'word', text: 'ok', lemma: 'l'.repeat(61) }, 1)?.lemma, undefined)
})

test('noteKey: kind + folded text; sentences keep their case', () => {
  assert.equal(noteKey({ kind: 'word', text: ' Decision ' }), 'word:decision')
  assert.equal(noteKey({ kind: 'phrase', text: 'Focus  ON' }), 'phrase:focus on')
  assert.equal(noteKey({ kind: 'sentence', text: 'I Agree.' }), 'sentence:I Agree.')
})

test('the queue keeps one operation per note, the latest, and is bounded', () => {
  let queue = enqueueNoteOp([], put(1, 'a'))
  queue = enqueueNoteOp(queue, put(2, 'b'))
  queue = enqueueNoteOp(queue, put(1, 'a', 3))
  assert.deepEqual(queue, [put(2, 'b'), put(1, 'a', 3)])
  queue = enqueueNoteOp(queue, del(2))
  assert.deepEqual(queue, [put(1, 'a', 3), del(2)])
  const full = Array.from({ length: MAX_PENDING_NOTES + 5 }, (_, i) => put(i, `w${i}`)).reduce<NoteOp[]>(
    (acc, op) => enqueueNoteOp(acc, op),
    [],
  )
  assert.equal(full.length, MAX_PENDING_NOTES)
  assert.equal(full[0]?.id, id(5), 'the oldest go first')
})

test('readNoteQueue drops what it cannot read and keeps the last operation per note', () => {
  const stored: unknown = [
    put(1, 'a'),
    { type: 'put', id: 'bad', input: input('x') },
    { type: 'put', id: id(2), input: { kind: 'word', text: 'x', lang: 'fr', stars: 1 } },
    { type: 'put', id: id(3), input: { ...input('x'), stars: 5 } },
    { type: 'move', id: id(4) },
    del(1),
    null,
    put(5, 'e'),
  ]
  assert.deepEqual(readNoteQueue(stored), [del(1), put(5, 'e')])
  assert.deepEqual(readNoteQueue('nope'), [])
})

test('noteFailureAction: drop only what can never succeed; a DELETE of nothing is done', () => {
  assert.equal(noteFailureAction(put(1, 'a'), { kind: 'network' }), 'keep')
  assert.equal(noteFailureAction(put(1, 'a'), { kind: 'timeout' }), 'keep')
  assert.equal(noteFailureAction(put(1, 'a'), { kind: 'http', status: 429, code: 'RATE_LIMITED' }), 'keep')
  assert.equal(noteFailureAction(put(1, 'a'), { kind: 'http', status: 503 }), 'keep')
  assert.equal(noteFailureAction(put(1, 'a'), { kind: 'http', status: 404, code: 'NOT_FOUND' }), 'keep')
  assert.equal(noteFailureAction(put(1, 'a'), { kind: 'http', status: 400, code: 'VALIDATION_FAILED' }), 'drop')
  assert.equal(noteFailureAction(put(1, 'a'), { kind: 'http', status: 409, code: 'NOTE_CONFLICT' }), 'drop')
  assert.equal(noteFailureAction(del(1), { kind: 'http', status: 404, code: 'NOT_FOUND' }), 'drop')
  assert.equal(noteFailureAction(del(1), { kind: 'network' }), 'keep')
})

/** A server double keyed by note id; can be switched offline or made to hold a request. */
class FakeServer {
  readonly notes = new Map<string, NoteInput & { deleted: boolean }>()
  readonly calls: string[] = []
  online = true
  hold: Promise<void> | null = null
  putError: ApiError | null = null

  async put(noteId: string, body: NoteInput): Promise<unknown> {
    this.calls.push(`PUT ${noteId.slice(-2)} ${body.stars}`)
    if (this.hold !== null) await this.hold
    if (!this.online) throw offline()
    if (this.putError !== null) throw this.putError
    this.notes.set(noteId, { ...body, deleted: false })
    return { id: noteId }
  }

  async remove(noteId: string): Promise<unknown> {
    this.calls.push(`DELETE ${noteId.slice(-2)}`)
    if (!this.online) throw offline()
    const note = this.notes.get(noteId)
    if (note === undefined) throw http(404, 'NOT_FOUND')
    this.notes.set(noteId, { ...note, deleted: true })
    return { id: noteId }
  }
}

const setup = (server: FakeServer) => {
  let stored: unknown = null
  const warnings: string[] = []
  const outbox = createNoteOutbox({
    load: () => stored,
    save: (ops) => {
      stored = ops.length === 0 ? null : JSON.parse(JSON.stringify(ops))
    },
    put: (noteId, body) => server.put(noteId, body),
    remove: (noteId) => server.remove(noteId),
    warn: (message) => warnings.push(message),
  })
  return { outbox, storage: () => stored, warnings }
}

test('a change is stored, sent at once and removed when answered', async () => {
  const server = new FakeServer()
  const { outbox, storage } = setup(server)
  outbox.record(put(1, 'concise'))
  await outbox.flush()
  assert.equal(server.notes.get(id(1))?.text, 'concise')
  assert.equal(storage(), null)
})

test('offline: changes stay queued, collapse per note, and go out on the next flush', async () => {
  const server = new FakeServer()
  server.online = false
  const { outbox } = setup(server)
  outbox.record(put(1, 'concise'))
  outbox.record(put(1, 'concise', 3))
  outbox.record(put(2, 'focus'))
  outbox.record(del(2))
  // Recording during a drain schedules one more; let them all fail offline.
  await outbox.flush()
  await new Promise((resolve) => setImmediate(resolve))
  await outbox.flush()
  assert.deepEqual(outbox.pending(), [put(1, 'concise', 3), del(2)])

  server.online = true
  server.calls.length = 0
  await outbox.flush()
  assert.deepEqual(server.calls, [`PUT ${id(1).slice(-2)} 3`, `DELETE ${id(2).slice(-2)}`])
  assert.equal(server.notes.get(id(1))?.stars, 3)
  assert.deepEqual(outbox.pending(), [], 'deleting a note the server never had is done')
})

test('a change made while its note is being sent is sent after it, not lost', async () => {
  const server = new FakeServer()
  let release: () => void = () => undefined
  server.hold = new Promise((resolve) => {
    release = resolve
  })
  const { outbox } = setup(server)
  outbox.record(put(1, 'concise'))
  outbox.record(put(1, 'concise', 4))
  server.hold = null
  release()
  await outbox.flush()
  await outbox.flush()
  assert.equal(server.notes.get(id(1))?.stars, 4)
  assert.deepEqual(outbox.pending(), [])
})

test('a refused change is dropped with a warning; the rest still go', async () => {
  const server = new FakeServer()
  server.putError = http(409, 'NOTE_CONFLICT')
  const { outbox, warnings } = setup(server)
  outbox.record(put(1, 'concise'))
  await outbox.flush()
  assert.deepEqual(outbox.pending(), [])
  assert.equal(warnings.length, 1)
  server.putError = null
  outbox.record(put(2, 'focus'))
  await outbox.flush()
  assert.equal(server.notes.has(id(2)), true)
})

test('a storage that loses writes does not make the outbox send forever', async () => {
  const server = new FakeServer()
  const outbox = createNoteOutbox({
    load: () => [put(1, 'concise')],
    save: () => undefined,
    put: (noteId, body) => server.put(noteId, body),
    remove: (noteId) => server.remove(noteId),
  })
  await outbox.flush()
  assert.equal(server.calls.length, 1)
})
