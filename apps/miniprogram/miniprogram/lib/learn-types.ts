/**
 * Wire types of the v3 学习 module (docs/api-v1.md, "v3 (M12–M17)"): the
 * learn summary, the material list, digest and extension materials, derived
 * exercises, adoption and the PDF export. Hand-written like lib/types.ts; the
 * contract document is the source of truth.
 */
import type { DailyMaterial } from './review-types'
import type { MaterialFrequency, MaterialTopic, StudyLevel, StudyLevelSetting } from './types'

/** `GET /v1/review/queue?scope=`: all due, notes (stars ≥ 1), stars3 (stars ≥ 3). */
export type ReviewScope = 'all' | 'notes' | 'stars3'

export type DueByScope = Readonly<Record<ReviewScope, number>>

export type MaterialKind = 'daily' | 'digest' | 'extend' | 'weekly'
/** Kinds a PDF can be made of. */
export type PrintableKind = 'daily' | 'digest' | 'extend'
/** 周期资料: the kinds the materials page shows. */
export type PeriodicKind = 'daily' | 'digest'

export interface MaterialCounts {
  readonly words: number
  readonly phrases: number
  readonly grammar: number
  readonly exercises: number
  /** Extension items; 0 for the other kinds. */
  readonly items: number
}

/** One row of `GET /v1/materials` (v3 `items`) and of the summary's `materials`. */
export interface MaterialListItem {
  readonly kind: MaterialKind
  readonly date: string
  /** Built by the server in the explanation language. */
  readonly title: string
  /** An extension's first reason; null for the other kinds. */
  readonly subtitle: string | null
  readonly counts: MaterialCounts
  /** 学完了; null while unread. */
  readonly readAt: string | null
  /** Estimated A4 pages of its PDF (practice layout); 0 for weekly. */
  readonly pages: number
  readonly createdAt: string
}

export interface MaterialListPage {
  readonly items: readonly MaterialListItem[]
  readonly nextBefore: string | null
}

/** `GET /v1/learn/summary`. */
export interface LearnSummary {
  readonly review: {
    readonly dueByScope: DueByScope
    readonly doneToday: number
    readonly estimatedMinutes: number
    readonly streakDays: number
  }
  /** The 3 latest of any kind, newest first. */
  readonly materials: readonly MaterialListItem[]
  readonly plan: {
    readonly materialFrequency: MaterialFrequency
    readonly materialWeekday: number
    readonly extendEnabled: boolean
  }
  readonly level: {
    readonly setting: StudyLevelSetting
    readonly effective: StudyLevel
    /** Share of ratings ≥ 2 on non-new cards in the last 30 days; null without such ratings. */
    readonly retention30: number | null
    readonly reviews30: number
  }
}

/** A unit forgotten in review during a digest's range. */
export interface ReviewRecap {
  readonly itemId: string
  readonly display: string
  readonly gloss: string
  readonly lapses: number
}

export interface ClozeExercise {
  readonly itemId: string
  readonly before: string
  readonly after: string
  /** The form the sentence uses ("postponed"). */
  readonly answer: string
  /** The headword or phrase it comes from, as listed in `bank`. */
  readonly base: string
  readonly zh: string
}

export interface TranslateExercise {
  readonly itemId: string
  readonly zh: string
  readonly answer: string
}

export interface FixExercise {
  readonly itemId: string
  readonly wrong: string
  readonly right: string
}

export interface Exercises {
  /** The cloze word bank: every base used plus at most one spare, sorted. */
  readonly bank: readonly string[]
  readonly cloze: readonly ClozeExercise[]
  readonly translate: readonly TranslateExercise[]
  readonly fix: readonly FixExercise[]
}

/** Why a daily material or digest picked a word or phrase (counts within its range). */
export interface UnitReason {
  /** The unit's current stars (0–4). */
  readonly stars: number
  /** 忘记 ratings on its cards. */
  readonly lapses: number
  /** Lookups and records of it. */
  readonly lookups: number
}

/** `GET /v1/materials/daily|digest`: a daily material, or a digest with its range and recap. */
export interface PeriodicMaterial {
  readonly kind: PeriodicKind
  readonly date: string
  readonly createdAt: string
  readonly readAt: string | null
  readonly content: DailyMaterial
  /** Digest only (7 local days, end = date); null for daily. */
  readonly range: { readonly start: string; readonly end: string } | null
  /** Digest only: units forgotten in the range (≤ 12). */
  readonly review: readonly ReviewRecap[]
  readonly exercises: Exercises
  /** By item id, for the words and phrases; empty from an older server. */
  readonly reasons: ReadonlyMap<string, UnitReason>
}

/** The digest-only fields, read beside the DailyMaterial part. */
export interface DigestExtras {
  readonly range: { readonly start: string; readonly end: string } | null
  readonly review: readonly ReviewRecap[]
}

export type ExtendFocus = 'topic' | 'family' | 'grammar' | 'reading'

export interface ExtendItem {
  readonly text: string
  readonly kind: 'word' | 'phrase'
  readonly gloss: string
  readonly example: { readonly en: string; readonly zh: string }
}

export interface ExtendContent {
  readonly focus: ExtendFocus
  readonly topic: MaterialTopic
  readonly title: string
  readonly level: StudyLevel
  /** 1–4, written by the server from evidence and statistics. */
  readonly reasons: readonly string[]
  readonly evidence: readonly string[]
  readonly items: readonly ExtendItem[]
  readonly passage: { readonly title: string; readonly text: string; readonly zh: string } | null
  readonly grammar: {
    readonly rule: string
    readonly examples: readonly { readonly wrong: string; readonly right: string }[]
  } | null
}

/** `GET /v1/materials/extend`. */
export interface ExtendMaterial {
  readonly date: string
  readonly createdAt: string
  readonly readAt: string | null
  readonly content: ExtendContent
  /** Per item: the account already has a unit with that text. */
  readonly known: readonly boolean[]
}

/** `POST /v1/materials/extend/:date/adopt`: indexes. */
export interface AdoptResult {
  readonly added: readonly number[]
  readonly known: readonly number[]
}

export type ExportScope = 'material' | 'cards' | 'checklist'
export type ExportLayout = 'read' | 'practice'

export interface MaterialRef {
  readonly kind: PrintableKind
  readonly date: string
}

/** Body of `POST /v1/exports/pdf`. */
export interface PdfExportRequest {
  readonly scope: ExportScope
  /** 1–8; required for material and cards, optional for checklist. */
  readonly materials?: readonly MaterialRef[]
  /** Material only (default practice). */
  readonly layout?: ExportLayout
  readonly ipa: boolean
  readonly large: boolean
}
