/**
 * Voice input through the WeChat 同声传译 (WechatSI) plugin: hold the mic,
 * speak, release.
 *
 * Currently OFF: the admin console cannot find the plugin for this account
 * (search by AppID wx069ba97219f66d99 returns nothing), and a plugin declared
 * in app.json but not authorized stops the whole app. So app.json declares no
 * plugin, `requirePlugin` throws, `voiceAvailable()` is false and the pages
 * hide the mic; the keyboard's own voice input still works. To turn it back
 * on, add the plugin in the admin console and declare it in app.json again
 * (`"plugins": { "WechatSI": { "version": "<listed version>", "provider":
 * "wx069ba97219f66d99" } }`).
 */

export type VoiceLang = 'zh_CN' | 'en_US'

interface RecognitionResult {
  readonly result?: string
}

interface RecognitionError {
  readonly retcode?: number
  readonly msg?: string
}

/** The part of the plugin's RecordRecognitionManager used here. */
interface RecognitionManager {
  start(options: { duration?: number; lang?: VoiceLang }): void
  stop(): void
  onStart: (() => void) | null
  onRecognize: ((result: RecognitionResult) => void) | null
  onStop: ((result: RecognitionResult) => void) | null
  onError: ((error: RecognitionError) => void) | null
}

export interface VoiceHandlers {
  /** Interim text while the user is still speaking. */
  onPartial(text: string): void
  /** Final text after release (may be empty when nothing was understood). */
  onFinal(text: string): void
  onError(message: string): void
}

/** The plugin's maximum. */
const MAX_DURATION_MS = 60_000

let manager: RecognitionManager | null | undefined

const getManager = (): RecognitionManager | null => {
  if (manager !== undefined) return manager
  try {
    const plugin: unknown = requirePlugin('WechatSI')
    const factory = (plugin as { getRecordRecognitionManager?: unknown }).getRecordRecognitionManager
    manager = typeof factory === 'function' ? (factory.call(plugin) as RecognitionManager) : null
  } catch (error: unknown) {
    console.warn('[voice] WechatSI plugin unavailable', error)
    manager = null
  }
  return manager
}

export function voiceAvailable(): boolean {
  return getManager() !== null
}

const errorText = (error: RecognitionError): string => {
  const message = error.msg ?? ''
  if (/auth|permission|deny/i.test(message)) return '需要麦克风权限，可在右上角 ··· → 设置 中开启'
  return '没听清，请再说一次'
}

/** Starts listening; returns false when voice input is unavailable. */
export function startVoice(lang: VoiceLang, handlers: VoiceHandlers): boolean {
  const recognizer = getManager()
  if (recognizer === null) {
    handlers.onError('语音输入不可用')
    return false
  }
  // One manager serves every page: the handlers of the page that started last win.
  recognizer.onRecognize = (result) => handlers.onPartial(result.result ?? '')
  recognizer.onStop = (result) => handlers.onFinal((result.result ?? '').trim())
  recognizer.onError = (error) => handlers.onError(errorText(error))
  recognizer.start({ duration: MAX_DURATION_MS, lang })
  return true
}

export function stopVoice(): void {
  getManager()?.stop()
}
