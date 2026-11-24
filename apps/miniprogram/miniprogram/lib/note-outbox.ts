/**
 * The outbox of note changes (收藏, 星级, 取消收藏), modelled on the review
 * outbox (lib/review-queue.ts). Every change is written to storage first and
 * sent at once; a failed request leaves it queued until the next flush (next
 * change, the page showing again). Note ids are client ULIDs and
 * `PUT /v1/notes/:id` is idempotent, so sending a change twice never makes a
 * second note.
 *
 * The queue keeps one operation per note: a newer change of the same note
 * replaces the queued one (stars 1 → 3 sends one PUT; save then remove sends
 * one DELETE). An operation answered while a newer one replaced it stays
 * queued for that newer one.
 *
 * Pure: no `wx`, no value imports.
 */
import type { NoteInput, NoteKind, NoteStars } from './types'

export type NoteOp =
  | { readonly type: 'put'; readonly id: string; readonly input: NoteInput }
  | { readonly type: 'delete'; readonly id: string }

/** What a page saves; `lang` and `stars` are added by {@link toNoteInput}. */
export interface NoteTarget {
  readonly kind: NoteKind
  readonly text: string
  readonly translation?: string | null
  readonly entryId?: string | null
  readonly lemma?: string | null
}

/** Storage bound: a note change is a few hundred bytes at most (2 000 for a long sentence). */
export const MAX_PENDING_NOTES = 300

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/
const NOTE_KINDS: readonly NoteKind[] = ['word', 'phrase', 'sentence']
const LATIN_RE = /\p{Script=Latin}/u
/** Limits of `PUT /v1/notes/:id` in code points (docs/api-v1.md, "Notes"). */
const MAX_WORD = 64
const MAX_SENTENCE = 2000
const MAX_TRANSLATION = 2000
const MAX_LEMMA = 60

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const codePoints = (text: string): number => {
  let count = 0
  for (const _ of text) count += 1
  return count
}

const isKind = (value: unknown): value is NoteKind =>
  typeof value === 'string' && (NOTE_KINDS as readonly string[]).includes(value)

const isStars = (value: unknown): value is NoteStars => value === 1 || value === 2 || value === 3 || value === 4

const optional = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim() : '')

/**
 * The `PUT` body for a target, cleaned as the server would (trimmed; word and
 * phrase whitespace collapsed, curly quotes straightened), or null when the
 * server would refuse it: empty or too long text, a word without a Latin
 * letter, a translation over 2 000 characters. An over-long lemma is left out.
 */
export function toNoteInput(target: NoteTarget, stars: NoteStars): NoteInput | null {
  const short = target.kind !== 'sentence'
  const text = short ? target.text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim() : target.text.trim()
  if (text === '' || codePoints(text) > (short ? MAX_WORD : MAX_SENTENCE)) return null
  if (short && !LATIN_RE.test(text)) return null
  const translation = optional(target.translation)
  if (codePoints(translation) > MAX_TRANSLATION) return null
  const entryId = optional(target.entryId)
  const lemma = short ? optional(target.lemma) : ''
  return {
    kind: target.kind,
    text,
    lang: 'en',
    stars,
    ...(translation === '' ? {} : { translation }),
    ...(ULID_RE.test(entryId) ? { entryId } : {}),
    ...(lemma !== '' && codePoints(lemma) <= MAX_LEMMA ? { lemma } : {}),
  }
}

/** Identifies a saved word, phrase or sentence on a page: kind + folded text. */
export function noteKey(target: Pick<NoteTarget, 'kind' | 'text'>): string {
  const text = target.text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
  return `${target.kind}:${target.kind === 'sentence' ? text : text.toLowerCase()}`
}

const readInput = (value: unknown): NoteInput | null => {
  if (!isRecord(value)) return null
  const { kind, text, lang, stars, translation, entryId, lemma } = value
  if (!isKind(kind) || typeof text !== 'string' || text === '' || lang !== 'en' || !isStars(stars)) return null
  return {
    kind,
    text,
    lang,
    stars,
    ...(typeof translation === 'string' && translation !== '' ? { translation } : {}),
    ...(typeof entryId === 'string' && ULID_RE.test(entryId) ? { entryId } : {}),
    ...(typeof lemma === 'string' && lemma !== '' ? { lemma } : {}),
  }
}

/** One stored operation, or null when unreadable. */
export function readNoteOp(value: unknown): NoteOp | null {
  if (!isRecord(value)) return null
  const { type, id } = value
  if (typeof id !== 'string' || !ULID_RE.test(id)) return null
  if (type === 'delete') return { type, id }
  if (type !== 'put') return null
  const input = readInput(value['input'])
  return input === null ? null : { type, id, input }
}

