/**
 * Shape checks for the v3 learning endpoints (docs/api-v1.md, "v3 (M12–M17)").
 * Each reader takes the envelope's `data` as `unknown`; a top level a screen
 * cannot work without is null (the service turns it into BAD_RESPONSE),
 * while one malformed row or exercise is skipped, because materials are
 * AI-written and one odd entry must not hide the rest. Pure: no `wx`.
 *
 * The DailyMaterial part of a daily or digest response is read by
 * lib/review-material.ts; it is passed in (`readDaily`), since modules here
 * never import each other by value.
 */
import type {
  AdoptResult,
  ClozeExercise,
  DigestExtras,
  ExtendContent,
  ExtendFocus,
  ExtendItem,
  ExtendMaterial,
  Exercises,
  FixExercise,
  LearnSummary,
  MaterialCounts,
  MaterialKind,
  MaterialListItem,
  MaterialListPage,
  PeriodicKind,
  PeriodicMaterial,
  ReviewRecap,
  TranslateExercise,
  UnitReason,
} from './learn-types'
import type { DailyMaterial } from './review-types'
import type { MaterialFrequency, MaterialTopic, StudyLevel, StudyLevelSetting } from './types'

type Fields = Record<string, unknown>

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)

const list = <T>(value: unknown, read: (entry: Fields) => T | null): T[] =>
  Array.isArray(value) ? value.flatMap((entry) => (isRecord(entry) ? (read(entry) ?? []) : [])) : []

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (value: unknown): value is string => typeof value === 'string' && DATE_RE.test(value)

const timestampOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

const KINDS: readonly MaterialKind[] = ['daily', 'digest', 'extend', 'weekly']
const FREQUENCIES: readonly MaterialFrequency[] = ['daily', 'weekly', 'off']
const LEVELS: readonly StudyLevel[] = ['A2', 'B1', 'B2', 'C1']
const LEVEL_SETTINGS: readonly StudyLevelSetting[] = ['auto', ...LEVELS]
const FOCUSES: readonly ExtendFocus[] = ['topic', 'family', 'grammar', 'reading']
const TOPICS: readonly MaterialTopic[] = ['work', 'travel', 'exam', 'daily', 'tech', 'culture', 'finance', 'health', 'other']

const readCounts = (value: unknown): MaterialCounts => {
  const v = isRecord(value) ? value : {}
  return {
    words: count(v['words']),
    phrases: count(v['phrases']),
    grammar: count(v['grammar']),
    exercises: count(v['exercises']),
    items: count(v['items']),
  }
}

export function readMaterialListItem(value: unknown): MaterialListItem | null {
  if (!isRecord(value)) return null
  const kind = value['kind']
  const date = value['date']
  if (!oneOf(KINDS, kind) || !isDate(date)) return null
  const subtitle = text(value['subtitle'])
  return {
    kind,
    date,
    title: text(value['title']),
    subtitle: subtitle === '' ? null : subtitle,
    counts: readCounts(value['counts']),
    readAt: timestampOrNull(value['readAt']),
    pages: count(value['pages']),
    createdAt: text(value['createdAt']),
  }
}

/** `GET /v1/materials` (v3): the rows and the cursor; null without an `items` list. */
export function readMaterialList(value: unknown): MaterialListPage | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null
  const next = value['nextBefore']
  return {
    items: value['items'].flatMap((item) => readMaterialListItem(item) ?? []),
    nextBefore: isDate(next) ? next : null,
  }
}

const readDueByScope = (value: unknown): LearnSummary['review']['dueByScope'] | null => {
  if (!isRecord(value)) return null
  const { all, notes, stars3 } = value
  return isCount(all) && isCount(notes) && isCount(stars3) ? { all, notes, stars3 } : null
}

const share = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null

