/**
 * The notes saved from the 翻译 page, by kind and text (lib/note-outbox.ts
 * `noteKey`): their ids and stars, so a bookmark shows its state again when
 * the same word comes back, and saving after 取消收藏 revives the same note.
 * Page-local; the changes themselves go through services/notes.ts.
 */
import { noteKey, type NoteTarget } from '../../lib/note-outbox'
import type { LookupResult, NoteStars } from '../../lib/types'
import { lookupGloss } from '../../lib/lookup-view'
import { canSaveNote, newNoteId, removeNote, saveNote, setNoteStars } from '../../services/notes'
import { toast } from '../../services/ui'

interface SavedNote {
  readonly id: string
  /** 0 after 取消收藏: the id is kept. */
  readonly stars: number
}

export interface SavedNotes {
  /** 0 when not saved. */
  starsOf(target: NoteTarget): number
  /** Bookmark tap: saves at one star, or removes the saved note. Returns the new stars. */
  toggle(target: NoteTarget): number
  /** A star tap on a saved note; returns the stars it now has (0 when not saved). */
  setStars(target: NoteTarget, level: unknown): number
}

const isStars = (value: number): value is NoteStars => value === 1 || value === 2 || value === 3 || value === 4

export function createSavedNotes(): SavedNotes {
  let notes: ReadonlyMap<string, SavedNote> = new Map()
  const remember = (target: NoteTarget, note: SavedNote): void => {
    notes = new Map(notes).set(noteKey(target), note)
  }
  return {
    starsOf: (target) => notes.get(noteKey(target))?.stars ?? 0,
    toggle(target) {
      const known = notes.get(noteKey(target))
      if (known !== undefined && known.stars > 0) {
        removeNote(known.id)
        remember(target, { id: known.id, stars: 0 })
        return 0
      }
      const id = saveNote(target, 1, known?.id ?? newNoteId())
      if (id === null) {
        toast('无法收藏')
        return 0
      }
      remember(target, { id, stars: 1 })
      return 1
    },
    setStars(target, level) {
      const known = notes.get(noteKey(target))
      if (known === undefined || known.stars === 0) return 0
      const stars = Number(level)
      if (!isStars(stars)) return known.stars
      setNoteStars(known.id, target, stars)
      remember(target, { id: known.id, stars })
      return stars
    },
  }
}

export interface SheetTargets {
  /** The looked-up word, or phrase when the lemma has several words. */
  readonly head: NoteTarget | null
  /** The phrase the word sits in (在本句中). */
  readonly phrase: NoteTarget | null
}

/** The sheet's two notes for a lookup; null where the server would refuse the note. */
export function sheetTargets(lookup: LookupResult | null, entryId: string | null): SheetTargets {
  if (lookup === null) return { head: null, phrase: null }
  const head: NoteTarget = {
    kind: /\s/.test(lookup.lemma.trim()) ? 'phrase' : 'word',
    text: lookup.lemma,
    lemma: lookup.lemma,
    translation: lookupGloss(lookup),
    entryId,
  }
  const context = lookup.context?.phrase ?? null
  const phrase: NoteTarget | null =
    context === null ? null : { kind: 'phrase', text: context.text, translation: context.gloss, entryId }
  return {
    head: canSaveNote(head) ? head : null,
    phrase: phrase !== null && canSaveNote(phrase) ? phrase : null,
  }
}
