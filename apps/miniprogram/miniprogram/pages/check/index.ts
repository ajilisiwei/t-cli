/**
 * 纠错: English in, the corrected sentence back with the edits marked in
 * place (deleted words struck through, inserted words highlighted), followed
 * by the explanation. Detail-mode check output puts the corrected text alone
 * on its first line, so the diff can start as soon as that line is complete.
 */
import { errorMessage } from '../../lib/api'
import { cleanMarkdown, codePointLength, splitFirstLine } from '../../lib/output'
import { isBusy, speechKey, type ResultStatus } from '../../lib/result'
import { speechPhase, type SpeechPhase, type SpeechStatus } from '../../lib/speaker'
import { diffWords, displaySegments, hasChanges, type DiffSegment } from '../../lib/word-diff'
import { handOffToTranslate } from '../../services/handoff'
import { utcOffsetMinutes } from '../../services/platform'
import { createResultRunner, type ResultRunner, type RunnerView } from '../../services/result-runner'
import { explanationLang } from '../../services/settings'
import { speechStatus, toggleSpeech, watchSpeech } from '../../services/speech'
import { currentTheme, watchTheme, type Theme } from '../../services/theme'
import { toast } from '../../services/ui'
import { startVoice, stopVoice, voiceAvailable } from '../../services/voice'
import { detectSourceLang } from '../../vendor/core/detect'

const MAX_INPUT_CODE_POINTS = 2000

interface CheckView {
  status: ResultStatus
  /** The corrected sentence once its line is complete, else ''. */
  corrected: string
  segments: DiffSegment[]
  unchanged: boolean
  /** The first line while it is still streaming. */
  pending: string
  explanation: string
  busy: boolean
  canSpeak: boolean
  speakPhase: SpeechPhase
  errorText: string
}

interface CheckData extends CheckView {
  theme: Theme
  input: string
  focus: boolean
  /** The input has focus: the composer border turns indigo. */
  focused: boolean
  /** The mic is shown only when the WechatSI plugin is declared and authorized. */
  voiceEnabled: boolean
  recording: boolean
  /** The submitted text is not English: offer 去翻译 instead. */
  notEnglish: boolean
}

// A complete first line: some content followed by a line break.
const FIRST_LINE_DONE_RE = /\S[^\n]*\n/

const checkView = ({ state, errorText }: RunnerView, submitted: string, speech: SpeechStatus): CheckView => {
  const { first, rest } = splitFirstLine(state.text)
  const firstReady = first !== '' && (state.status === 'done' || FIRST_LINE_DONE_RE.test(state.text))
  const segments = firstReady ? displaySegments(diffWords(submitted, first)) : []
  return {
    status: state.status,
    corrected: firstReady ? first : '',
    segments,
    unchanged: firstReady && !hasChanges(segments),
    pending: firstReady ? '' : first,
    explanation: cleanMarkdown(rest),
    busy: isBusy(state),
    canSpeak: speechKey(state) !== '',
    speakPhase: speechPhase(speech, speechKey(state)),
    errorText,
  }
}

const initialData: CheckData = {
  theme: currentTheme(),
  input: '',
  focus: false,
  focused: false,
  voiceEnabled: false,
  recording: false,
  notEnglish: false,
  status: 'idle',
  corrected: '',
  segments: [],
  unchanged: false,
  pending: '',
  explanation: '',
  busy: false,
  canSpeak: false,
  speakPhase: 'idle',
  errorText: '',
}

Page({
  data: initialData,
  runner: null as ResultRunner | null,
  /** The text the shown result corrects (the diff's left side). */
  submitted: '',
  stopWatchingTheme: null as (() => void) | null,
  stopWatchingSpeech: null as (() => void) | null,

  onLoad() {
    this.runner = createResultRunner((view) => this.setData(checkView(view, this.submitted, speechStatus())))
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    this.stopWatchingSpeech = watchSpeech((speech) => this.syncSpeech(speech))
    this.setData({ theme: currentTheme(), voiceEnabled: voiceAvailable() })
  },

  onShow() {
    // Switching to this tab means the user is about to type.
    if (this.data.input === '') this.setData({ focus: true })
  },

  onUnload() {
    this.stopWatchingTheme?.()
    this.stopWatchingSpeech?.()
    this.runner?.reset()
  },

  onInput(event: WechatMiniprogram.TextareaInput) {
    this.setData({ input: event.detail.value, notEnglish: false })
  },

  onSubmit(event: WechatMiniprogram.TextareaConfirm) {
    this.check(event.detail.value)
  },
  /** The send button: same as the keyboard's send key. */
  onSend() {
    this.check(this.data.input)
  },
  onFocus() {
    this.setData({ focused: true })
  },
  onBlur() {
    this.setData({ focused: false })
  },

  onClear() {
    this.runner?.reset()
    this.submitted = ''
    this.setData({ input: '', notEnglish: false, focus: false }, () => this.setData({ focus: true }))
  },

  onGoTranslate() {
    const text = this.data.input.trim()
    if (text === '') return
    handOffToTranslate(text)
    this.setData({ notEnglish: false })
    wx.switchTab({ url: '/pages/translate/index', fail: () => undefined })
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

  onCopyCorrected() {
    if (this.data.corrected !== '') wx.setClipboardData({ data: this.data.corrected, fail: () => undefined })
  },

  onMicStart() {
    if (this.data.recording) return
    const started = startVoice('en_US', {
      onPartial: (text) => this.setData({ input: text }),
      onFinal: (text) => {
        this.setData({ recording: false })
        if (text === '') return
        this.setData({ input: text })
        this.check(text)
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

  check(raw: string) {
    const text = raw.trim()
    if (text === '' || this.runner === null) return
    if (codePointLength(text) > MAX_INPUT_CODE_POINTS) {
      toast(`最多 ${MAX_INPUT_CODE_POINTS} 字`)
      return
    }
    // Same rule the server uses to pick a direction: anything but Latin-script text is not English.
    if (detectSourceLang(text) !== 'en') {
      this.runner.reset()
      this.setData({ notEnglish: true })
      return
    }
    this.submitted = text
    this.setData({ notEnglish: false })
    void this.runner.run({
      text,
      task: 'check',
      mode: 'detail',
      lang: explanationLang(),
      utcOffsetMinutes: utcOffsetMinutes(),
    })
  },
})
