/**
 * The account's notes (笔记本) indexed by kind and text, kept for the app
 * session and folded from `GET /v1/notes/changes`. The word page and the 翻译
 * page read it to show a bookmark's state and to reuse a note's id, so saving
 * the same word, phrase or sentence twice never creates a second note, and
 * saving after 取消收藏 revives the old one.
 */
import { findSaved, indexNotes, withSaved, type SavedIndex, type SavedNote } from '../lib/notebook'
import type { Note, NoteKind } from '../lib/types'
import { fetchNoteChanges } from './endpoints'

const CHANGES_PAGE_LIMIT = 500
/** Safety stop for the first sync (500 notes a page). */
const MAX_CHANGE_PAGES = 40

let index: SavedIndex = {}
let cursor = 0
let running: Promise<SavedIndex> | null = null

/** Folds the changes since the last sync into the index (single-flight); rejects when offline. */
export function syncSavedNotes(): Promise<SavedIndex> {
  running ??= (async () => {
    try {
      for (let pages = 0; pages < MAX_CHANGE_PAGES; pages += 1) {
        const changes = await fetchNoteChanges(cursor, CHANGES_PAGE_LIMIT)
        index = indexNotes(index, changes.notes)
        cursor = Math.max(cursor, changes.nextAfter)
        if (!changes.hasMore) break
      }
      return index
    } finally {
      running = null
    }
  })()
  return running
}

/** The index as last synced, with this session's own saves. */
export function savedIndex(): SavedIndex {
  return index
}

/** The note saved for `kind` / `text` (a word by its lemma), deleted ones included; null when none. */
export function savedNoteFor(kind: NoteKind, text: string): SavedNote | null {
  return findSaved(index, kind, text)
}

/** A note the server just returned. */
export function rememberNote(note: Note): void {
  index = indexNotes(index, [note])
}

/** A save or removal made on this device before the server answered. */
export function rememberSaved(saved: SavedNote): void {
  index = withSaved(index, saved)
}
