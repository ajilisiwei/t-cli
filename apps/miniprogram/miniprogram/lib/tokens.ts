/**
 * 点词查词: the English side of a result split into tappable words, and the
 * selection taps make.
 *
 * A word is a run of Latin letters with apostrophes and hyphens inside it
 * ("don't", "well-known"); everything else (spaces, punctuation, digits,
 * other scripts) is text between words. The text is laid out as chips — runs
 * without whitespace, so "decisions." keeps its full stop on the same line —
 * each made of parts that are a word or not.
 *
 * Tapping a word selects it; tapping a word next to the selection extends it
 * to a phrase ("focus" then "on" → "focus on"), unless a sentence end or a
 * line break lies between them. Pure: no `wx`, no value imports.
 */

/** A word and where it sits in the text (UTF-16 offsets, end exclusive). */
export interface WordSpan {
  readonly text: string
  readonly start: number
  readonly end: number
}

/** One piece of a chip: `word` is the index into `words`, -1 for other text. */
export interface TokenPart {
  readonly text: string
  readonly word: number
}

/** A run of text without whitespace; `breaks` = line breaks in the whitespace after it. */
export interface TokenChip {
  readonly parts: readonly TokenPart[]
  readonly breaks: number
}

/** Where word i is drawn: `chips[chip].parts[part]`. */
export interface WordLocation {
  readonly chip: number
  readonly part: number
}

export interface LookupText {
  readonly chips: readonly TokenChip[]
  readonly words: readonly WordSpan[]
  readonly locations: readonly WordLocation[]
}

/** Inclusive word indices. */
export interface Selection {
  readonly start: number
  readonly end: number
}

/** `POST /v1/lookup` takes at most 64 code points. */
export const MAX_PHRASE_CODE_POINTS = 64
export const MAX_PHRASE_WORDS = 6
/** The `sentence` of `POST /v1/lookup`. */
export const MAX_LOOKUP_SENTENCE = 2000

const WORD_RE = /\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:['’‐-]\p{Script=Latin}[\p{Script=Latin}\p{M}]*)*/gu
const RUN_RE = /\S+|\s+/g
/** A sentence end: . ! ? … (and closing quotes) before whitespace, CJK stops, or a line break. */
const SENTENCE_END_RE = /[.!?…]+["'”’)\]]*(?=\s)|[。！？；]|\n/g
/** Text between two words that stops a selection from growing across it. */
const PHRASE_STOP_RE = /[.!?…;:。！？；：\n]/

interface Match {
  readonly index: number
  readonly text: string
}

/** Every non-empty match of a global pattern (an `exec` loop: `matchAll` is missing on older engines). */
const matches = (pattern: RegExp, text: string): Match[] => {
  const found: Match[] = []
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0] === '') {
      pattern.lastIndex += 1
      continue
    }
    found.push({ index: match.index, text: match[0] })
  }
  return found
}

const codePoints = (text: string): number => {
  let count = 0
  for (const _ of text) count += 1
  return count
}

const splitChip = (chip: string, offset: number, words: WordSpan[]): TokenPart[] => {
  const parts: TokenPart[] = []
  let last = 0
  for (const match of matches(WORD_RE, chip)) {
    const index = match.index
    if (index > last) parts.push({ text: chip.slice(last, index), word: -1 })
    parts.push({ text: match.text, word: words.length })
    words.push({ text: match.text, start: offset + index, end: offset + index + match.text.length })
    last = index + match.text.length
  }
  if (last < chip.length) parts.push({ text: chip.slice(last), word: -1 })
  return parts
}

/** Splits `text` into chips of words and other text. */
export function splitForLookup(text: string): LookupText {
  const chips: { parts: TokenPart[]; breaks: number }[] = []
  const words: WordSpan[] = []
  for (const match of matches(RUN_RE, text)) {
    const run = match.text
    if (/^\s/.test(run)) {
      const previous = chips[chips.length - 1]
      if (previous !== undefined) previous.breaks = (run.match(/\n/g) ?? []).length
      continue
    }
    chips.push({ parts: splitChip(run, match.index, words), breaks: 0 })
  }
  const locations: WordLocation[] = []
  chips.forEach((chip, c) =>
    chip.parts.forEach((part, p) => {
      if (part.word >= 0) locations[part.word] = { chip: c, part: p }
    }),
  )
  return { chips, words, locations }
}

