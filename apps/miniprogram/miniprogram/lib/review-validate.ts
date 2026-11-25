/**
 * Shape checks for the review endpoints. A malformed top level is null (the
 * service turns it into BAD_RESPONSE); a single malformed card is skipped,
 * so one bad record never blocks a session.
 */
import type {
  CardFace,
  CardState,
  Intervals,
  ItemType,
  QueueCard,
  ReviewBatchResult,
  ReviewSummary,
} from './review-types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== ''

export function readSummary(value: unknown): ReviewSummary | null {
  if (!isRecord(value)) return null
  const keys = ['due', 'newAvailable', 'reviewDue', 'doneToday', 'estimatedMinutes', 'streakDays'] as const
  const counts: number[] = []
  for (const key of keys) {
    const count = value[key]
    if (!isCount(count)) return null
    counts.push(Math.floor(count))
  }
  const [due = 0, newAvailable = 0, reviewDue = 0, doneToday = 0, estimatedMinutes = 0, streakDays = 0] = counts
  return { due, newAvailable, reviewDue, doneToday, estimatedMinutes, streakDays }
}

const ITEM_TYPES: readonly string[] = ['word', 'phrase', 'grammar']
const CARD_STATES: readonly string[] = ['new', 'learning', 'review', 'relearning']

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

export function readFace(value: unknown): CardFace | null {
  if (!isRecord(value) || typeof value['text'] !== 'string' || value['text'].trim() === '') return null
  const ipa = optionalText(value['ipa'])
  const sub = optionalText(value['sub'])
  const example = value['example']
  const hasExample = isRecord(example) && typeof example['en'] === 'string' && typeof example['zh'] === 'string'
  return {
    text: value['text'],
    ...(ipa === undefined ? {} : { ipa }),
    ...(sub === undefined ? {} : { sub }),
    ...(hasExample ? { example: { en: String(example['en']), zh: String(example['zh']) } } : {}),
  }
}

const readIntervals = (value: unknown): Intervals | null => {
  if (!isRecord(value)) return null
  const one = value['1']
  const two = value['2']
  const three = value['3']
  const four = value['4']
  if (!isCount(one) || !isCount(two) || !isCount(three) || !isCount(four)) return null
  return { '1': one, '2': two, '3': three, '4': four }
}

export function readQueueCard(value: unknown): QueueCard | null {
  if (!isRecord(value)) return null
  const { id, itemId, itemType, cardType, state } = value
  if (!nonEmpty(id) || !nonEmpty(itemId) || !nonEmpty(cardType)) return null
  if (typeof itemType !== 'string' || !ITEM_TYPES.includes(itemType)) return null
  if (typeof state !== 'string' || !CARD_STATES.includes(state)) return null
  const front = readFace(value['front'])
  const back = readFace(value['back'])
  const intervals = readIntervals(value['intervals'])
  if (front === null || back === null || intervals === null) return null
  return { id, itemId, itemType: itemType as ItemType, cardType, front, back, state: state as CardState, intervals }
}

/** `{ cards }` of `GET /v1/review/queue`. */
export function readQueueCards(value: unknown): QueueCard[] | null {
  if (!isRecord(value) || !Array.isArray(value['cards'])) return null
  return value['cards'].map(readQueueCard).filter((card): card is QueueCard => card !== null)
}

/** `POST /v1/reviews` → accepted ids and the ids of rejected logs. */
export function readBatchResult(value: unknown): ReviewBatchResult | null {
  if (!isRecord(value) || !Array.isArray(value['accepted']) || !Array.isArray(value['rejected'])) return null
  const accepted = value['accepted'].filter(nonEmpty)
  const rejected = value['rejected']
    .map((entry) => (isRecord(entry) && nonEmpty(entry['id']) ? entry['id'] : null))
    .filter((id): id is string => id !== null)
  return { accepted, rejected }
}

/**
 * `GET /v1/notify/config` → the reminder template id; null when reminders are
 * not configured, or the answer is unusable (then the client never asks).
 */
export function readReminderTemplateId(value: unknown): string | null {
  if (!isRecord(value)) return null
  const id = value['reminderTemplateId']
  return typeof id === 'string' && id.trim() !== '' ? id : null
}
