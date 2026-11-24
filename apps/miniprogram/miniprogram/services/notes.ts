/**
 * 收藏 (notes, docs/api-v1.md "Notes"): save a word, phrase or sentence with
 * an importance of 1–4 stars, change the stars, remove it.
 *
 * Every change goes through the outbox (lib/note-outbox.ts): stored first,
 * sent at once, and sent again on the next change or `flushNotes()` when it
 * failed (offline, server busy). Note ids are client ULIDs minted here, so a
 * change sent twice never makes a second note; a page keeps a note's id to
 * change its stars or remove it, and to save it again (a `PUT` revives it).
 */
import {
  createNoteOutbox,
  toNoteInput,
  type NoteOp,
  type NoteTarget,
} from '../lib/note-outbox'
import { ULID_ENTROPY_BYTES, ulid } from '../lib/review-ulid'
import type { NoteStars } from '../lib/types'
import { deleteNote, saveNote as putNote } from './endpoints'

export type { NoteTarget }

/** Queued note changes; spelled out here because this module alone reads it. */
const PENDING_KEY = 'tcli:notes:pending'

const outbox = createNoteOutbox({
  load: () => {
    try {
      return wx.getStorageSync(PENDING_KEY)
    } catch {
      return null
    }
  },
  save: (ops) => {
    try {
      if (ops.length === 0) wx.removeStorageSync(PENDING_KEY)
      else wx.setStorageSync(PENDING_KEY, ops)
    } catch (error: unknown) {
      console.warn('[notes] could not store queued changes', error)
    }
  },
  put: (id, input) => putNote(id, input),
  remove: (id) => deleteNote(id),
  warn: (message, detail) => console.warn(`[notes] ${message}`, detail),
})

/**
 * A ULID for a new note. `Math.random` entropy: the id is an idempotency key
 * unique per account, not a secret (as review log ids).
 */
export function newNoteId(now: number = Date.now()): string {
  const bytes = Array.from({ length: ULID_ENTROPY_BYTES }, () => Math.floor(Math.random() * 256))
  return ulid(now, bytes)
}

/** Whether the server would accept `target` as a note (see `toNoteInput`). */
export function canSaveNote(target: NoteTarget): boolean {
  return toNoteInput(target, 1) !== null
}

/**
 * Saves `target` at `stars` (default 1) under `id` (a new one by default)
 * and returns the id; null when the target cannot be a note.
 */
export function saveNote(target: NoteTarget, stars: NoteStars = 1, id: string = newNoteId()): string | null {
  const input = toNoteInput(target, stars)
  if (input === null) return null
  outbox.record({ type: 'put', id, input })
  return id
}

/** Changes a saved note's stars (the same `PUT`, so kind and text must be the saved ones). */
export function setNoteStars(id: string, target: NoteTarget, stars: NoteStars): void {
  const input = toNoteInput(target, stars)
  if (input !== null) outbox.record({ type: 'put', id, input })
}

/** 取消收藏. */
export function removeNote(id: string): void {
  outbox.record({ type: 'delete', id })
}

/** Sends queued changes (single-flight). Resolves when the queue is empty or offline; never rejects. */
export function flushNotes(): Promise<void> {
  return outbox.flush()
}

/** Changes not yet confirmed by the server, oldest first. */
export function pendingNoteChanges(): NoteOp[] {
  return outbox.pending()
}
