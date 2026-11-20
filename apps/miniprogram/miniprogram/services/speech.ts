/**
 * 朗读: `POST /v1/tts` by entry or item id → an mp3 under
 * `wx.env.USER_DATA_PATH` → one shared InnerAudioContext. A new playback
 * replaces the current one. The server picks the text to read (docs/api-v1.md
 * "Speech"), so the client only ever sends the id of the user's own record.
 */
import { ApiError, parseEnvelope } from '../lib/api'
import { filesToEvict, ttsFileName, type CachedFile } from '../lib/tts-cache'
import { createUtf8Decoder } from '../lib/utf8'
import { transportError } from './http'
import { api } from './session'

const TTS_TIMEOUT_MS = 20_000

let player: WechatMiniprogram.InnerAudioContext | null = null
let audioOptionsSet = false

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

/** What `POST /v1/tts` reads: a record, or a learning unit (headword / phrase / corrected sentence). */
type TtsSource = { readonly entryId: string } | { readonly itemId: string }

const fetchAudio = (accessToken: string, source: TtsSource): Promise<ArrayBuffer> =>
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

export function stopSpeaking(): void {
  if (player === null) return
  player.stop()
  player.destroy()
  player = null
}

const play = (path: string): Promise<void> =>
  new Promise((resolve, reject) => {
    stopSpeaking()
    if (!audioOptionsSet) {
      // Reading aloud is the point of the tap: play even with the silent switch on.
      wx.setInnerAudioOption({ obeyMuteSwitch: false, fail: () => undefined })
      audioOptionsSet = true
    }
    const context = wx.createInnerAudioContext()
    player = context
    context.src = path
    context.onEnded(() => {
      if (player === context) stopSpeaking()
      resolve()
    })
    context.onStop(() => resolve())
    context.onError((error) => {
      if (player === context) stopSpeaking()
      reject(new ApiError({ kind: 'protocol', code: 'AUDIO_PLAYBACK', message: error.errMsg }))
    })
    context.play()
  })

const speak = async (source: TtsSource, cacheKey: string): Promise<void> => {
  const path = `${wx.env.USER_DATA_PATH}/${ttsFileName(cacheKey)}`
  if (!fileExists(path)) {
    const audio = await api.authorized((token) => fetchAudio(token, source))
    await writeFile(path, audio)
    evictOldAudio()
  }
  await play(path)
}

/** Plays the entry's audio, fetching it once. Resolves when playback ends or is replaced. */
export function speakEntry(entryId: string): Promise<void> {
  return speak({ entryId }, entryId)
}

/** Plays a learning unit's audio (学习单元 ▶), fetching it once. */
export function speakItem(itemId: string): Promise<void> {
  return speak({ itemId }, `item-${itemId}`)
}

// ---- Review sources: cards, material items, the daily story ----
// Kept apart from the entry code above (no shared lines changed), so parallel
// additions to this file merge cleanly. docs/api-v1.md, "Speech (extended)".

/** What `POST /v1/tts` reads besides an entry: the account's own card, item or story. */
export type ReviewSpeechSource =
  | { readonly cardId: string }
  | { readonly itemId: string }
  | { readonly material: { readonly kind: 'daily'; readonly date: string; readonly section: 'story' } }

const fetchSourceAudio = (accessToken: string, source: ReviewSpeechSource): Promise<ArrayBuffer> =>
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

const sourceDownloads = new Map<string, Promise<string>>()

/**
 * The local mp3 for `source`, fetched once (concurrent callers share the
 * download). `cacheKey` names the file: an id plus a fingerprint of the text,
 * because a reported card or item is rewritten under the same id.
 */
const sourceAudioFile = (source: ReviewSpeechSource, cacheKey: string): Promise<string> => {
  const path = `${wx.env.USER_DATA_PATH}/${ttsFileName(cacheKey)}`
  if (fileExists(path)) return Promise.resolve(path)
  const running = sourceDownloads.get(path)
  if (running !== undefined) return running
  const download = api
    .authorized((token) => fetchSourceAudio(token, source))
    .then((audio) => writeFile(path, audio))
    .then(() => {
      evictOldAudio()
      return path
    })
    .finally(() => sourceDownloads.delete(path))
  sourceDownloads.set(path, download)
  return download
}

/** Bumped by every request and stop: a download finishing late never plays over a newer one. */
let sourcePlays = 0

/** Plays `source`, fetching it once. Resolves when playback ends, is replaced or was superseded. */
export async function speakSource(source: ReviewSpeechSource, cacheKey: string): Promise<void> {
  sourcePlays += 1
  const mine = sourcePlays
  const path = await sourceAudioFile(source, cacheKey)
  if (mine !== sourcePlays) return
  await play(path)
}

/** Fetches the audio ahead of time (a review card's, while its front shows). */
export async function prefetchSource(source: ReviewSpeechSource, cacheKey: string): Promise<void> {
  await sourceAudioFile(source, cacheKey)
}

/** Stops playback and cancels review audio still downloading. */
export function stopSourceSpeech(): void {
  sourcePlays += 1
  stopSpeaking()
}
