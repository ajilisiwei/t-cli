/**
 * 周期资料 (每日资料 / 每周合集) on one scrolling page: the title, the counts
 * row, compact word and phrase rows with why each was picked (one tag), and
 * which parts `materialParts` shows.
 * Pure; the page composes it with lib/exercises.ts and lib/review-material.ts.
 */
import type { PeriodicMaterial, UnitReason } from './learn-types'
import type { MaterialPhrase, MaterialWord } from './review-types'
import type { MaterialPart } from './types'

export type ReasonTone = 'lapse' | 'star' | 'lookup'

export interface ReasonTag {
  readonly text: string
  readonly tone: ReasonTone
}

/**
 * Why a word or phrase is in the material, one tag: forgotten in review
 * first, then its stars, then its lookups; null when there is nothing to say.
 */
export function reasonTag(reason: UnitReason | undefined): ReasonTag | null {
  if (reason === undefined) return null
  if (reason.lapses > 0) return { text: `复习时忘了 ${reason.lapses} 次`, tone: 'lapse' }
  if (reason.stars > 0) return { text: `笔记本 · ${reason.stars} 星`, tone: 'star' }
  if (reason.lookups > 0) return { text: `查了 ${reason.lookups} 次`, tone: 'lookup' }
  return null
}

const NO_REASONS: ReadonlyMap<string, UnitReason> = new Map()

export const showsPart = (parts: readonly MaterialPart[], part: MaterialPart): boolean => parts.includes(part)

/** "9 个词和一篇短文"; a digest without new units is its review recap. */
export function periodicTitle(material: Pick<PeriodicMaterial, 'kind' | 'content' | 'review'>): string {
  const { content } = material
  const units = content.words.length + content.phrases.length
  if (units > 0) return `${units} 个词${content.story === null ? '' : '和一篇短文'}`
  if (material.kind === 'digest' && material.review.length > 0) return `本周复习时忘过的 ${material.review.length} 个`
  if (content.grammar.length + content.mistakes.length > 0) return `${content.grammar.length + content.mistakes.length} 条语法和易错`
  return material.kind === 'digest' ? '这周没有新内容' : '这天没有新内容'
}

export interface CountCell {
  readonly label: string
  readonly value: number
}

/** The counts row: one cell per part shown. */
export function countCells(
  material: Pick<PeriodicMaterial, 'content'>,
  exercises: number,
  parts: readonly MaterialPart[],
): CountCell[] {
  const { content } = material
  const cells: [MaterialPart, string, number][] = [
    ['words', '新词', content.words.length],
    ['phrases', '词组', content.phrases.length],
    ['grammar', '易错', content.grammar.length + content.mistakes.length],
    ['exercises', '练习', exercises],
  ]
  return cells.filter(([part]) => showsPart(parts, part)).map(([, label, value]) => ({ label, value }))
}

export interface WordRow {
  readonly itemId: string
  /** The speech key of its 朗读 button. */
  readonly key: string
  readonly text: string
  readonly ipa: string
  /** "v. 减轻；缓和 · n. …" */
  readonly gloss: string
  readonly exampleEn: string
  readonly exampleZh: string
  /** The reason tag ("复习时忘了 2 次"); '' without one. */
  readonly why: string
  /** '' without a tag. */
  readonly whyTone: '' | ReasonTone
}

const meaningLine = (word: MaterialWord): string =>
  word.meanings
    .slice(0, 2)
    .map((meaning) => (meaning.pos === '' ? meaning.zh : `${meaning.pos} ${meaning.zh}`))
    .join(' · ')

const whyOf = (reason: UnitReason | undefined): Pick<WordRow, 'why' | 'whyTone'> => {
  const tag = reasonTag(reason)
  return { why: tag?.text ?? '', whyTone: tag?.tone ?? '' }
}

export function wordRows(
  words: readonly MaterialWord[],
  keyOf: (itemId: string, text: string) => string,
  reasons: ReadonlyMap<string, UnitReason> = NO_REASONS,
): WordRow[] {
  return words.map((word) => ({
    itemId: word.itemId,
    key: keyOf(word.itemId, word.headword),
    text: word.headword,
    ipa: word.ipa,
    gloss: meaningLine(word),
    exampleEn: word.examples[0]?.en ?? '',
    exampleZh: word.examples[0]?.zh ?? '',
    ...whyOf(reasons.get(word.itemId)),
  }))
}

export function phraseRows(
  phrases: readonly MaterialPhrase[],
  keyOf: (itemId: string, text: string) => string,
  reasons: ReadonlyMap<string, UnitReason> = NO_REASONS,
): WordRow[] {
  return phrases.map((phrase) => ({
    itemId: phrase.itemId,
    key: keyOf(phrase.itemId, phrase.phrase),
    text: phrase.phrase,
    ipa: '',
    gloss: phrase.zh,
    exampleEn: phrase.examples[0]?.en ?? '',
    exampleZh: phrase.examples[0]?.zh ?? '',
    ...whyOf(reasons.get(phrase.itemId)),
  }))
}

/** Cards it makes: words and phrases. */
export function cardWords(material: Pick<PeriodicMaterial, 'content'>): number {
  return material.content.words.length + material.content.phrases.length
}

/** A page estimate when the list's `pages` did not come along (roughly the PDF's practice layout). */
export function estimateMaterialPages(material: Pick<PeriodicMaterial, 'content'>, exercises: number): number {
  const { content } = material
  const share =
    content.words.length * 0.15 +
    content.phrases.length * 0.12 +
    (content.grammar.length + content.mistakes.length) * 0.2 +
    (content.story === null ? 0 : 0.5) +
    exercises * 0.06
  return Math.max(1, Math.ceil(share))
}

/** "忘了 2 次" beside a recap row. */
export function lapsesLabel(lapses: number): string {
  return lapses > 0 ? `忘了 ${lapses} 次` : ''
}