/** The stored queue; unreadable entries are dropped and only the last operation per note is kept. */
export function readNoteQueue(value: unknown): NoteOp[] {
  if (!Array.isArray(value)) return []
  return value.reduce<NoteOp[]>((queue, entry) => {
    const op = readNoteOp(entry)
    return op === null ? queue : [...queue.filter((queued) => queued.id !== op.id), op]
  }, [])
}

/** Queues `op` behind the others, replacing a queued operation of the same note. Past `max`, the oldest go. */
export function enqueueNoteOp(queue: readonly NoteOp[], op: NoteOp, max: number = MAX_PENDING_NOTES): NoteOp[] {
  const merged = [...queue.filter((queued) => queued.id !== op.id), op]
  return merged.length > max ? merged.slice(merged.length - max) : merged
}

const sameOp = (a: NoteOp, b: NoteOp): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * What a failed request means for its operation: `drop` when sending it
 * again cannot succeed (400, 409 NOTE_CONFLICT, 413, 422) and, for a DELETE,
 * a 404 (nothing to delete: done); `keep` for everything else — offline,
 * timeouts, rate limits, server errors, a lost login.
 */
export function noteFailureAction(
  op: NoteOp,
  error: { readonly kind?: string; readonly status?: number | null; readonly code?: string },
): 'keep' | 'drop' {
  const status = error.status ?? null
  if (op.type === 'delete' && (error.code === 'NOT_FOUND' || status === 404)) return 'drop'
  return error.kind === 'http' && status !== null && [400, 409, 413, 422].includes(status) ? 'drop' : 'keep'
}

const errorFields = (error: unknown): { kind?: string; status?: number | null; code?: string } => {
  if (!isRecord(error)) return {}
  const { kind, status, code } = error
  return {
    ...(typeof kind === 'string' ? { kind } : {}),
    ...(typeof status === 'number' || status === null ? { status } : {}),
    ...(typeof code === 'string' ? { code } : {}),
  }
}

export interface NoteOutboxDeps {
  /** Reads the stored queue (validated here) and writes it back. */
  readonly load: () => unknown
  readonly save: (ops: readonly NoteOp[]) => void
  /** `PUT /v1/notes/:id`. */
  readonly put: (id: string, input: NoteInput) => Promise<unknown>
  /** `DELETE /v1/notes/:id`. */
  readonly remove: (id: string) => Promise<unknown>
  readonly warn?: (message: string, detail?: unknown) => void
}

export interface NoteOutbox {
  /** Queues a change and starts sending it. */
  record(op: NoteOp): void
  /** Sends queued changes, single-flight, oldest first. Resolves when the queue is empty or a request failed; never rejects. */
  flush(): Promise<void>
  pending(): NoteOp[]
}

export function createNoteOutbox(deps: NoteOutboxDeps): NoteOutbox {
  const warn = deps.warn ?? ((): void => undefined)
  const pending = (): NoteOp[] => readNoteQueue(deps.load())
  let flushing: Promise<void> | null = null

  /** Removes `op` once settled, unless a newer change of the note replaced it meanwhile. */
  const settle = (op: NoteOp): void => {
    const queue = pending()
    if (queue.some((queued) => sameOp(queued, op))) deps.save(queue.filter((queued) => !sameOp(queued, op)))
  }

  const drain = async (): Promise<void> => {
    // Guards against a storage that does not keep writes: never send the same change twice in one drain.
    const sent = new Set<string>()
    for (;;) {
      const op = pending()[0]
      if (op === undefined) return
      const key = JSON.stringify(op)
      if (sent.has(key)) return
      sent.add(key)
      try {
        if (op.type === 'put') await deps.put(op.id, op.input)
        else await deps.remove(op.id)
        settle(op)
      } catch (error: unknown) {
        const fields = errorFields(error)
        if (noteFailureAction(op, fields) === 'keep') return
        if (!(op.type === 'delete' && (fields.code === 'NOT_FOUND' || fields.status === 404))) {
          warn('dropping a note change the server refuses', fields.code)
        }
        settle(op)
      }
    }
  }

  const flush = (): Promise<void> => {
    flushing ??= drain().finally(() => {
      flushing = null
    })
    return flushing
  }

  return {
    record(op) {
      deps.save(enqueueNoteOp(pending(), op))
      // A drain already running picks the change up after its current request;
      // one that is just finishing may not, so drain once more after it.
      const running = flushing
      void flush()
      if (running !== null) void running.then(flush)
    },
    flush,
    pending,
  }
}
