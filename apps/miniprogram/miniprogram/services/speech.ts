/**
 * 朗读: `POST /v1/tts` → an mp3 under `wx.env.USER_DATA_PATH` → one shared
 * InnerAudioContext. The server picks the text to read (docs/api-v1.md
 * "Speech"), so the client only ever sends the id of the user's own record,
 * card, item or material, or a lemma of the shared lexicon.
 *
 * Long texts are read in parts ("Speech in parts"): part 0's answer carries
 * `X-Speech-Parts`, and the speaker (lib/speaker.ts) fetches and plays parts
 * 1…N-1 in turn under the same key. Part 0 is requested without `part`, so an
 * older server (no headers: one part) answers as before. Each part is its own
 * cached file; the part count of a cached text is remembered in storage.
 *
 * One sound at a time, named by its key (the cache key). Which key is loading
 * or playing is the speaker's status (lib/speaker.ts): pages mirror it with
 * `watchSpeech` and draw it with <t-speak-icon>; a button's tap is
 * `toggleSpeech`, so tapping what sounds stops it.
 */
import { ApiError, isApiError, parseEnvelope } from '../lib/api'
import {
  createSpeaker,
  type LoadedPart,
  type Playback,
  type SpeechListener,
  type SpeechStatus,
} from '../lib/speaker'
import { filesToEvict, ttsFileName, type CachedFile } from '../lib/tts-cache'
import { createUtf8Decoder } from '../lib/utf8'
import { readSpeechParts } from '../lib/wire'
import { transportError } from './http'
import { api } from './session'

const TTS_TIMEOUT_MS = 20_000

/**
 * What `POST /v1/tts` reads: a record, a learning unit, a card, the story of
 * a daily material or digest, an extension's passage or one of its items
 * (0-based `index`), or a lexicon entry (单词详情: the lemma, or its example
 * at 0-based index `example`).
 */
export type SpeechSource =
  | { readonly entryId: string }
  | { readonly itemId: string }
  | { readonly cardId: string }
  | { readonly material: { readonly kind: 'daily' | 'digest'; readonly date: string; readonly section: 'story' } }
  | { readonly material: { readonly kind: 'extend'; readonly date: string; readonly section: 'passage' } }
  | { readonly material: { readonly kind: 'extend'; readonly date: string; readonly section: 'item'; readonly index: number } }
  | { readonly lexicon: { readonly lemma: string; readonly example?: number } }

const fs = (): WechatMiniprogram.FileSystemManager => wx.getFileSystemManager()

const fileExists = (path: string): boolean => {
  try {
    fs().accessSync(path)
    return true
  } catch {
    return false
  }
}

const decodeText = (data: unknown): unknown => {
  if (!(data instanceof ArrayBuffer)) return data
  const decoder = createUtf8Decoder()
  return decoder.decode(data) + decoder.flush()
}

interface FetchedAudio {
  readonly audio: ArrayBuffer
  /** From `X-Speech-Parts`; null without the header (an older server reads the whole text at once). */
  readonly parts: number | null
}

/** Part 0 goes without `part`: an older server rejects the unknown key, a newer one defaults to 0. */
const ttsBody = (source: SpeechSource, part: number): string =>
  JSON.stringify(part === 0 ? source : { ...source, part })

