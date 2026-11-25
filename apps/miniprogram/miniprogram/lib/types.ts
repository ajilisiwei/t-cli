/**
 * Wire types of the API v1 contract (docs/api-v1.md) that the mini-program
 * reads or sends. Hand-written: the contract document is the source of truth
 * and the mini-program build has no path to the server's zod schemas.
 */

export type SrcLang = 'zh' | 'en' | 'other'
export type EntryKind = 'word' | 'sentence' | 'paragraph'
export type EntryTask = 'translate' | 'check'
export type EntrySource = 'cli' | 'mp'
export type ExplanationLang = 'zh' | 'en'
export type Direction = 'toEn' | 'toZh'

export interface TokenPair {
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessTokenExpiresIn: number
  readonly user: { readonly id: string; readonly role: string; readonly isNew?: boolean }
  readonly deviceId: string
}

/** v2 主题色 (docs/api-v1.md, "v2 → Settings"). */
export type Accent = 'indigo' | 'pine' | 'plum' | 'ochre' | 'ink'
/** system: follow the phone; time: light from themeDayStart to themeNightStart; fixed: themeFixed. */
export type ThemeMode = 'system' | 'time' | 'fixed'
export type ThemeChoice = 'light' | 'dark'

/** v3 周期资料 frequency (docs/api-v1.md, "v3 → Settings"). */
export type MaterialFrequency = 'daily' | 'weekly' | 'off'
/** The parts of a 周期资料 the clients and the PDF show. */
export type MaterialPart = 'words' | 'phrases' | 'grammar' | 'story' | 'exercises'
/** 拓展方向 the user can choose. */
export type ExtendTopic = 'work' | 'travel' | 'exam' | 'daily' | 'tech' | 'culture' | 'finance' | 'health'
/** An extension material's topic: a chosen one, or `other` (never muted). */
export type MaterialTopic = ExtendTopic | 'other'
export type StudyLevel = 'A2' | 'B1' | 'B2' | 'C1'
export type StudyLevelSetting = 'auto' | StudyLevel

/** 不感兴趣: `topic` is not recommended until the local day `until` (exclusive). */
export interface MutedTopic {
  readonly topic: MaterialTopic
  /** YYYY-MM-DD. */
  readonly until: string
}

/** Every key optional; an absent key means its default (in the comments). */
export interface Settings {
  readonly explanationLang?: ExplanationLang
  /** Read a word lookup's result aloud automatically (default true). */
  readonly autoSpeakWord?: boolean
  /** Read a review card aloud when it is flipped (default true). */
  readonly autoSpeakOnFlip?: boolean
  /** Local hour (0–23) for the daily review reminder; null = off. */
  readonly reminderHour?: number | null
  /** Show the translate direction button (default false). */
  readonly showDirection?: boolean
  /** Default 'indigo'. */
  readonly accent?: Accent
  /** Default 'system'. */
  readonly themeMode?: ThemeMode
  /** The theme of themeMode 'fixed' (default 'light'). */
  readonly themeFixed?: ThemeChoice
  /** "HH:MM": light from here in themeMode 'time' (default "07:00"). */
  readonly themeDayStart?: string
  /** "HH:MM": dark from here in themeMode 'time' (default "19:00"). */
  readonly themeNightStart?: string
  /** 阅读模式 (default false). */
  readonly readingMode?: boolean
  /** Reading-mode font size step 0–3 (default 0). */
  readonly readingFontStep?: number
  /** 按重要程度安排复习 (default true). */
  readonly importanceReview?: boolean
  /** v3 周期资料 (default 'daily'). */
  readonly materialFrequency?: MaterialFrequency
  /** 0–6, 0 = Sunday: the day a weekly digest comes out (default 1). */
  readonly materialWeekday?: number
  /** Non-empty, no duplicates (default all five). */
  readonly materialParts?: readonly MaterialPart[]
  /** 拓展资料 (default true). */
  readonly extendEnabled?: boolean
  /** ≤ 8, no duplicates; [] = topics found in the account's data only (default []). */
  readonly extendTopics?: readonly ExtendTopic[]
  /** ≤ 8 (default []). */
  readonly extendMuted?: readonly MutedTopic[]
  /** Default 'auto'. */
  readonly studyLevel?: StudyLevelSetting
}

export interface Me {
  readonly id: string
  readonly role: string
  readonly createdAt: string
  readonly settings: Settings
}

export interface Device {
  readonly id: string
  readonly kind: 'cli' | 'mp' | 'h5'
  readonly name: string
  readonly createdAt: string
  readonly lastSeenAt: string | null
  readonly revokedAt: string | null
  readonly current: boolean
}

/** An Entry as `GET /v1/entries/history` returns it (Entry & { seq }). */
export interface HistoryEntry {
  readonly id: string
  readonly seq: number
  readonly source: EntrySource
  readonly task: EntryTask
  readonly kind: EntryKind
  readonly input: string
  readonly output: string
  readonly srcLang: SrcLang | null
  readonly mode: 'simple' | 'detail'
  readonly createdAt: string
  readonly correctedInput: string | null
}

export interface HistoryPage {
  readonly entries: readonly HistoryEntry[]
  readonly nextBefore: number | null
  readonly hasMore: boolean
}

export interface DeviceLookup {
  readonly deviceName: string
  readonly expiresIn: number
}

export interface DeviceDecision {
  readonly deviceName: string
  readonly approved: boolean
}

