/**
 * The 点词查词 bottom sheet: what it shows for a `POST /v1/lookup` result,
 * where 完整释义 leads, and how far the page scrolls so the sheet does not
 * hide the tapped word. Pure: no `wx`, no value imports.
 */
import type { LookupResult } from './types'

/** The sheet takes at most this share of the window height. */
export const SHEET_MAX_SHARE = 0.6
/** The word page receives at most this many code points of the sentence. */
export const WORD_PAGE_SENTENCE_MAX = 300

export interface SheetSense {
  readonly pos: string
  readonly gloss: string
}

export interface SheetPhrase {
  readonly text: string
  readonly gloss: string
}

export interface SheetView {
  /** The lemma ("decision"). */
  readonly headword: string
  /** US IPA as the lexicon writes it ("/dɪˈsɪʒən/"), or ''. */
  readonly ipa: string
  /** The tapped text when it differs from the lemma ("decisions"), else ''. */
  readonly asWritten: string
  /** 在本句中; '' without a sentence. */
  readonly meaning: string
  readonly phrase: SheetPhrase | null
  readonly senses: readonly SheetSense[]
}

const fold = (text: string): string => text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()

export function sheetView(result: LookupResult, tapped: string): SheetView {
  const { entry, context } = result
  const headword = result.lemma !== '' ? result.lemma : entry.lemma
  return {
    headword,
    ipa: entry.ipa.us,
    asWritten: fold(tapped) !== fold(headword) ? tapped.trim() : '',
    meaning: context?.meaning ?? '',
    phrase: context?.phrase ?? null,
    senses: entry.senses.map((sense) => ({ pos: sense.pos, gloss: sense.gloss })),
  }
}

/** The translation a word note carries: the first sense's gloss. */
export function lookupGloss(result: LookupResult): string {
  return result.entry.senses[0]?.gloss.trim() ?? ''
}

/**
 * 完整释义: `/pages/word/index?lemma=…&sentence=…&entryId=…`. Every key is
 * present (empty when unknown); `sentence` is cut to
 * {@link WORD_PAGE_SENTENCE_MAX} code points.
 */
export function wordPageUrl(lemma: string, sentence: string, entryId: string | null): string {
  const clipped = Array.from(sentence.trim()).slice(0, WORD_PAGE_SENTENCE_MAX).join('')
  return (
    `/pages/word/index?lemma=${encodeURIComponent(lemma.trim())}` +
    `&sentence=${encodeURIComponent(clipped)}` +
    `&entryId=${encodeURIComponent(entryId ?? '')}`
  )
}

export interface RevealInput {
  /** The tapped word's box, in window coordinates (px). */
  readonly top: number
  readonly bottom: number
  /** The top of the scrolling area and the top of the sheet, in window coordinates. */
  readonly viewTop: number
  readonly visibleBottom: number
  /** The scrolling area's current offset. */
  readonly scrollTop: number
  /** Space kept between the word and the sheet. */
  readonly margin: number
}

/**
 * The scroll offset that brings the tapped word into the part of the page
 * the sheet leaves visible, or null when it already is.
 */
export function revealScrollTop(input: RevealInput): number | null {
  const { top, bottom, viewTop, visibleBottom, scrollTop, margin } = input
  if (bottom + margin > visibleBottom) {
    return Math.max(0, Math.round(scrollTop + bottom + margin - visibleBottom))
  }
  if (top - margin < viewTop) {
    return Math.max(0, Math.round(scrollTop - (viewTop - (top - margin))))
  }
  return null
}

/** Whether an error from `POST /v1/lookup` means lookups are switched off (503 LOOKUP_DISABLED). */
export function isLookupDisabled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'LOOKUP_DISABLED'
}
