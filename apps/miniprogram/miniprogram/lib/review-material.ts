/**
 * 每日材料: reading `GET /v1/materials/daily` defensively and shaping it into
 * the sections the page switches between (概览 · 单词 · 句型 · 语法 · 短文 · 易错).
 * Lists are lenient — a malformed entry is skipped, a missing list is empty —
 * because the material is AI-written and one odd entry must not hide the day.
 */
import type {
  DailyMaterial,
  DailyMaterialResponse,
  MaterialGrammar,
  MaterialMistake,
  MaterialPhrase,
  MaterialStory,
  MaterialWord,
  Register,
  WordExample,
} from './review-types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

const list = <T>(value: unknown, read: (entry: unknown) => T | null): T[] =>
  Array.isArray(value) ? value.map(read).filter((entry): entry is T => entry !== null) : []

const strings = (value: unknown): string[] => list(value, (entry) => (text(entry) === '' ? null : text(entry)))

const readExample = (value: unknown): WordExample | null =>
  isRecord(value) && text(value['en']) !== ''
    ? { en: text(value['en']), zh: text(value['zh']), fromUser: value['fromUser'] === true }
    : null

const readWord = (value: unknown): MaterialWord | null => {
  if (!isRecord(value) || text(value['itemId']) === '' || text(value['headword']) === '') return null
  return {
    itemId: text(value['itemId']),
    headword: text(value['headword']),
    ipa: text(value['ipa']),
    meanings: list(value['meanings'], (entry) =>
      isRecord(entry) && text(entry['zh']) !== '' ? { pos: text(entry['pos']), zh: text(entry['zh']) } : null,
    ),
    examples: list(value['examples'], readExample),
    collocations: strings(value['collocations']),
    synonyms: list(value['synonyms'], (entry) =>
      isRecord(entry) && text(entry['word']) !== '' ? { word: text(entry['word']), note: text(entry['note']) } : null,
    ),
    family: strings(value['family']),
  }
}

const REGISTERS: readonly string[] = ['formal', 'neutral', 'casual']

const readPhrase = (value: unknown): MaterialPhrase | null => {
  if (!isRecord(value) || text(value['itemId']) === '' || text(value['phrase']) === '') return null
  const register = text(value['register'])
  return {
    itemId: text(value['itemId']),
    phrase: text(value['phrase']),
    zh: text(value['zh']),
    register: (REGISTERS.includes(register) ? register : 'neutral') as Register,
    alternatives: list(value['alternatives'], (entry) =>
      isRecord(entry) && text(entry['en']) !== '' ? { en: text(entry['en']), note: text(entry['note']) } : null,
    ),
    examples: list(value['examples'], readExample),
  }
}

const readGrammar = (value: unknown): MaterialGrammar | null => {
  if (!isRecord(value) || text(value['itemId']) === '' || text(value['title']) === '') return null
  return {
    itemId: text(value['itemId']),
    title: text(value['title']),
    rule: text(value['rule']),
    wrong: text(value['wrong']),
    right: text(value['right']),
    exercises: list(value['exercises'], (entry) =>
      isRecord(entry) && text(entry['wrong']) !== '' && text(entry['right']) !== ''
        ? { wrong: text(entry['wrong']), right: text(entry['right']) }
        : null,
    ),
  }
}

const readStory = (value: unknown): MaterialStory | null => {
  if (!isRecord(value) || text(value['text']) === '') return null
  return { title: text(value['title']), text: text(value['text']), words: strings(value['words']), zh: text(value['zh']) }
}