/** The text a selection covers, as written (inner whitespace collapsed). */
export function selectionText(text: string, words: readonly WordSpan[], selection: Selection): string {
  const first = words[selection.start]
  const last = words[selection.end]
  if (first === undefined || last === undefined || selection.end < selection.start) return ''
  return text.slice(first.start, last.end).replace(/\s+/g, ' ').trim()
}

/**
 * The selection after tapping word `index`:
 *  - nothing selected, or a word away from the selection → that word alone;
 *  - the only selected word again → nothing (the sheet closes);
 *  - a word inside a phrase → that word alone;
 *  - the word just before or after the selection → the phrase grows to it,
 *    unless a sentence end or line break separates them or the phrase would
 *    pass {@link MAX_PHRASE_WORDS} words or {@link MAX_PHRASE_CODE_POINTS}.
 */
export function selectWord(
  current: Selection | null,
  index: number,
  text: string,
  words: readonly WordSpan[],
): Selection | null {
  if (index < 0 || index >= words.length) return current
  const alone: Selection = { start: index, end: index }
  if (current === null) return alone
  if (index >= current.start && index <= current.end) {
    return current.start === current.end ? null : alone
  }
  const grown: Selection | null =
    index === current.start - 1
      ? { start: index, end: current.end }
      : index === current.end + 1
        ? { start: current.start, end: index }
        : null
  if (grown === null) return alone
  const left = words[index === grown.start ? index : index - 1]
  const right = words[index === grown.start ? index + 1 : index]
  const gap = left !== undefined && right !== undefined ? text.slice(left.end, right.start) : '\n'
  if (PHRASE_STOP_RE.test(gap)) return alone
  if (grown.end - grown.start + 1 > MAX_PHRASE_WORDS) return alone
  if (codePoints(selectionText(text, words, grown)) > MAX_PHRASE_CODE_POINTS) return alone
  return grown
}

/** Whether word `index` is inside the selection. */
export function isSelected(selection: Selection | null, index: number): boolean {
  return selection !== null && index >= selection.start && index <= selection.end
}

/**
 * At most `max` code points of `text`, keeping [focusStart, focusEnd)
 * (UTF-16 offsets) in view and as central as the text allows.
 */
export function clipAround(text: string, focusStart: number, focusEnd: number, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  const from = Array.from(text.slice(0, Math.max(0, focusStart))).length
  const to = Math.max(from, Array.from(text.slice(0, Math.max(0, focusEnd))).length)
  const span = to - from
  if (span >= max) return chars.slice(from, from + max).join('').trim()
  const start = Math.min(Math.max(0, from - Math.floor((max - span) / 2)), chars.length - max)
  return chars.slice(start, start + max).join('').trim()
}

/**
 * The sentence the selection sits in (sentence ends: . ! ? … before
 * whitespace, 。！？；, line breaks), at most `max` code points around the
 * selection. '' for an empty selection.
 */
export function sentenceAround(
  text: string,
  words: readonly WordSpan[],
  selection: Selection,
  max: number = MAX_LOOKUP_SENTENCE,
): string {
  const first = words[selection.start]
  const last = words[selection.end]
  if (first === undefined || last === undefined) return ''
  let start = 0
  let end = text.length
  for (const match of matches(SENTENCE_END_RE, text)) {
    const boundary = match.index + match.text.length
    if (boundary <= first.start) start = boundary
    else if (match.index >= last.end) {
      end = boundary
      break
    }
  }
  const raw = text.slice(start, end)
  const lead = raw.length - raw.trimStart().length
  const sentence = raw.trim()
  return clipAround(sentence, first.start - start - lead, last.end - start - lead, max)
}