/** Body of `POST /v1/ai/translate`. */
export interface TranslateRequest {
  readonly text: string
  readonly task: EntryTask
  readonly mode: 'simple' | 'detail'
  readonly lang: ExplanationLang
  readonly utcOffsetMinutes: number
  readonly direction?: Direction
}

/** One NDJSON line of the translate stream the client understands. */
export type StreamEvent =
  | { readonly type: 'meta'; readonly srcLang: SrcLang | null; readonly kind: EntryKind | null }
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'done'
      readonly entry: {
        readonly id: string
        readonly seq: number | null
        readonly kind: EntryKind | null
        readonly correctedInput: string | null
      }
    }
  | { readonly type: 'error'; readonly code: string; readonly message: string }

// ---------------------------------------------------------------------- v2

/** A record page filter: where a record was made. */
export type SourceFilter = EntrySource

/** Filters of `GET /v1/entries/history` (v2); all optional, combined with AND. */
export interface HistoryFilters {
  /** One local date YYYY-MM-DD (at utcOffsetMinutes). */
  readonly date?: string
  readonly utcOffsetMinutes?: number
  readonly source?: SourceFilter
  /** Case-insensitive substring of the record's input, 1–100 characters. */
  readonly q?: string
}

/** One day of `GET /v1/entries/days`: a local date with at least one record. */
export interface EntryDay {
  readonly date: string
  readonly count: number
}

/** The shared word detail (`LexiconEntry`); `gloss` is in the explanation language. */
export interface LexiconEntry {
  readonly lemma: string
  readonly ipa: { readonly us: string; readonly uk: string }
  readonly senses: readonly { readonly pos: string; readonly gloss: string; readonly def: string }[]
  readonly forms: readonly { readonly label: string; readonly form: string }[]
  readonly collocations: readonly { readonly text: string; readonly gloss: string }[]
  readonly examples: readonly { readonly text: string; readonly gloss: string }[]
  readonly contrasts: readonly { readonly word: string; readonly note: string }[]
  /** '' when there is none. */
  readonly memory: string
}

/** 在本句中: the word's meaning in the sentence and the phrase it belongs to there. */
export interface LookupContext {
  readonly meaning: string
  readonly phrase: { readonly text: string; readonly gloss: string } | null
}

/** Body of `POST /v1/lookup`. */
export interface LookupRequest {
  /** A word, or adjacent words the selection was extended to (1–64 characters). */
  readonly word: string
  /** The sentence it was tapped in (≤ 2000 characters). */
  readonly sentence?: string
  /** The record the sentence comes from. */
  readonly entryId?: string
}

/** `POST /v1/lookup` response. */
export interface LookupResult {
  readonly lemma: string
  readonly lang: 'en'
  readonly entry: LexiconEntry
  /** null without a sentence. */
  readonly context: LookupContext | null
  /** The entry came from the shared cache. */
  readonly cached: boolean
}

export type NoteKind = 'word' | 'phrase' | 'sentence'
export type NoteStars = 1 | 2 | 3 | 4
/** The learning unit's level behind a note (as `GET /v1/items?level=`). */
export type NoteLevel = 'new' | 'learning' | 'mastered'

/** A saved word, phrase or sentence (笔记). */
export interface Note {
  /** Client ULID. */
  readonly id: string
  readonly kind: NoteKind
  /** The English side, whichever side the user typed. */
  readonly text: string
  readonly translation: string | null
  readonly lang: 'en'
  readonly stars: NoteStars
  readonly lemma: string | null
  readonly entryId: string | null
  readonly itemId: string | null
  readonly seq: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly deletedAt: string | null
  /** Its unit's level; null (or absent, from an older server) while there is no unit yet. */
  readonly level?: NoteLevel | null
  /** The task of the record it was saved from; null without one (or before it is pushed). */
  readonly task?: EntryTask | null
}

/** Body of `PUT /v1/notes/:id`. */
export interface NoteInput {
  readonly kind: NoteKind
  readonly text: string
  readonly translation?: string
  readonly lang: 'en'
  readonly stars: NoteStars
  readonly entryId?: string
  /** Word and phrase notes saved after a lookup. */
  readonly lemma?: string
}

/** Filters of `GET /v1/notes`. */
export interface NotesQuery {
  readonly kind?: NoteKind
  readonly stars?: NoteStars
  /** A note id: the page after it (older). */
  readonly before?: string
  readonly limit?: number
}

export interface NotesPage {
  readonly notes: readonly Note[]
  readonly nextBefore: string | null
  readonly hasMore: boolean
}

/** `GET /v1/notes/summary`: counts over the live notes. */
export interface NotesSummary {
  readonly total: number
  /** Saved since Monday of the current local week. */
  readonly thisWeek: number
  readonly kinds: Readonly<Record<NoteKind, number>>
  readonly levels: Readonly<Record<NoteLevel, number>>
}

/** `GET /v1/notes/changes`: every changed note since the cursor, deleted ones included. */
export interface NoteChanges {
  readonly notes: readonly Note[]
  readonly nextAfter: number
  readonly hasMore: boolean
}

/** The `X-Speech-Part` / `X-Speech-Parts` headers of a `POST /v1/tts` answer. */
export interface SpeechParts {
  /** The 0-based part served. */
  readonly part: number
  /** How many parts the text has. */
  readonly parts: number
}
