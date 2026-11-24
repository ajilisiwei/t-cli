/**
 * 朗读: `POST /v1/tts` → an mp3 under `wx.env.USER_DATA_PATH` → one shared
 * InnerAudioContext. The server picks the text to read (docs/api-v1.md
 * "Speech"), so the client only ever sends the id of the user's own record,
 * card, item or material.
 *
 * One sound at a time, named by its key (the cache key). Which key is loading
 * or playing is the speaker's status (lib/speaker.ts): pages mirror it with
 * `watchSpeech` and draw it with <t-speak-icon>; a button's tap is
 * `toggleSpeech`, so tapping what sounds stops it.
 */
import { ApiError, parseEnvelope } from '../lib/api'
import { createSpeaker, type Playback, type SpeechListener, type SpeechStatus } from '../lib/speaker'
import { filesToEvict, ttsFileName, type CachedFile } from '../lib/tts-cache'
import { createUtf8Decoder } from '../lib/utf8'
import { transportError } from './http'
import { api } from './session'

const TTS_TIMEOUT_MS = 20_000

/** What `POST /v1/tts` reads: a record, a learning unit, a card or the daily story. */
export type SpeechSource =
  | { readonly entryId: string }
  | { readonly itemId: string }
  | { readonly cardId: string }
  | { readonly material: { readonly kind: 'daily'; readonly date: string; readonly section: 'story' } }

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

const fetchAudio = (accessToken: string, source: SpeechSource): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    wx.request({
      url: `${api.baseUrl}/v1/tts`,
      method: 'POST',
      header: {
        accept: 'audio/mpeg',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      data: JSON.stringify(source),
      responseType: 'arraybuffer',
      timeout: TTS_TIMEOUT_MS,
      success: (response) => {
        const data: unknown = response.data
        if (response.statusCode === 200 && data instanceof ArrayBuffer && data.byteLength > 0) {
          resolve(data)
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

const downloads = new Map<string, Promise<string>>()

/**
 * The local mp3 for `source`, fetched once (concurrent callers share the
 * download). `key` names the file; review keys carry a fingerprint of the
 * text, because a reported card or item is rewritten under the same id.
 */
const audioFile = (source: SpeechSource, key: string): Promise<string> => {
  const path = `${wx.env.USER_DATA_PATH}/${ttsFileName(key)}`
  if (fileExists(path)) return Promise.resolve(path)
  const running = downloads.get(path)
  if (running !== undefined) return running
  const download = api
    .authorized((token) => fetchAudio(token, source))
    .then((audio) => writeFile(path, audio))
    .then(() => {
      evictOldAudio()
      return path
    })
    .finally(() => downloads.delete(path))
  downloads.set(path, download)
  return download
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

const speaker = createSpeaker<SpeechSource>({ load: audioFile, play: startPlayback })

export function speechStatus(): SpeechStatus {
  return speaker.status()
}

/** Calls `listener` whenever a sound starts loading, starts playing or stops. */
export function watchSpeech(listener: SpeechListener): () => void {
  return speaker.watch(listener)
}

/** Plays `source` (automatic reading). Settles when it ends, is stopped or is replaced. */
export function speak(source: SpeechSource, key: string): Promise<void> {
  return speaker.speak(source, key)
}

/** A speaker button's tap: stops `key` while it loads or plays, else plays it. */
export function toggleSpeech(source: SpeechSource, key: string): Promise<void> {
  return speaker.toggle(source, key)
}

/** Stops playback; audio still downloading will not play. */
export function stopSpeaking(): void {
  speaker.stop()
}

/** Fetches the audio ahead of time (a review card's, while its front shows). */
export async function prefetchSpeech(source: SpeechSource, key: string): Promise<void> {
  await audioFile(source, key)
}

/** The key of a learning unit's audio on the 学习单元 page. */
export function itemSpeechKey(itemId: string): string {
  return `item-${itemId}`
}
