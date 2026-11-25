/**
 * 学习单元: validation and view of `GET /v1/items/:id` — the unit's content
 * by type, its review cards and the records it came from
 * (docs/api-v1.md, "Content shapes" and "Library and stats").
 *
 * Content is AI-generated and validated loosely: a missing optional part is
 * left out, but a unit without its headword / phrase / title has no content.
 */
import type { ItemLevel, ItemType } from './library'

export interface Example {
  readonly en: string
  readonly zh: string
  readonly fromUser: boolean
}

export interface WordContent {
  readonly headword: string
  readonly ipa: string
  readonly meanings: readonly { readonly pos: string; readonly zh: string }[]
  readonly examples: readonly Example[]
  readonly collocations: readonly string[]
  readonly synonyms: readonly { readonly word: string; readonly note: string }[]
  readonly family: readonly string[]
}

export type Register = 'formal' | 'neutral' | 'casual'

export interface PhraseContent {
  readonly phrase: string
  readonly zh: string
  readonly register: Register | null
  readonly alternatives: readonly { readonly en: string; readonly note: string }[]
  readonly examples: readonly Example[]
}

export interface GrammarContent {
  readonly title: string
  readonly rule: string
  readonly wrong: string
  readonly right: string
  readonly exercises: readonly { readonly wrong: string; readonly right: string }[]
}

export type ItemContent =
  | ({ readonly kind: 'word' } & WordContent)
  | ({ readonly kind: 'phrase' } & PhraseContent)
  | ({ readonly kind: 'grammar' } & GrammarContent)

export type CardState = 'new' | 'learning' | 'review' | 'relearning'
export type ItemStatus = 'pending' | 'ready' | 'needs_regen'

export interface ItemCard {
  readonly id: string
  readonly cardType: string
  readonly state: CardState
  readonly due: string | null
  readonly mastered: boolean
  readonly suspended: boolean
}

export interface ItemSource {
  readonly entryId: string
  readonly input: string
  readonly createdAt: string
}

