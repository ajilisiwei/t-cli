/**
 * Wire types of the learning contract (docs/api-v1.md, "Learning (M3–M5)")
 * that the review session and the 周期资料 read or send.
 * Hand-written like lib/types.ts; the contract document is the source of truth.
 */

/** 1 忘记 (Again), 2 困难 (Hard), 3 记得 (Good), 4 简单 (Easy). */
export type Rating = 1 | 2 | 3 | 4

export type ItemType = 'word' | 'phrase' | 'grammar'
export type CardState = 'new' | 'learning' | 'review' | 'relearning'

/** One side of a card; every card type uses this shape. */
export interface CardFace {
  readonly text: string
  readonly ipa?: string
  readonly sub?: string
  readonly example?: { readonly en: string; readonly zh: string }
}

/** Seconds until the card is due again if rated so. */
export type Intervals = Readonly<Record<'1' | '2' | '3' | '4', number>>

export interface QueueCard {
  readonly id: string
  readonly itemId: string
  readonly itemType: ItemType
  /** recognize | produce | cloze | fix (others are rendered generically). */
  readonly cardType: string
  readonly front: CardFace
  readonly back: CardFace
  readonly state: CardState
  readonly intervals: Intervals
}

/** `GET /v1/review/summary`. */
export interface ReviewSummary {
  /** Cards the queue would serve now (limits applied): the tab badge. */
  readonly due: number
  readonly newAvailable: number
  readonly reviewDue: number
  readonly doneToday: number
  readonly estimatedMinutes: number
  readonly streakDays: number
}

/** One rating as `POST /v1/reviews` takes it; `id` is a client ULID. */
export interface ReviewLog {
  readonly id: string
  readonly cardId: string
  readonly rating: Rating
  /** ISO 8601. */
  readonly reviewedAt: string
  readonly durationMs?: number
}

/** The part of the `POST /v1/reviews` answer the client acts on. */
export interface ReviewBatchResult {
  readonly accepted: readonly string[]
  /** Ids of rejected logs; a rejection without an id is not listed. */
  readonly rejected: readonly string[]
}

export interface WordExample {
  readonly en: string
  readonly zh: string
  readonly fromUser: boolean
}

export interface MaterialWord {
  readonly itemId: string
  readonly headword: string
  readonly ipa: string
  readonly meanings: readonly { readonly pos: string; readonly zh: string }[]
  readonly examples: readonly WordExample[]
  readonly collocations: readonly string[]
  readonly synonyms: readonly { readonly word: string; readonly note: string }[]
  readonly family: readonly string[]
}

export type Register = 'formal' | 'neutral' | 'casual'

export interface MaterialPhrase {
  readonly itemId: string
  readonly phrase: string
  readonly zh: string
  readonly register: Register
  readonly alternatives: readonly { readonly en: string; readonly note: string }[]
  readonly examples: readonly WordExample[]
}

export interface MaterialGrammar {
  readonly itemId: string
  readonly title: string
  readonly rule: string
  readonly wrong: string
  readonly right: string
  readonly exercises: readonly { readonly wrong: string; readonly right: string }[]
}

export interface MaterialStory {
  readonly title: string
  readonly text: string
  readonly words: readonly string[]
  readonly zh: string
}

export interface MaterialMistake {
  readonly itemId: string
  readonly display: string
  readonly note: string
  readonly example: { readonly en: string; readonly zh: string }
}

export interface DailyMaterial {
  readonly date: string
  readonly overview: {
    readonly newWords: number
    readonly newPhrases: number
    readonly corrections: number
    readonly streakDays: number
  }
  readonly words: readonly MaterialWord[]
  readonly phrases: readonly MaterialPhrase[]
  readonly grammar: readonly MaterialGrammar[]
  readonly story: MaterialStory | null
  readonly mistakes: readonly MaterialMistake[]
}
