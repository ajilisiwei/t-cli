/**
 * How a review card is drawn. Every card type has the same CardFace shape
 * (docs/api-v1.md), so one renderer serves them all; the type only picks the
 * label, the prompt and what to mark on the back:
 *
 *   recognize  headword + IPA        → meanings + example
 *   produce    meanings              → headword + IPA
 *   cloze      sentence with "____"  → full sentence, the answer marked
 *   fix        wrong sentence        → right sentence, the changed words marked
 */
import type { DiffSegment } from './word-diff'
import type { CardFace, QueueCard } from './review-types'

export interface Segment {
  readonly text: string
  /** Shown in the accent colour: a blank, the cloze answer or a fixed word. */
  readonly mark: boolean
}

export interface FaceView {
  readonly segments: readonly Segment[]
  /** English in the serif face; Chinese in the system font. */
  readonly serif: boolean
  /** A single word or short phrase: set large like a dictionary headword. */
  readonly headword: boolean
  readonly ipa: string
  readonly sub: string
  readonly subSerif: boolean
  readonly exampleEn: string
  readonly exampleZh: string
}

export interface CardView {
  readonly label: string
  readonly prompt: string
  readonly front: FaceView
  readonly back: FaceView
}

/** Word-level diff, injected (lib/word-diff.ts `diffWords`). */
export type DiffWords = (before: string, after: string) => readonly DiffSegment[]

const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿가-힯]/
const BLANK_RE = /_{2,}/
const HEADWORD_MAX_CHARS = 28
const HEADWORD_MAX_WORDS = 3

export function containsCjk(text: string): boolean {
  return CJK_RE.test(text)
}

const LABELS: Readonly<Record<string, { label: string; prompt: string }>> = {
  recognize: { label: '认词', prompt: '认识这个词吗？' },
  produce: { label: '回想', prompt: '用英文怎么说？' },
  cloze: { label: '完形', prompt: '空格处填什么？' },
  fix: { label: '改错', prompt: '这句话哪里不对？' },
  dictation: { label: '听写', prompt: '听写这句话' },
}

const plain = (text: string): Segment[] => (text === '' ? [] : [{ text, mark: false }])

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

/** Splits on "____" blanks; each blank becomes one marked "____". */
export function clozeSegments(text: string): Segment[] {
  const segments: Segment[] = []
  let last = 0
  for (const match of matches(new RegExp(BLANK_RE.source, 'g'), text)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index), mark: false })
    segments.push({ text: '____', mark: true })
    last = match.index + match.text.length
  }
  if (last < text.length) segments.push({ text: text.slice(last), mark: false })
  return segments
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const WORD_CHAR_RE = /[\p{L}\p{N}]/u

/**
 * Marks every case-insensitive occurrence of `needle` that is not inside a
 * longer word. (No lookbehind: older iOS JavaScript engines reject it.)
 */
export function markOccurrences(text: string, needle: string): Segment[] {
  const target = needle.trim()
  if (target === '' || text === '') return plain(text)
  const pattern = new RegExp(`${escapeRegExp(target)}(?![\\p{L}\\p{N}])`, 'giu')
  const segments: Segment[] = []
  let last = 0
  for (const match of matches(pattern, text)) {
    if (match.index > 0 && WORD_CHAR_RE.test(text.charAt(match.index - 1))) continue
    if (match.index > last) segments.push({ text: text.slice(last, match.index), mark: false })
    segments.push({ text: match.text, mark: true })
    last = match.index + match.text.length
  }
  if (last < text.length) segments.push({ text: text.slice(last), mark: false })
  return segments
}

/** The corrected sentence with inserted words marked (deleted ones are not shown). */
export function fixSegments(wrong: string, right: string, diff: DiffWords): Segment[] {
  const segments = diff(wrong, right)
    .filter((segment) => segment.op !== 'delete')
    .map((segment) => ({ text: segment.text, mark: segment.op === 'insert' && segment.text.trim() !== '' }))
  // Merge neighbours so the page renders few spans.
  return segments.reduce<Segment[]>((merged, segment) => {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && previous.mark === segment.mark) {
      return [...merged.slice(0, -1), { text: previous.text + segment.text, mark: segment.mark }]
    }
    return [...merged, segment]
  }, [])
}

const isHeadword = (text: string): boolean => {
  const trimmed = text.trim()
  return (
    trimmed !== '' &&
    !containsCjk(trimmed) &&
    trimmed.length <= HEADWORD_MAX_CHARS &&
    trimmed.split(/\s+/).length <= HEADWORD_MAX_WORDS &&
    !/[.!?]$/.test(trimmed)
  )
}

/** The server sends IPA as "/…/"; the page draws the slashes itself. */
const bareIpa = (ipa: string | undefined): string => (ipa ?? '').trim().replace(/^\/+|\/+$/g, '')

const faceView = (face: CardFace, segments: readonly Segment[]): FaceView => ({
  segments,
  serif: !containsCjk(face.text),
  headword: isHeadword(face.text),
  ipa: bareIpa(face.ipa),
  sub: face.sub ?? '',
  subSerif: face.sub !== undefined && face.sub !== '' && !containsCjk(face.sub),
  exampleEn: face.example?.en ?? '',
  exampleZh: face.example?.zh ?? '',
})

export function cardView(card: QueueCard, diff: DiffWords): CardView {
  const labels = LABELS[card.cardType] ?? { label: '复习', prompt: '' }
  const { front, back } = card
  let frontSegments = plain(front.text)
  let backSegments = plain(back.text)
  if (card.cardType === 'cloze') {
    frontSegments = clozeSegments(front.text)
    backSegments = markOccurrences(back.text, back.sub ?? '')
  } else if (card.cardType === 'fix') {
    backSegments = fixSegments(front.text, back.text, diff)
  }
  const backView = faceView(back, backSegments)
  return {
    label: labels.label,
    prompt: labels.prompt,
    front: faceView(front, frontSegments),
    // A cloze back's `sub` is the answer, already marked in the sentence.
    back: card.cardType === 'cloze' ? { ...backView, sub: '', subSerif: false } : backView,
  }
}

/** 32-bit FNV-1a as base36: a short fingerprint of what a cached audio file says. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/**
 * Cache key of a card's audio. The server rewrites a reported card's faces
 * in place (same id), so the key includes the faces: new text, new audio.
 */
export function cardSpeechKey(card: QueueCard): string {
  return `c-${card.id}-${fingerprint(`${card.front.text}\n${card.back.text}`)}`
}
