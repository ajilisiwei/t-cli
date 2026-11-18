/**
 * 翻译 (default tab): one input, one result.
 *
 * The keyboard's send key submits; the server decides the direction and the
 * `meta` line labels it; tapping the label re-runs this text once in the
 * opposite direction. Simple mode only — explanations live elsewhere.
 */
import { errorMessage } from '../../lib/api'
import { codePointLength, parseWordHeadline, type WordHeadline } from '../../lib/output'
import { directionLabel, flipDirection, isBusy, outputIsEnglish, type ResultStatus } from '../../lib/result'
import type { Direction } from '../../lib/types'
import { takeTranslationHandOff } from '../../services/handoff'
import { utcOffsetMinutes } from '../../services/platform'
import { createResultRunner, type ResultRunner, type RunnerView } from '../../services/result-runner'
import { explanationLang } from '../../services/settings'
import { speakEntry } from '../../services/speech'
import { currentTheme, watchTheme, type Theme } from '../../services/theme'
import { toast } from '../../services/ui'
import { startVoice, stopVoice } from '../../services/voice'

const MAX_INPUT_CODE_POINTS = 2000

interface ResultView {
  status: ResultStatus
  text: string
  label: string
  headline: WordHeadline | null
  english: boolean
  busy: boolean
  canSpeak: boolean
  errorText: string
}

interface TranslateData extends ResultView {
  theme: Theme
  input: string
  focus: boolean
  recording: boolean
}

const resultView = ({ state, errorText }: RunnerView): ResultView => ({
  status: state.status,
  text: state.text,
  label: directionLabel(state.srcLang),
  headline: state.kind === 'word' ? parseWordHeadline(state.text) : null,
  english: outputIsEnglish(state.srcLang),
  busy: isBusy(state),
  canSpeak: state.status === 'done' && state.entryId !== null,
  errorText,
})

const initialData: TranslateData = {
  theme: currentTheme(),
  input: '',
  focus: true,
  recording: false,
  status: 'idle',
  text: '',
  label: '',
  headline: null,
  english: false,
  busy: false,
  canSpeak: false,
  errorText: '',
}

Page({
  data: initialData,
  runner: null as ResultRunner | null,
  /** The text of the shown result: what a direction flip re-runs. */
  lastText: '',
  stopWatchingTheme: null as (() => void) | null,

  onLoad() {
    this.runner = createResultRunner((view) => this.setData(resultView(view)))
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    this.setData({ theme: currentTheme() })
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
    this.runner?.reset()
  },

  onInput(event: WechatMiniprogram.TextareaInput) {
    this.setData({ input: event.detail.value })
  },

  /** The keyboard's send key (`confirm-type="send"`). */
  onSubmit(event: WechatMiniprogram.TextareaConfirm) {
    this.translate(event.detail.value)
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
    if (state === undefined || state.status !== 'done' || state.entryId === null) return
    speakEntry(state.entryId).catch((error: unknown) => toast(errorMessage(error)))
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
