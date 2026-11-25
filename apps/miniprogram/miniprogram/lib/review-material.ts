/**
 * 周期资料 content: reading a DailyMaterial (also the base of a digest)
 * defensively, and marking the day's words in the story. Lists are lenient —
 * a malformed entry is skipped, a missing list is empty — because the
 * material is AI-written and one odd entry must not hide the day.
 */
import type {
  DailyMaterial,
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
    // Sent as "/…/"; the page draws the slashes itself.
    ipa: text(value['ipa']).replace(/^\/+|\/+$/g, ''),
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
