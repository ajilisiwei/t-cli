/**
 * 朗读 state shared by every speaker button: one sound at a time, named by a
 * key (its audio cache key). A request goes loading (fetching the audio) →
 * playing → idle. A newer request or stop() supersedes it: a superseded
 * request never starts playing and never reports an error.
 *
 * Long texts come in parts (docs/api-v1.md, "Speech in parts"): the first
 * part's answer says how many there are, and the parts play one after
 * another under the same key, the next one downloading while the current one
 * plays. Stopping stops the whole sequence.
 *
 * Pure: services/speech.ts injects the download and the audio player, and
 * pages mirror `status()` to draw <t-speak-icon>.
 */

export type SpeechPhase = 'idle' | 'loading' | 'playing'

/** What is sounding. `key` is '' exactly when `phase` is 'idle'. */
export interface SpeechStatus {
  readonly key: string
  readonly phase: SpeechPhase
  /** For a text of several parts: the part sounding or loading (1-based) and how many there are. */
  readonly part?: number
  readonly parts?: number
}

export const SPEECH_IDLE: SpeechStatus = { key: '', phase: 'idle' }

/** The phase of the button that plays `key`: idle unless that key is the one sounding. */
export function speechPhase(status: SpeechStatus, key: string): SpeechPhase {
  return key !== '' && status.key === key ? status.phase : 'idle'
}

/** "2/9" while part 2 of 9 of `key` sounds; '' for a single part or another key. */
export function speechProgress(status: SpeechStatus, key: string): string {
  if (speechPhase(status, key) === 'idle' || status.part === undefined || status.parts === undefined) return ''
  return status.parts > 1 ? `${status.part}/${status.parts}` : ''
}

export interface Playback {
  /** Resolves when the audio ends or is stopped; rejects when it fails. */
  readonly done: Promise<void>
  stop(): void
}

/** A downloaded part: its local file and how many parts the text has (1 for a short text or an older server). */
export interface LoadedPart {
  readonly path: string
  readonly parts: number
}

export interface SpeakerDeps<S> {
  /**
   * The local audio file of part `part` (0-based) of `source`, downloaded
   * when needed; null when the text has no such part (the sequence ends).
   */
  readonly load: (source: S, key: string, part: number) => Promise<LoadedPart | null>
  /** Starts playing a local file. */
  readonly play: (path: string) => Playback
}

export type SpeechListener = (status: SpeechStatus) => void

export interface Speaker<S> {
  status(): SpeechStatus
  /** Calls `listener` on every change; returns the unsubscribe function. */
  watch(listener: SpeechListener): () => void
  /** Plays every part of `key`, replacing whatever sounds. Settles when it ends, is stopped or is superseded. */
  speak(source: S, key: string): Promise<void>
  /** A speaker button's tap: stops `key` while it loads or plays, else plays it. */
  toggle(source: S, key: string): Promise<void>
  stop(): void
}

/** Most parts one text is read in; a guard against a server that never stops counting. */
export const MAX_SPEECH_PARTS = 100

const sameStatus = (a: SpeechStatus, b: SpeechStatus): boolean =>
  a.key === b.key && a.phase === b.phase && a.part === b.part && a.parts === b.parts

const statusOf = (key: string, phase: SpeechPhase, part: number, parts: number): SpeechStatus =>
  parts > 1 ? { key, phase, part: part + 1, parts } : { key, phase }

/** A load whose settling can be checked synchronously; its rejection is never left unhandled. */
interface PendingLoad {
  readonly promise: Promise<LoadedPart | null>
  settled: boolean
}

const track = (promise: Promise<LoadedPart | null>): PendingLoad => {
  const pending: PendingLoad = { promise, settled: false }
  promise.then(
    () => {
      pending.settled = true
    },
    () => {
      pending.settled = true
    },
  )
  return pending
}

export function createSpeaker<S>(deps: SpeakerDeps<S>): Speaker<S> {
  let status = SPEECH_IDLE
  let playback: Playback | null = null
  /** Bumped by every request and stop; a request acts only while it is the latest. */
  let requests = 0
  const listeners = new Set<SpeechListener>()

  const set = (next: SpeechStatus): void => {
    if (sameStatus(next, status)) return
    status = next
    for (const listener of [...listeners]) listener(next)
  }

  const halt = (): void => {
    const current = playback
    playback = null
    current?.stop()
  }

  const stop = (): void => {
    requests += 1
    halt()
    set(SPEECH_IDLE)
  }

  const speak = async (source: S, key: string): Promise<void> => {
    if (key === '') return
    requests += 1
    const mine = requests
    const latest = (): boolean => mine === requests
    halt()
    set({ key, phase: 'loading' })
    try {
      let next = track(deps.load(source, key, 0))
      let parts = 1
      for (let part = 0; part < Math.min(parts, MAX_SPEECH_PARTS); part += 1) {
        if (!next.settled) set(statusOf(key, 'loading', part, parts))
        const loaded = await next.promise
        if (!latest() || loaded === null) return
        if (part === 0) parts = Math.max(1, Math.floor(loaded.parts))
        // The next part downloads while this one plays, so the parts follow without a gap.
        if (part + 1 < Math.min(parts, MAX_SPEECH_PARTS)) next = track(deps.load(source, key, part + 1))
        const current = deps.play(loaded.path)
        playback = current
        set(statusOf(key, 'playing', part, parts))
        await current.done
        if (!latest()) return
        playback = null
      }
    } catch (error: unknown) {
      if (latest()) throw error
    } finally {
      if (latest()) {
        playback = null
        set(SPEECH_IDLE)
      }
    }
  }

  return {
    status: () => status,
    watch(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    speak,
    toggle(source, key) {
      if (speechPhase(status, key) === 'idle') return speak(source, key)
      stop()
      return Promise.resolve()
    },
    stop,
  }
}
