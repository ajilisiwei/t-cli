/**
 * 朗读 state shared by every speaker button: one sound at a time, named by a
 * key (its audio cache key). A request goes loading (fetching the audio) →
 * playing → idle. A newer request or stop() supersedes it: a superseded
 * request never starts playing and never reports an error.
 *
 * Pure: services/speech.ts injects the download and the audio player, and
 * pages mirror `status()` to draw <t-speak-icon>.
 */

export type SpeechPhase = 'idle' | 'loading' | 'playing'

/** What is sounding. `key` is '' exactly when `phase` is 'idle'. */
export interface SpeechStatus {
  readonly key: string
  readonly phase: SpeechPhase
}

export const SPEECH_IDLE: SpeechStatus = { key: '', phase: 'idle' }

/** The phase of the button that plays `key`: idle unless that key is the one sounding. */
export function speechPhase(status: SpeechStatus, key: string): SpeechPhase {
  return key !== '' && status.key === key ? status.phase : 'idle'
}

export interface Playback {
  /** Resolves when the audio ends or is stopped; rejects when it fails. */
  readonly done: Promise<void>
  stop(): void
}

export interface SpeakerDeps<S> {
  /** The local audio file for `source`, downloaded when needed. */
  readonly load: (source: S, key: string) => Promise<string>
  /** Starts playing a local file. */
  readonly play: (path: string) => Playback
}

export type SpeechListener = (status: SpeechStatus) => void

export interface Speaker<S> {
  status(): SpeechStatus
  /** Calls `listener` on every change; returns the unsubscribe function. */
  watch(listener: SpeechListener): () => void
  /** Plays `key`, replacing whatever sounds. Settles when it ends, is stopped or is superseded. */
  speak(source: S, key: string): Promise<void>
  /** A speaker button's tap: stops `key` while it loads or plays, else plays it. */
  toggle(source: S, key: string): Promise<void>
  stop(): void
}

export function createSpeaker<S>(deps: SpeakerDeps<S>): Speaker<S> {
  let status = SPEECH_IDLE
  let playback: Playback | null = null
  /** Bumped by every request and stop; a request acts only while it is the latest. */
  let requests = 0
  const listeners = new Set<SpeechListener>()

  const set = (next: SpeechStatus): void => {
    if (next.key === status.key && next.phase === status.phase) return
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
    halt()
    set({ key, phase: 'loading' })
    try {
      const path = await deps.load(source, key)
      if (mine !== requests) return
      const current = deps.play(path)
      playback = current
      set({ key, phase: 'playing' })
      await current.done
    } catch (error: unknown) {
      if (mine === requests) throw error
    } finally {
      if (mine === requests) {
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
