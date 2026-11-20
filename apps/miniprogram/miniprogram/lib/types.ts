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

export interface Settings {
  readonly explanationLang?: ExplanationLang
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