export interface ItemDetail {
  readonly id: string
  readonly type: ItemType
  readonly display: string
  readonly status: ItemStatus
  readonly content: ItemContent | null
  readonly lookupCount: number
  readonly errorCount: number
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly level: ItemLevel
  readonly cards: readonly ItemCard[]
  readonly sources: readonly ItemSource[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/** Keeps the array's records that `read` accepts. */
const list = <T>(value: unknown, read: (entry: Record<string, unknown>) => T | null): T[] =>
  Array.isArray(value)
    ? value.filter(isRecord).map(read).filter((entry): entry is T => entry !== null)
    : []

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(text).filter((entry) => entry !== '') : []

const readExample = (value: Record<string, unknown>): Example | null => {
  const en = text(value['en'])
  return en === '' ? null : { en, zh: text(value['zh']), fromUser: value['fromUser'] === true }
}

const readWord = (value: Record<string, unknown>): WordContent | null => {
  const headword = text(value['headword'])
  if (headword === '') return null
  return {
    headword,
    ipa: text(value['ipa']).replace(/^\/+|\/+$/g, ''),
    meanings: list(value['meanings'], (m) => {
      const zh = text(m['zh'])
      return zh === '' ? null : { pos: text(m['pos']), zh }
    }),
    examples: list(value['examples'], readExample),
    collocations: strings(value['collocations']),
    synonyms: list(value['synonyms'], (s) => {
      const word = text(s['word'])
      return word === '' ? null : { word, note: text(s['note']) }
    }),
    family: strings(value['family']),
  }
}

const isRegister = (value: unknown): value is Register =>
  value === 'formal' || value === 'neutral' || value === 'casual'

const readPhrase = (value: Record<string, unknown>): PhraseContent | null => {
  const phrase = text(value['phrase'])
  if (phrase === '') return null
  return {
    phrase,
    zh: text(value['zh']),
    register: isRegister(value['register']) ? value['register'] : null,
    alternatives: list(value['alternatives'], (a) => {
      const en = text(a['en'])
      return en === '' ? null : { en, note: text(a['note']) }
    }),
    examples: list(value['examples'], readExample),
  }
}

const readGrammar = (value: Record<string, unknown>): GrammarContent | null => {
  const title = text(value['title'])
  if (title === '') return null
  return {
    title,
    rule: text(value['rule']),
    wrong: text(value['wrong']),
    right: text(value['right']),
    exercises: list(value['exercises'], (e) => {
      const wrong = text(e['wrong'])
      const right = text(e['right'])
      return wrong === '' || right === '' ? null : { wrong, right }
    }),
  }
}

/** The unit's content for its type, or null (not generated yet, or unusable). */
export function readItemContent(type: ItemType, value: unknown): ItemContent | null {
  if (!isRecord(value)) return null
  switch (type) {
    case 'word': {
      const word = readWord(value)
      return word === null ? null : { kind: 'word', ...word }
    }
    case 'phrase': {
      const phrase = readPhrase(value)
      return phrase === null ? null : { kind: 'phrase', ...phrase }
    }
    case 'grammar': {
      const grammar = readGrammar(value)
      return grammar === null ? null : { kind: 'grammar', ...grammar }
    }
  }
}

const CARD_STATES: readonly CardState[] = ['new', 'learning', 'review', 'relearning']

/** A card state as a name; FSRS numbers (0–3) are accepted too. */
export function readCardState(value: unknown): CardState {
  if (typeof value === 'number') return CARD_STATES[value] ?? 'new'
  return CARD_STATES.find((state) => state === value) ?? 'new'
}

const readCard = (value: Record<string, unknown>): ItemCard | null => {
  const id = text(value['id'])
  if (id === '') return null
  const due = value['due']
  return {
    id,
    cardType: text(value['cardType']),
    state: readCardState(value['state']),
    due: typeof due === 'string' && due !== '' ? due : null,
    mastered: value['mastered'] === true,
    suspended: value['suspended'] === true,
  }
}

const readSource = (value: Record<string, unknown>): ItemSource | null => {
  const entryId = text(value['entryId'])
  const input = typeof value['input'] === 'string' ? value['input'] : ''
  if (entryId === '' || input.trim() === '') return null
  return { entryId, input, createdAt: text(value['createdAt']) }
}

const ITEM_TYPES: readonly ItemType[] = ['word', 'phrase', 'grammar']
const ITEM_LEVELS: readonly ItemLevel[] = ['new', 'learning', 'mastered']
const ITEM_STATUSES: readonly ItemStatus[] = ['pending', 'ready', 'needs_regen']

/** Validates `GET /v1/items/:id`; null when the response is unusable. */
export function readItemDetail(value: unknown): ItemDetail | null {
  if (!isRecord(value)) return null
  const id = text(value['id'])
  const type = ITEM_TYPES.find((t) => t === value['type'])
  if (id === '' || type === undefined || typeof value['display'] !== 'string') return null
  return {
    id,
    type,
    display: value['display'],
    status: ITEM_STATUSES.find((s) => s === value['status']) ?? 'ready',
    content: readItemContent(type, value['content']),
    lookupCount: count(value['lookupCount']),
    errorCount: count(value['errorCount']),
    firstSeenAt: text(value['firstSeenAt']),
    lastSeenAt: text(value['lastSeenAt']),
    level: ITEM_LEVELS.find((l) => l === value['level']) ?? 'learning',
    cards: list(value['cards'], readCard),
    sources: list(value['sources'], readSource),
  }
}

export const REGISTER_LABELS: Readonly<Record<Register, string>> = {
  formal: '正式',
  neutral: '中性',
  casual: '口语',
}

export const CARD_TYPE_LABELS: Readonly<Record<string, string>> = {
  recognize: '认词',
  produce: '回想',
  cloze: '填空',
  fix: '改错',
  dictation: '听写',
}

export const CARD_STATE_LABELS: Readonly<Record<CardState, string>> = {
  new: '新卡',
  learning: '学习中',
  review: '复习中',
  relearning: '重学中',
}

const DAY_MS = 86_400_000

const localMidnight = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * When a card comes up next, in this device's local time: "待复习" (due now),
 * "今天 18:30", "明天", "3 天后", "12月24日", "2027年3月1日".
 */
export function formatDue(due: string, now: Date): string {
  const date = new Date(due)
  if (Number.isNaN(date.getTime())) return ''
  if (date.getTime() <= now.getTime()) return '待复习'
  const days = Math.round((localMidnight(date) - localMidnight(now)) / DAY_MS)
  if (days === 0) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (days === 1) return '明天'
  if (days <= 30) return `${days} 天后`
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}年${monthDay}`
}

export interface CardRow {
  readonly id: string
  readonly typeLabel: string
  readonly stateLabel: string
  /** When it is due, or why it is not scheduled. */
  readonly dueLabel: string
  /** Mastered or suspended: shown quieter. */
  readonly resting: boolean
}

export function toCardRow(card: ItemCard, now: Date): CardRow {
  const typeLabel = CARD_TYPE_LABELS[card.cardType] ?? card.cardType
  if (card.suspended) {
    return { id: card.id, typeLabel, stateLabel: '已暂停', dueLabel: '内容更新后恢复', resting: true }
  }
  if (card.mastered) {
    return { id: card.id, typeLabel, stateLabel: '已掌握', dueLabel: '不再安排', resting: true }
  }
  const dueLabel =
    card.state === 'new' ? '等待首次复习' : card.due === null ? '' : formatDue(card.due, now)
  return { id: card.id, typeLabel, stateLabel: CARD_STATE_LABELS[card.state], dueLabel, resting: false }
}

export interface SourceRow {
  readonly id: string
  readonly input: string
  readonly time: string
}

/** The records the unit came from; `formatTime` renders a timestamp (injected: lib modules import no values). */
export function toSourceRows(sources: readonly ItemSource[], formatTime: (iso: string) => string): SourceRow[] {
  return sources.map((source) => ({ id: source.entryId, input: source.input, time: formatTime(source.createdAt) }))
}

export interface ExerciseView {
  readonly key: string
  readonly wrong: string
  readonly right: string
  readonly revealed: boolean
}

export function toExercises(content: ItemContent | null): ExerciseView[] {
  if (content === null || content.kind !== 'grammar') return []
  return content.exercises.map((exercise, index) => ({ key: `${index}`, ...exercise, revealed: false }))
}

/** Shows (or hides again) one exercise's answer. */
export function toggleExercise(exercises: readonly ExerciseView[], index: number): ExerciseView[] {
  return exercises.map((exercise, i) => (i === index ? { ...exercise, revealed: !exercise.revealed } : exercise))
}

/** A line under the header while the unit has no (or outdated) content; '' otherwise. */
export function statusNotice(detail: ItemDetail): string {
  if (detail.status === 'needs_regen') return '内容正在重新生成，稍后再来看'
  if (detail.content === null) return '内容还在整理，通常第二天早上就能看到'
  return ''
}

/** "单词 · 学习中 · 查过 3 次 · 错 1 次" */
export function itemMeta(detail: ItemDetail, typeLabel: string, levelLabel: string): string {
  const parts = [typeLabel, levelLabel]
  if (detail.lookupCount > 0) parts.push(`查过 ${detail.lookupCount} 次`)
  if (detail.errorCount > 0) parts.push(`错 ${detail.errorCount} 次`)
  return parts.join(' · ')
}

/** "n." "adj." with the dot when the model left it out. */
export function posLabel(pos: string): string {
  const trimmed = pos.trim()
  if (trimmed === '' || /[.．]$/.test(trimmed) || /[^\x20-\x7e]/.test(trimmed)) return trimmed
  return `${trimmed}.`
}
