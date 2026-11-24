/**
 * 翻译 (default tab): one input, one result.
 *
 * The keyboard's send key submits; the server decides the direction and the
 * `meta` line labels it; tapping the label re-runs this text once in the
 * opposite direction. Simple mode only — explanations live elsewhere.
 */
import { errorMessage } from '../../lib/api'
import { codePointLength, parseWordHeadline, type WordHeadline } from '../../lib/output'
import {
  directionLabel,
  flipDirection,
  isBusy,
  outputIsEnglish,
  speechKey,
  type ResultState,
  type ResultStatus,
} from '../../lib/result'
import { speechPhase, type SpeechPhase, type SpeechStatus } from '../../lib/speaker'
import type { Direction } from '../../lib/types'
import { takeTranslationHandOff } from '../../services/handoff'
import { utcOffsetMinutes } from '../../services/platform'
import { createResultRunner, type ResultRunner, type RunnerView } from '../../services/result-runner'
import { autoSpeakWord, explanationLang } from '../../services/settings'
import { speak, speechStatus, toggleSpeech, watchSpeech } from '../../services/speech'
import { currentTheme, watchTheme, type Theme } from '../../services/theme'
import { toast } from '../../services/ui'
import { startVoice, stopVoice, voiceAvailable } from '../../services/voice'

const MAX_INPUT_CODE_POINTS = 2000

interface ResultView {
  status: ResultStatus
  text: string
  label: string
  headline: WordHeadline | null
  english: boolean
  busy: boolean
  canSpeak: boolean
  speakPhase: SpeechPhase
  errorText: string
}

interface TranslateData extends ResultView {
  theme: Theme
  input: string
  focus: boolean
  /** The input has focus: the composer border turns indigo. */
  focused: boolean
  /** The mic is shown only when the WechatSI plugin is declared and authorized. */
  voiceEnabled: boolean
  recording: boolean
}

const resultView = ({ state, errorText }: RunnerView, speech: SpeechStatus): ResultView => ({
  status: state.status,
  text: state.text,
  label: directionLabel(state.srcLang),
  headline: state.kind === 'word' ? parseWordHeadline(state.text) : null,
  english: outputIsEnglish(state.srcLang),
  busy: isBusy(state),
  canSpeak: speechKey(state) !== '',
  speakPhase: speechPhase(speech, speechKey(state)),
  errorText,
})

const initialData: TranslateData = {
  theme: currentTheme(),
  input: '',
  focus: true,
  focused: false,
  voiceEnabled: false,
  recording: false,
  status: 'idle',
  text: '',
  label: '',
  headline: null,
  english: false,
  busy: false,
  canSpeak: false,
  speakPhase: 'idle',
  errorText: '',
}

Page({
  data: initialData,
  runner: null as ResultRunner | null,
  /** The text of the shown result: what a direction flip re-runs. */
  lastText: '',
  /** The word result already read aloud automatically (each one once). */
  autoSpokenId: '',
  stopWatchingTheme: null as (() => void) | null,
  stopWatchingSpeech: null as (() => void) | null,

  onLoad() {
    this.runner = createResultRunner((view) => {
      this.setData(resultView(view, speechStatus()))
      this.autoSpeak(view.state)
    })
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    this.stopWatchingSpeech = watchSpeech((speech) => this.syncSpeech(speech))
    this.setData({ theme: currentTheme(), voiceEnabled: voiceAvailable() })
  },

  onShow() {
    const handedOff = takeTranslationHandOff()
    if (handedOff !== null) {
      this.setData({ input: handedOff })
      this.translate(handedOff)
    }
  },

  onUnload() {
    this.stopWatchingTheme?.()
    this.stopWatchingSpeech?.()
    this.runner?.reset()
  },

  onInput(event: WechatMiniprogram.TextareaInput) {
    this.setData({ input: event.detail.value })
  },

  /** The keyboard's send key (`confirm-type="send"`). */
  onSubmit(event: WechatMiniprogram.TextareaConfirm) {
    this.translate(event.detail.value)
  },
  /** The send button: same as the keyboard's send key. */
  onSend() {
    this.translate(this.data.input)
  },
  onFocus() {
    this.setData({ focused: true })
  },
  onBlur() {
    this.setData({ focused: false })
  },

  onClear() {
    this.runner?.reset()
    this.lastText = ''
    this.setData({ input: '', focus: false }, () => this.setData({ focus: true }))
  },

  onFlip() {
    const state = this.runner?.current().state
    if (state === undefined || isBusy(state) || state.srcLang === null || this.lastText === '') return
    this.translate(this.lastText, flipDirection(state.srcLang))
  },

  onStop() {
    this.runner?.stop()
  },

  onSpeak() {
    const state = this.runner?.current().state
    const key = state === undefined ? '' : speechKey(state)
    if (key === '') return
    toggleSpeech({ entryId: key }, key).catch((error: unknown) => toast(errorMessage(error)))
  },

  syncSpeech(speech: SpeechStatus) {
    const state = this.runner?.current().state
    const speakPhase = speechPhase(speech, state === undefined ? '' : speechKey(state))
    if (speakPhase !== this.data.speakPhase) this.setData({ speakPhase })
  },

  /** 单词自动朗读: a finished word lookup is read aloud once, when the setting is on. */
  autoSpeak(state: ResultState) {
    if (state.status !== 'done' || state.kind !== 'word' || state.entryId === null) return
    if (state.entryId === this.autoSpokenId || !autoSpeakWord()) return
    this.autoSpokenId = state.entryId
    speak({ entryId: state.entryId }, state.entryId).catch((error: unknown) =>
      console.warn('[translate] auto speak failed', error),
    )
  },

  onCopy() {
    const text = this.runner?.current().state.text.trim() ?? ''
    if (text !== '') wx.setClipboardData({ data: text, fail: () => undefined })
  },

  onMicStart() {
    if (this.data.recording) return
    const started = startVoice('zh_CN', {
      onPartial: (text) => this.setData({ input: text }),
      onFinal: (text) => {
        this.setData({ recording: false })
        if (text === '') return
        this.setData({ input: text })
        this.translate(text)
      },
      onError: (message) => {
        this.setData({ recording: false })
        toast(message)
      },
    })
    if (started) this.setData({ recording: true })
  },

  onMicEnd() {
    if (!this.data.recording) return
    this.setData({ recording: false })
    stopVoice()
  },

  translate(raw: string, direction?: Direction) {
    const text = raw.trim()
    if (text === '' || this.runner === null) return
    if (codePointLength(text) > MAX_INPUT_CODE_POINTS) {
      toast(`最多 ${MAX_INPUT_CODE_POINTS} 字`)
      return
    }
    this.lastText = text
    void this.runner.run({
      text,
      task: 'translate',
      mode: 'simple',
      lang: explanationLang(),
      utcOffsetMinutes: utcOffsetMinutes(),
      ...(direction === undefined ? {} : { direction }),
    })
  },
})