const fetchAudio = (accessToken: string, source: SpeechSource, part: number): Promise<FetchedAudio> =>
  new Promise((resolve, reject) => {
    wx.request({
      url: `${api.baseUrl}/v1/tts`,
      method: 'POST',
      header: {
        accept: 'audio/mpeg',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      data: ttsBody(source, part),
      responseType: 'arraybuffer',
      timeout: TTS_TIMEOUT_MS,
      success: (response) => {
        const data: unknown = response.data
        if (response.statusCode === 200 && data instanceof ArrayBuffer && data.byteLength > 0) {
          resolve({ audio: data, parts: readSpeechParts(response.header)?.parts ?? null })
          return
        }
        try {
          parseEnvelope(response.statusCode, decodeText(data))
          reject(new ApiError({ kind: 'protocol', code: 'BAD_RESPONSE', message: 'empty audio' }))
        } catch (error: unknown) {
          reject(error)
        }
      },
      fail: (error) => reject(transportError(error.errMsg)),
    })
  })

const writeFile = (path: string, data: ArrayBuffer): Promise<void> =>
  new Promise((resolve, reject) => {
    fs().writeFile({
      filePath: path,
      data,
      success: () => resolve(),
      fail: (error) => reject(new ApiError({ kind: 'protocol', code: 'LOCAL_FILE', message: error.errMsg })),
    })
  })

/** Keeps the newest few audio files; failures only cost disk space. */
const evictOldAudio = (): void => {
  try {
    const dir = wx.env.USER_DATA_PATH
    const files: CachedFile[] = fs()
      .readdirSync(dir)
      .filter((name) => name.endsWith('.mp3'))
      .map((name) => {
        const stats = fs().statSync(`${dir}/${name}`) as WechatMiniprogram.Stats
        return { name, modified: stats.lastModifiedTime }
      })
    for (const name of filesToEvict(files)) fs().unlinkSync(`${dir}/${name}`)
  } catch (error: unknown) {
    console.warn('[speech] cache cleanup failed', error)
  }
}

// ---- part counts ----

/** Part counts of texts read in several parts, by key; a text not listed has one part. */
const PARTS_KEY = 'tcli:tts:parts'
/** More entries than cached files (TTS_KEEP_FILES): a cached first part never outlives its count. */
const MAX_PART_COUNTS = 60

const readPartCounts = (): Record<string, number> => {
  try {
    const value: unknown = wx.getStorageSync(PARTS_KEY)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const counts: Record<string, number> = {}
    for (const [key, parts] of Object.entries(value as Record<string, unknown>)) {
      if (typeof parts === 'number' && Number.isInteger(parts) && parts > 1) counts[key] = parts
    }
    return counts
  } catch {
    return {}
  }
}

let partCounts: Record<string, number> | null = null

const knownParts = (key: string): number => {
  partCounts ??= readPartCounts()
  return partCounts[key] ?? 1
}

/** Records a text's part count (only counts above one are kept, the newest MAX_PART_COUNTS). */
const rememberParts = (key: string, parts: number): void => {
  const current = partCounts ?? readPartCounts()
  if ((current[key] ?? 1) === parts) {
    partCounts = current
    return
  }
  const others = Object.keys(current).filter((other) => other !== key)
  const keys = parts > 1 ? [...others, key] : others
  const next: Record<string, number> = {}
  for (const kept of keys.slice(Math.max(0, keys.length - MAX_PART_COUNTS))) {
    next[kept] = kept === key ? parts : (current[kept] ?? 1)
  }
  partCounts = next
  try {
    wx.setStorageSync(PARTS_KEY, next)
  } catch (error: unknown) {
    console.warn('[speech] could not store part counts', error)
  }
}

// ---- downloads ----

/** Part 0 keeps the name it had before texts came in parts; later parts add their number. */
const partFileName = (key: string, part: number): string => ttsFileName(part === 0 ? key : `${key}-p${part}`)

const downloads = new Map<string, Promise<LoadedPart>>()

/**
 * The local mp3 of one part of `source`, fetched once (concurrent callers
 * share the download). `key` names the file; review keys carry a fingerprint
 * of the text, because a reported card or item is rewritten under the same id.
 */
const audioPart = (source: SpeechSource, key: string, part: number): Promise<LoadedPart> => {
  const path = `${wx.env.USER_DATA_PATH}/${partFileName(key, part)}`
  if (fileExists(path)) return Promise.resolve({ path, parts: knownParts(key) })
  const running = downloads.get(path)
  if (running !== undefined) return running
  const download = api
    .authorized((token) => fetchAudio(token, source, part))
    .then(async (fetched) => {
      await writeFile(path, fetched.audio)
      // Without the header part 0 is the whole text; a later part keeps the count part 0 gave.
      const parts = fetched.parts ?? (part === 0 ? 1 : knownParts(key))
      if (fetched.parts !== null || part === 0) rememberParts(key, parts)
      evictOldAudio()
      return { path, parts }
    })
    .finally(() => downloads.delete(path))
  downloads.set(path, download)
  return download
}

/** A later part the text turned out not to have (its count changed): the sequence ends there. */
const loadPart = async (source: SpeechSource, key: string, part: number): Promise<LoadedPart | null> => {
  try {
    return await audioPart(source, key, part)
  } catch (error: unknown) {
    if (part === 0 || !isApiError(error) || error.code !== 'PART_OUT_OF_RANGE') throw error
    const details = error.details
    const parts = typeof details === 'object' && details !== null ? (details as { parts?: unknown }).parts : undefined
    rememberParts(key, typeof parts === 'number' && Number.isInteger(parts) && parts >= 1 ? parts : 1)
    return null
  }
}

let audioOptionsSet = false

const startPlayback = (path: string): Playback => {
  if (!audioOptionsSet) {
    // Reading aloud is the point of the tap: play even with the silent switch on.
    wx.setInnerAudioOption({ obeyMuteSwitch: false, fail: () => undefined })
    audioOptionsSet = true
  }
  let resolve: () => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const done = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  const context = wx.createInnerAudioContext()
  let open = true
  const close = (): void => {
    if (!open) return
    open = false
    context.destroy()
  }
  context.src = path
  context.onEnded(() => {
    close()
    resolve()
  })
  context.onStop(() => resolve())
  context.onError((error) => {
    close()
    reject(new ApiError({ kind: 'protocol', code: 'AUDIO_PLAYBACK', message: error.errMsg }))
  })
  context.play()
  return {
    done,
    stop: () => {
      if (open) context.stop()
      close()
      resolve()
    },
  }
}

const speaker = createSpeaker<SpeechSource>({ load: loadPart, play: startPlayback })

export function speechStatus(): SpeechStatus {
  return speaker.status()
}

/** Calls `listener` whenever a sound starts loading, starts playing or stops. */
export function watchSpeech(listener: SpeechListener): () => void {
  return speaker.watch(listener)
}

/** Plays `source`, every part in turn (automatic reading). Settles when it ends, is stopped or is replaced. */
export function speak(source: SpeechSource, key: string): Promise<void> {
  return speaker.speak(source, key)
}

/** A speaker button's tap: stops `key` (all its parts) while it loads or plays, else plays it. */
export function toggleSpeech(source: SpeechSource, key: string): Promise<void> {
  return speaker.toggle(source, key)
}

/** Stops playback; audio still downloading will not play. */
export function stopSpeaking(): void {
  speaker.stop()
}

/** Fetches the audio ahead of time (a review card's, while its front shows): the first part. */
export async function prefetchSpeech(source: SpeechSource, key: string): Promise<void> {
  await audioPart(source, key, 0)
}

/** The key of a learning unit's audio on the 学习单元 page. */
export function itemSpeechKey(itemId: string): string {
  return `item-${itemId}`
}