const readMistake = (value: unknown): MaterialMistake | null => {
  if (!isRecord(value) || text(value['itemId']) === '' || text(value['display']) === '') return null
  const example = value['example']
  return {
    itemId: text(value['itemId']),
    display: text(value['display']),
    note: text(value['note']),
    example: isRecord(example) ? { en: text(example['en']), zh: text(example['zh']) } : { en: '', zh: '' },
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function readDailyMaterial(value: unknown): DailyMaterial | null {
  if (!isRecord(value)) return null
  const overview = isRecord(value['overview']) ? value['overview'] : {}
  return {
    date: text(value['date']),
    overview: {
      newWords: count(overview['newWords']),
      newPhrases: count(overview['newPhrases']),
      corrections: count(overview['corrections']),
      streakDays: count(overview['streakDays']),
    },
    words: list(value['words'], readWord),
    phrases: list(value['phrases'], readPhrase),
    grammar: list(value['grammar'], readGrammar),
    story: readStory(value['story']),
    mistakes: list(value['mistakes'], readMistake),
  }
}

/** `{ date, content, createdAt }`; null when the date or the content is unusable. */
export function readDailyMaterialResponse(value: unknown): DailyMaterialResponse | null {
  if (!isRecord(value) || typeof value['date'] !== 'string' || !DATE_RE.test(value['date'])) return null
  const content = readDailyMaterial(value['content'])
  if (content === null) return null
  return {
    date: value['date'],
    content: { ...content, date: value['date'] },
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : '',
  }
}

export type SectionId = 'overview' | 'words' | 'phrases' | 'grammar' | 'story' | 'mistakes'

export interface Section {
  readonly id: SectionId
  readonly label: string
  readonly count: number
}

const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  overview: '概览',
  words: '单词',
  phrases: '句型',
  grammar: '语法',
  story: '短文',
  mistakes: '易错',
}

/** 概览 always, then every section that has something in it. */
export function sections(material: DailyMaterial): Section[] {
  const counts: [SectionId, number][] = [
    ['words', material.words.length],
    ['phrases', material.phrases.length],
    ['grammar', material.grammar.length],
    ['story', material.story === null ? 0 : 1],
    ['mistakes', material.mistakes.length],
  ]
  return [
    { id: 'overview', label: SECTION_LABELS.overview, count: 0 },
    ...counts.filter(([, n]) => n > 0).map(([id, n]) => ({ id, label: SECTION_LABELS[id], count: n })),
  ]
}

/** "12 个单词 · 5 个句型 · 2 条语法" for the 复习 home. */
export function materialCounts(material: DailyMaterial): string {
  return [
    material.words.length > 0 ? `${material.words.length} 个单词` : '',
    material.phrases.length > 0 ? `${material.phrases.length} 个句型` : '',
    material.grammar.length > 0 ? `${material.grammar.length} 条语法` : '',
    material.mistakes.length > 0 ? `${material.mistakes.length} 个易错点` : '',
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

export const REGISTER_LABELS: Readonly<Record<Register, string>> = { formal: '正式', neutral: '中性', casual: '口语' }

export interface OverviewStat {
  readonly label: string
  readonly value: number
}

/** The four numbers of 概览. */
export function overviewStats(material: DailyMaterial): OverviewStat[] {
  const { overview } = material
  return [
    { label: '新单词', value: overview.newWords },
    { label: '新句型', value: overview.newPhrases },
    { label: '纠错', value: overview.corrections },
    { label: '连续天数', value: overview.streakDays },
  ]
}

/** "12 个" / "2 条" / "1 篇" next to a section on 概览. */
export function sectionCountLabel(section: Section): string {
  if (section.id === 'story') return `${section.count} 篇`
  if (section.id === 'grammar') return `${section.count} 条`
  return `${section.count} 个`
}

export interface ExerciseView {
  /** Key in the page's "revealed" map. */
  readonly key: string
  readonly wrong: string
  readonly right: string
}

export interface GrammarView extends MaterialGrammar {
  readonly exerciseViews: readonly ExerciseView[]
}

export function grammarViews(grammar: readonly MaterialGrammar[]): GrammarView[] {
  return grammar.map((entry, index) => ({
    ...entry,
    exerciseViews: entry.exercises.map((exercise, n) => ({ key: `g${index}e${n}`, ...exercise })),
  }))
}

export interface PhraseView extends MaterialPhrase {
  readonly registerLabel: string
}

export function phraseViews(phrases: readonly MaterialPhrase[]): PhraseView[] {
  return phrases.map((phrase) => ({ ...phrase, registerLabel: REGISTER_LABELS[phrase.register] }))
}

/** Neighbours of `date` in a newest-first list: older is further down. */
export function dateNeighbours(dates: readonly string[], date: string): { older: string; newer: string } {
  const index = dates.indexOf(date)
  if (index < 0) {
    return {
      older: dates.find((candidate) => candidate < date) ?? '',
      newer: [...dates].reverse().find((candidate) => candidate > date) ?? '',
    }
  }
  return { older: dates[index + 1] ?? '', newer: index > 0 ? (dates[index - 1] ?? '') : '' }
}

export interface StorySegment {
  readonly text: string
  /** One of the day's words (or an inflected form of it). */
  readonly word: boolean
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const LETTER_RE = /[\p{L}\p{N}]/u
const SUFFIXES = '(?:s|es|ed|d|ing|ly|er|est)?'

/**
 * The story with the day's words marked, including simple inflections
 * ("meticulously" for "meticulous"). Longer words win over their prefixes.
 */
export function storySegments(story: string, words: readonly string[]): StorySegment[] {
  const targets = [...new Set(words.map((word) => word.trim()).filter((word) => word !== ''))].sort(
    (a, b) => b.length - a.length,
  )
  if (story === '') return []
  if (targets.length === 0) return [{ text: story, word: false }]
  const pattern = new RegExp(`(?:${targets.map(escapeRegExp).join('|')})${SUFFIXES}`, 'giu')
  const segments: StorySegment[] = []
  let last = 0
  for (let match = pattern.exec(story); match !== null; match = pattern.exec(story)) {
    const start = match.index
    const end = start + match[0].length
    const before = start > 0 && LETTER_RE.test(story.charAt(start - 1))
    const after = end < story.length && LETTER_RE.test(story.charAt(end))
    if (match[0] === '' || before || after) {
      pattern.lastIndex = start + 1
      continue
    }
    if (start > last) segments.push({ text: story.slice(last, start), word: false })
    segments.push({ text: match[0], word: true })
    last = end
  }
  if (last < story.length) segments.push({ text: story.slice(last), word: false })
  return segments
}