/** `GET /v1/learn/summary`; null when the review counts are unusable. */
export function readLearnSummary(value: unknown): LearnSummary | null {
  if (!isRecord(value) || !isRecord(value['review'])) return null
  const review = value['review']
  const dueByScope = readDueByScope(review['dueByScope'])
  if (dueByScope === null) return null
  const plan = isRecord(value['plan']) ? value['plan'] : {}
  const level = isRecord(value['level']) ? value['level'] : {}
  const frequency = plan['materialFrequency']
  const weekday = plan['materialWeekday']
  const setting = level['setting']
  const effective = level['effective']
  return {
    review: {
      dueByScope,
      doneToday: count(review['doneToday']),
      estimatedMinutes: count(review['estimatedMinutes']),
      streakDays: count(review['streakDays']),
    },
    materials: Array.isArray(value['materials'])
      ? value['materials'].flatMap((item) => readMaterialListItem(item) ?? [])
      : [],
    plan: {
      materialFrequency: oneOf(FREQUENCIES, frequency) ? frequency : 'daily',
      materialWeekday: isCount(weekday) && weekday <= 6 ? weekday : 1,
      extendEnabled: plan['extendEnabled'] !== false,
    },
    level: {
      setting: oneOf(LEVEL_SETTINGS, setting) ? setting : 'auto',
      effective: oneOf(LEVELS, effective) ? effective : 'B1',
      retention30: share(level['retention30']),
      reviews30: count(level['reviews30']),
    },
  }
}

// ---- exercises ----

const readCloze = (entry: Fields): ClozeExercise | null => {
  const answer = text(entry['answer'])
  const base = text(entry['base'])
  if (answer === '' || base === '') return null
  // `before` / `after` keep their spaces: they join around the blank.
  const before = typeof entry['before'] === 'string' ? entry['before'] : ''
  const after = typeof entry['after'] === 'string' ? entry['after'] : ''
  if (before.trim() === '' && after.trim() === '') return null
  return { itemId: text(entry['itemId']), before, after, answer, base, zh: text(entry['zh']) }
}

const readTranslate = (entry: Fields): TranslateExercise | null => {
  const zh = text(entry['zh'])
  const answer = text(entry['answer'])
  return zh === '' || answer === '' ? null : { itemId: text(entry['itemId']), zh, answer }
}

const readFix = (entry: Fields): FixExercise | null => {
  const wrong = text(entry['wrong'])
  const right = text(entry['right'])
  return wrong === '' || right === '' ? null : { itemId: text(entry['itemId']), wrong, right }
}

export const NO_EXERCISES: Exercises = { bank: [], cloze: [], translate: [], fix: [] }

/** A material's `exercises`; absent or malformed parts are empty. */
export function readExercises(value: unknown): Exercises {
  if (!isRecord(value)) return NO_EXERCISES
  const cloze = list(value['cloze'], readCloze)
  const bank = Array.isArray(value['bank'])
    ? [...new Set(value['bank'].map(text).filter((word) => word !== ''))]
    : []
  // Every cloze base must be choosable, whatever the bank says.
  const fullBank = [...new Set([...bank, ...cloze.map((exercise) => exercise.base)])].sort((a, b) =>
    a.localeCompare(b, 'en'),
  )
  return { bank: fullBank, cloze, translate: list(value['translate'], readTranslate), fix: list(value['fix'], readFix) }
}

// ---- daily and digest ----

const readRecap = (entry: Fields): ReviewRecap | null => {
  const display = text(entry['display'])
  return display === ''
    ? null
    : { itemId: text(entry['itemId']), display, gloss: text(entry['gloss']), lapses: count(entry['lapses']) }
}

/** The digest-only fields of a content object (absent on a daily material). */
export function readDigestExtras(value: unknown): DigestExtras {
  if (!isRecord(value)) return { range: null, review: [] }
  const range = isRecord(value['range']) ? value['range'] : {}
  const start = range['start']
  const end = range['end']
  return {
    range: isDate(start) && isDate(end) ? { start, end } : null,
    review: list(value['review'], readRecap),
  }
}

const MAX_STARS = 4

/** A material's `reasons` by item id; malformed entries are skipped, absent counts are 0. */
export function readReasons(value: unknown): Map<string, UnitReason> {
  const reasons = new Map<string, UnitReason>()
  if (!isRecord(value)) return reasons
  for (const [itemId, entry] of Object.entries(value)) {
    if (itemId === '' || !isRecord(entry)) continue
    reasons.set(itemId, {
      stars: Math.min(MAX_STARS, count(entry['stars'])),
      lapses: count(entry['lapses']),
      lookups: count(entry['lookups']),
    })
  }
  return reasons
}

