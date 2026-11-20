/**
 * The state of one translate/check result, driven by stream events.
 *
 * Pages keep a {@link ResultState} and fold each NDJSON event into it with
 * {@link applyStreamEvent}; everything the result area shows (direction label,
 * text, whether 朗读 is possible) is derived from it.
 */
import type { Direction, EntryKind, SrcLang, StreamEvent } from './types'

export type ResultStatus = 'idle' | 'waiting' | 'streaming' | 'done' | 'failed' | 'stopped'

export interface ResultState {
  readonly status: ResultStatus
  readonly srcLang: SrcLang | null
  readonly kind: EntryKind | null
  readonly text: string
  /** Set by the `done` line; needed for `POST /v1/tts`. */
  readonly entryId: string | null
  readonly errorCode: string | null
}

export const IDLE_RESULT: ResultState = {
  status: 'idle',
  srcLang: null,
  kind: null,
  text: '',
  entryId: null,
  errorCode: null,
}

export const WAITING_RESULT: ResultState = { ...IDLE_RESULT, status: 'waiting' }

export function applyStreamEvent(state: ResultState, event: StreamEvent): ResultState {
  // A finished result never changes again: late lines after `done`/`error` are ignored.
  if (state.status === 'done' || state.status === 'failed' || state.status === 'stopped') return state
  switch (event.type) {
    case 'meta':
      return { ...state, status: 'streaming', srcLang: event.srcLang, kind: event.kind }
    case 'delta':
      return { ...state, status: 'streaming', text: state.text + event.text }
    case 'done':
      return {
        ...state,
        status: 'done',
        entryId: event.entry.id,
        kind: event.entry.kind ?? state.kind,
      }
    case 'error':
      return { ...state, status: 'failed', errorCode: event.code }
  }
}

/** Called when the response body ended: a stream without `done` or `error` was cut off. */
export function finishResult(state: ResultState): ResultState {
  if (state.status === 'waiting' || state.status === 'streaming') {
    return { ...state, status: 'failed', errorCode: 'STREAM_INCOMPLETE' }
  }
  return state
}

/** A request that failed before or during streaming. */
export function failResult(state: ResultState, code: string): ResultState {
  if (state.status === 'done') return state
  return { ...state, status: 'failed', errorCode: code }
}

/** The user tapped 停止. */
export function stopResult(state: ResultState): ResultState {
  if (state.status === 'waiting' || state.status === 'streaming') return { ...state, status: 'stopped' }
  return state
}

export function isBusy(state: ResultState): boolean {
  return state.status === 'waiting' || state.status === 'streaming'
}

/** The small label above a translation, from the stream's `meta` line. */
export function directionLabel(srcLang: SrcLang | null): string {
  switch (srcLang) {
    case 'zh':
      return '中文 → 英文'
    case 'en':
      return '英文 → 中文'
    case 'other':
      return '外语 → 中文'
    default:
      return ''
  }
}

/** The direction that reverses what the server chose (tapping the label). */
export function flipDirection(srcLang: SrcLang | null): Direction {
  return srcLang === 'zh' ? 'toZh' : 'toEn'
}

/** Whether a translation's output is English (it gets the serif type). */
export function outputIsEnglish(srcLang: SrcLang | null): boolean {
  return srcLang === 'zh'
}