/**
 * `GET /v1/materials/daily|digest` → the material; null when the date or the
 * content is unusable. `readDaily` reads the DailyMaterial part.
 */
export function readPeriodicMaterial(
  value: unknown,
  kind: PeriodicKind,
  readDaily: (content: unknown) => DailyMaterial | null,
): PeriodicMaterial | null {
  if (!isRecord(value) || !isDate(value['date'])) return null
  const date = value['date']
  const content = readDaily(value['content'])
  if (content === null) return null
  const extras = kind === 'digest' ? readDigestExtras(value['content']) : { range: null, review: [] }
  return {
    kind,
    date,
    createdAt: text(value['createdAt']),
    readAt: timestampOrNull(value['readAt']),
    content: { ...content, date },
    range: extras.range,
    review: extras.review,
    exercises: readExercises(value['exercises']),
    reasons: readReasons(value['reasons']),
  }
}

// ---- extension ----

const readExtendItem = (entry: Fields): ExtendItem | null => {
  const itemText = text(entry['text'])
  if (itemText === '') return null
  const example = isRecord(entry['example']) ? entry['example'] : {}
  return {
    text: itemText,
    kind: entry['kind'] === 'phrase' ? 'phrase' : 'word',
    gloss: text(entry['gloss']),
    example: { en: text(example['en']), zh: text(example['zh']) },
  }
}

const readPassage = (value: unknown): ExtendContent['passage'] => {
  if (!isRecord(value)) return null
  const passageText = text(value['text'])
  return passageText === '' ? null : { title: text(value['title']), text: passageText, zh: text(value['zh']) }
}

const readGrammar = (value: unknown): ExtendContent['grammar'] => {
  if (!isRecord(value)) return null
  const rule = text(value['rule'])
  const examples = list(value['examples'], (entry) => {
    const wrong = text(entry['wrong'])
    const right = text(entry['right'])
    return wrong === '' || right === '' ? null : { wrong, right }
  })
  return rule === '' && examples.length === 0 ? null : { rule, examples }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(text).filter((entry) => entry !== '') : []

/** `GET /v1/materials/extend` → the material; null without a date or a single item. */
export function readExtendMaterial(value: unknown): ExtendMaterial | null {
  if (!isRecord(value) || !isDate(value['date']) || !isRecord(value['content'])) return null
  const content = value['content']
  // Indexes matter (adopt sends them), so a malformed item stays as a hole rather than shifting the rest.
  const rawItems: unknown[] = Array.isArray(content['items']) ? content['items'] : []
  const items = rawItems.map((entry) => (isRecord(entry) ? readExtendItem(entry) : null))
  if (items.length === 0 || items.some((item) => item === null)) return null
  const known = Array.isArray(value['known']) ? value['known'] : []
  const focus = content['focus']
  const topic = content['topic']
  const level = content['level']
  return {
    date: value['date'],
    createdAt: text(value['createdAt']),
    readAt: timestampOrNull(value['readAt']),
    content: {
      focus: oneOf(FOCUSES, focus) ? focus : 'topic',
      topic: oneOf(TOPICS, topic) ? topic : 'other',
      title: text(content['title']),
      level: oneOf(LEVELS, level) ? level : 'B1',
      reasons: strings(content['reasons']),
      evidence: strings(content['evidence']),
      items: items.filter((item): item is ExtendItem => item !== null),
      passage: readPassage(content['passage']),
      grammar: readGrammar(content['grammar']),
    },
    known: items.map((_, index) => known[index] === true),
  }
}

const indexes = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((entry): entry is number => isCount(entry)) : []

/** `POST …/adopt` → `{ added, known }`; null when either list is missing. */
export function readAdoptResult(value: unknown): AdoptResult | null {
  if (!isRecord(value) || !Array.isArray(value['added']) || !Array.isArray(value['known'])) return null
  return { added: indexes(value['added']), known: indexes(value['known']) }
}

/** `POST …/read` → the new `readAt` (null = unread); undefined when malformed. */
export function readReadAt(value: unknown): string | null | undefined {
  if (!isRecord(value) || !('readAt' in value)) return undefined
  const readAt = value['readAt']
  if (readAt === null) return null
  return typeof readAt === 'string' && readAt !== '' ? readAt : undefined
}
