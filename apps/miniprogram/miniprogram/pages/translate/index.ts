/**
 * 翻译 (default tab): one input and two actions, 纠错 and 翻译 (v2: 纠错 moved
 * here from its own tab).
 *
 * Composer: an empty box shows 「输入或〔粘贴〕要翻译或纠错的文字」; 纠错 is
 * off unless the text is English; the direction chip shows only when the
 * account turned it on (settings.showDirection). After a submit the box folds
 * to two lines; past 1800 characters a counter shows.
 *
 * Results: icon-only 朗读 / 复制 / 收藏. A word shows head word, IPA and
 * speaker on one line; a sentence or paragraph lets the user tap its English
 * side to look words up in a bottom sheet (lib/tokens.ts, lib/lookup-view.ts);
 * a check marks numbered changes in the corrected text (lib/check-changes.ts).
 * 收藏 saves a note at one star and shows the stars beside the bookmark
 * (services/notes.ts). When a result is taller than the screen, the action
 * bar docks at the bottom with 回到顶部.
 */
import { errorMessage, isApiError } from '../../lib/api'
import {
  explanationItems,
  explanationRows,
  numberChanges,
  visibleRows,
  type NumberedDiff,
} from '../../lib/check-changes'
import { MAX_INPUT_CODE_POINTS, clipInput, inputCounter, paragraphCount } from '../../lib/composer'
import { copyText } from '../../lib/copy'
import { WORD_PAGE_SENTENCE_MAX, isLookupDisabled, revealScrollTop, sheetView, wordPageUrl } from '../../lib/lookup-view'
import type { NoteTarget } from '../../lib/note-outbox'
import { cleanMarkdown, codePointLength, parseWordHeadline, splitFirstLine } from '../../lib/output'
import { directionLabel, isBusy, outputIsEnglish, speechKey, type ResultState } from '../../lib/result'
import { speechPhase, speechProgress, type SpeechStatus } from '../../lib/speaker'
import {
  isSelected,
  selectWord,
  selectionText,
  sentenceAround,
  splitForLookup,
  type LookupText,
  type Selection,
} from '../../lib/tokens'
import type { Direction, LookupResult } from '../../lib/types'
import { diffWords, displaySegments } from '../../lib/word-diff'
import { lookupWord } from '../../services/endpoints'
import { canSaveNote, flushNotes } from '../../services/notes'
import { utcOffsetMinutes } from '../../services/platform'
import { createResultRunner, type ResultRunner, type RunnerView } from '../../services/result-runner'
import { redirectIfInviteRequired } from '../../services/session'
import { autoSpeakWord, explanationLang } from '../../services/settings'
import { speak, speechStatus, toggleSpeech, watchSpeech } from '../../services/speech'
import { bindPageLook, currentTheme } from '../../services/theme'
import { syncSavedNotes } from '../../services/saved-index'
import { lexiconSpeechKey } from '../../lib/notebook'
import { toast } from '../../services/ui'
import { startVoice, stopVoice, voiceAvailable } from '../../services/voice'
import { detectSourceLang } from '../../vendor/core/detect'
import {
  COMPOSER_MAX_LINES,
  DOCK_BAR_PX,
  EMPTY_BAR,
  EMPTY_RESULT,
  EMPTY_SHEET,
  FIRST_LINE_DONE_RE,
  INLINE_BAR_PX,
  REVEAL_MARGIN_PX,
  SOURCE_MAX_LINES,
  STREAM_MEASURE_MS,
  autoDirection,
  chipViews,
  directionView,
  headSizeOf,
  initialData,
  isScrollContext,
  sheetHeightPx,
  showDirectionSetting,
  sourceLinePx,
  windowInfo,
  type BarView,
  type Rect,
  type ResultData,
  type SheetData,
  type Task,
  type TranslateData,
} from './view'
import { createSavedNotes, sheetTargets, type SavedNotes, type SheetTargets } from './saved-notes'

/** 503 LOOKUP_DISABLED switches tap-to-look-up off until the app restarts. */
let lookupDisabled = false

Page({
  data: initialData,
  runner: null as ResultRunner | null,
  /** The request whose result shows. */
  run: null as { readonly task: Task; readonly text: string } | null,
  /** The English side of the shown result, split into words (once it is done). */
  english: null as (LookupText & { readonly text: string }) | null,
  selection: null as Selection | null,
  /** Bumped by every lookup and close: an answer counts only while it is the latest. */
  lookupGen: 0,
  lookup: null as LookupResult | null,
  /** Notes saved from this page: their ids and stars. */
  saved: null as SavedNotes | null,
  diffCache: null as { readonly key: string; readonly diff: NumberedDiff } | null,
  /** The direction chosen with the chip; null = detected. */
  directionOverride: null as Direction | null,
  /** The word result already read aloud automatically (each one once). */
  autoSpokenId: '',
  lastMeasure: 0,
  stopWatchingTheme: null as (() => void) | null,
  stopWatchingSpeech: null as (() => void) | null,
  /** Speech key of the sheet's word (单词释义 朗读), shared with the word page's 美 button. */
  sheetSpeakKey: '',

  onLoad() {
    this.saved = createSavedNotes()
    this.runner = createResultRunner((view) => this.render(view))
    this.stopWatchingTheme = bindPageLook(this)
    this.stopWatchingSpeech = watchSpeech((speech) => this.syncSpeech(speech))
    this.setData({
      theme: currentTheme(),
      voiceEnabled: voiceAvailable(),
      showDirection: showDirectionSetting(),
      sheetHeight: sheetHeightPx(),
    })
  },

  onShow() {
    const showDirection = showDirectionSetting()
    if (!showDirection) this.directionOverride = null
    if (showDirection !== this.data.showDirection) {
      this.setData({ showDirection, ...this.directionFor(this.data.input) })
    }
    void flushNotes()
    // Notes saved elsewhere (笔记本, the word page, the CLI) show as saved here too.
    syncSavedNotes()
      .then(() => this.refreshNoteStates())
      .catch(() => undefined)
  },

  onUnload() {
    this.stopWatchingTheme?.()
    this.stopWatchingSpeech?.()
    this.lookupGen += 1
    this.runner?.reset()
  },

  // ---- composer ----

  directionFor(input: string): Pick<TranslateData, 'dirFrom' | 'dirTo' | 'dirAria'> {
    return directionView(input, this.directionOverride ?? autoDirection(input))
  },

  setInput(input: string, extra: Partial<TranslateData> = {}) {
    const english = input.trim() !== '' && detectSourceLang(input) === 'en'
    this.setData({
      input,
      counter: inputCounter(input),
      canSubmit: input.trim() !== '',
      canCheck: english,
      inputEnglish: english,
      ...this.directionFor(input),
      ...extra,
    })
  },

  onInput(event: WechatMiniprogram.TextareaInput) {
    this.setInput(event.detail.value)
  },

  /** The keyboard's send key (`confirm-type="send"`): translate. */
  onSubmit(event: WechatMiniprogram.TextareaConfirm) {
    this.setInput(event.detail.value)
    this.submit('translate', event.detail.value)
  },
  onFocus() {
    this.setData({ focused: true })
  },
  onBlur() {
    this.setData({ focused: false })
  },
  onLineChange(event: WechatMiniprogram.TextareaLineChange) {
    const tall = event.detail.lineCount > COMPOSER_MAX_LINES
    if (tall !== this.data.tall) this.setData({ tall })
  },

  focusInput() {
    this.setData({ focus: false }, () => this.setData({ focus: true }))
  },

  /** A tap on the empty-box hint (where the platform does not pass it through to the textarea). */
  onHintTap() {
    this.focusInput()
  },

  onPaste() {
    wx.getClipboardData({
      success: ({ data }) => {
        const pasted = typeof data === 'string' ? data : ''
        if (pasted.trim() === '') {
          toast('剪贴板里没有文字')
          return
        }
        const { text, clipped } = clipInput(pasted)
        this.setInput(text, { collapsed: false })
        if (clipped) toast(`最多 ${MAX_INPUT_CODE_POINTS} 字，已截取`)
      },
      fail: () => toast('无法读取剪贴板'),
    })
  },

  onExpandComposer() {
    this.setData({ collapsed: false })
    this.focusInput()
  },

  onFlipDirection() {
    const current = this.directionOverride ?? autoDirection(this.data.input)
    this.directionOverride = current === 'toEn' ? 'toZh' : 'toEn'
    this.setData(this.directionFor(this.data.input))
    // A finished translation of this very text is redone in the new direction.
    const run = this.run
    if (run !== null && run.task === 'translate' && !this.data.busy && run.text === this.data.input.trim()) {
      this.submit('translate')
    }
  },

  onTranslate() {
    this.submit('translate')
  },

  onCheck() {
    if (this.data.input.trim() === '') return
    if (!this.data.canCheck) {
      toast('纠错只支持英文')
      return
    }
    this.submit('check')
  },

  onClear() {
    this.closeSheet()
    this.runner?.reset()
    this.run = null
    this.english = null
    this.directionOverride = null
    this.setInput('', { collapsed: false, tall: false, docked: false })
    this.focusInput()
  },

  onMicStart() {
    if (this.data.recording) return
    const started = startVoice('zh_CN', {
      onPartial: (text) => this.setInput(text),
      onFinal: (text) => {
        this.setData({ recording: false })
        if (text === '') return
        this.setInput(text)
        this.submit('translate', text)
      },
      onError: (message) => {
        this.setData({ recording: false })
        toast(message)
      },
    })
    if (started) this.setData({ recording: true, collapsed: false })
  },

  onMicEnd() {
    if (!this.data.recording) return
    this.setData({ recording: false })
    stopVoice()
  },

  /** Runs `task` on `raw` (the input box by default). */
  submit(task: Task, raw?: string) {
    const text = (raw ?? this.data.input).trim()
    if (text === '' || this.runner === null) return
    if (codePointLength(text) > MAX_INPUT_CODE_POINTS) {
      toast(`最多 ${MAX_INPUT_CODE_POINTS} 字`)
      return
    }
    if (task === 'check' && detectSourceLang(text) !== 'en') {
      toast('纠错只支持英文')
      return
    }
    this.closeSheet()
    this.run = { task, text }
    this.english = null
    this.diffCache = null
    this.setData({
      ...EMPTY_RESULT,
      task,
      bar: EMPTY_BAR,
      collapsed: true,
      focus: false,
      tall: false,
      rowsExpanded: false,
      docked: false,
    })
    wx.hideKeyboard({ fail: () => undefined })
    this.scrollBodyTo(0)
    const direction = task === 'translate' ? this.directionOverride : null
    void this.runner.run({
      text,
      task,
      mode: task === 'check' ? 'detail' : 'simple',
      lang: explanationLang(),
      utcOffsetMinutes: utcOffsetMinutes(),
      ...(direction === null ? {} : { direction }),
    })
  },

  // ---- result ----

  render({ state, errorText }: RunnerView) {
    const run = this.run
    const busy = isBusy(state)
    const base = { status: state.status, busy, errorText }
    if (state.status === 'idle' || run === null) {
      this.setData({ ...base, ...EMPTY_RESULT, bar: EMPTY_BAR, docked: false })
      return
    }
    const view = run.task === 'check' ? this.checkView(state, run.text) : this.translateView(state, run.text)
    this.setData({ ...base, ...view, bar: this.barView(state, speechStatus()) }, () => this.afterRender(busy))
    this.autoSpeak(state)
  },

  translateView(state: ResultState, source: string): Partial<ResultData> {
    const headline = state.kind === 'word' ? parseWordHeadline(state.text) : null
    const done = state.status === 'done'
    const view: Partial<ResultData> = {
      headline,
      headSize: headline === null ? '' : headSizeOf(headline.head),
      wordLink: done && headline !== null ? wordPageUrl(headline.head, '', state.entryId) : '',
      text: state.text,
      english: outputIsEnglish(state.srcLang),
      meta:
        state.kind === 'paragraph' && state.srcLang !== null
          ? `${directionLabel(state.srcLang)} · ${paragraphCount(state.text)} 段`
          : '',
    }
    // Tap-to-look-up: sentences and paragraphs, once they are complete.
    if (!done || state.kind === 'word' || this.english !== null) return view
    const side = state.srcLang === 'zh' ? state.text.trim() : state.srcLang === 'en' ? source : ''
    if (side === '') return view
    this.english = { text: side, ...splitForLookup(side) }
    return {
      ...view,
      tokens: chipViews(this.english),
      outputTokens: state.srcLang === 'zh',
      sourceTokens: state.srcLang === 'en',
      lookupOn: !lookupDisabled,
      sourceClamped: true,
      sourceCollapsible: false,
      sourceLines: 0,
    }
  },

  numberedDiff(source: string, corrected: string): NumberedDiff {
    const key = `${source}\n${corrected}`
    if (this.diffCache?.key === key) return this.diffCache.diff
    const diff = numberChanges(displaySegments(diffWords(source, corrected)))
    this.diffCache = { key, diff }
    return diff
  },

  checkView(state: ResultState, source: string): Partial<ResultData> {
    const { first, rest } = splitFirstLine(state.text)
    const firstReady = first !== '' && (state.status === 'done' || FIRST_LINE_DONE_RE.test(state.text))
    if (!firstReady) {
      return { ...EMPTY_RESULT, pending: first }
    }
    const diff = this.numberedDiff(source, first)
    const rows = explanationRows(diff.changes, explanationItems(cleanMarkdown(rest)))
    const shown = visibleRows(rows, this.data.rowsExpanded)
    const count = diff.changes.length
    return {
      ...EMPTY_RESULT,
      meta: count > 0 ? `纠错 · ${count} 处修改` : '纠错 · 没有需要修改的地方',
      corrected: first,
      segments: [...diff.segments],
      rows: [...shown.rows],
      hiddenRows: shown.hidden,
      rowsCollapsible: shown.collapsible,
    }
  },

  /** What 收藏 on the result saves; null when it cannot be a note. */
  resultTarget(state: ResultState): NoteTarget | null {
    const run = this.run
    if (state.status !== 'done' || run === null) return null
    const entryId = state.entryId
    const output = state.text.trim()
    let target: NoteTarget | null = null
    if (run.task === 'check') {
      const { first } = splitFirstLine(state.text)
      target = first === '' ? null : { kind: 'sentence', text: first, entryId }
    } else if (state.kind === 'word') {
      const headline = parseWordHeadline(state.text)
      const translation = headline?.gloss || (state.srcLang === 'zh' ? run.text : null)
      target = headline === null ? null : { kind: 'word', text: headline.head, translation, entryId }
    } else if (state.srcLang === 'zh') {
      target = { kind: 'sentence', text: output, translation: run.text, entryId }
    } else if (state.srcLang === 'en') {
      target = { kind: 'sentence', text: run.text, translation: output, entryId }
    }
    return target !== null && canSaveNote(target) ? target : null
  },

  barView(state: ResultState, speech: SpeechStatus): BarView {
    const run = this.run
    const key = speechKey(state)
    const word = run?.task === 'translate' && state.kind === 'word' && parseWordHeadline(state.text) !== null
    const busy = isBusy(state)
    const target = this.resultTarget(state)
    return {
      busy,
      showSpeak: !word,
      canSpeak: key !== '',
      speakPhase: speechPhase(speech, key),
      progress: speechProgress(speech, key),
      canCopy: !busy && run !== null && copyText({ task: run.task, kind: state.kind, output: state.text }) !== '',
      copyLabel: run?.task === 'check' ? '复制修改后的句子' : word ? '复制释义' : '复制译文',
      canNote: target !== null,
      noteStars: target === null ? 0 : (this.saved?.starsOf(target) ?? 0),
      docked: this.data.docked,
    }
  },

  afterRender(busy: boolean) {
    const now = Date.now()
    if (busy && now - this.lastMeasure < STREAM_MEASURE_MS) return
    this.lastMeasure = now
    this.measureLayout()
  },

  /** Docks the action bar when the result is taller than the screen; folds a 原文 block over six lines. */
  measureLayout() {
    if (this.data.status === 'idle') return
    const query = this.createSelectorQuery()
    query.select('#body').boundingClientRect()
    query.select('#content').boundingClientRect()
    query.select('#source-words').boundingClientRect()
    query.exec((results: unknown[]) => {
      const [body, content, source] = results as [Rect | null, Rect | null, Rect | null]
      const patch: Record<string, unknown> = {}
      const measureSource = source !== null && this.data.sourceTokens && this.data.sourceLines === 0
      if (measureSource) {
        const lines = Math.max(1, Math.round(source.height / sourceLinePx()))
        patch['sourceLines'] = lines
        patch['sourceCollapsible'] = lines > SOURCE_MAX_LINES
        patch['sourceClamped'] = lines > SOURCE_MAX_LINES
      }
      if (body !== null && content !== null) {
        const height = content.height - (this.data.sheetOpen ? this.data.sheetHeight : 0)
        const docked = this.data.docked
          ? height + INLINE_BAR_PX > body.height + DOCK_BAR_PX
          : height > body.height
        if (docked !== this.data.docked) {
          patch['docked'] = docked
          patch['bar.docked'] = docked
        }
      }
      if (Object.keys(patch).length === 0) return
      // Folding the 原文 changes the height: measure the dock once more.
      this.setData(patch, measureSource ? () => this.measureLayout() : undefined)
    })
  },

  onToggleRows() {
    this.setData({ rowsExpanded: !this.data.rowsExpanded })
    const current = this.runner?.current()
    if (current !== undefined) this.render(current)
  },

  onExpandSource() {
    this.setData({ sourceClamped: false }, () => this.measureLayout())
  },

  scrollBodyTo(top: number) {
    this.createSelectorQuery()
      .select('#body')
      .node()
      .exec((results: unknown[]) => {
        const node = (results[0] as { node?: unknown } | null | undefined)?.node
        if (isScrollContext(node)) {
          node.scrollTo({ top, animated: true, duration: 250 })
          return
        }
        // Without a scroll context: the bound scroll-top, nudged so an unchanged value still applies.
        this.setData({ scrollTop: top === this.data.scrollTop ? top + 0.01 : top })
      })
  },

  onBackToTop() {
    this.scrollBodyTo(0)
  },

  onStop() {
    this.runner?.stop()
  },

  // ---- 朗读 / 复制 ----

  onSpeak() {
    const state = this.runner?.current().state
    const key = state === undefined ? '' : speechKey(state)
    if (key === '') return
    toggleSpeech({ entryId: key }, key).catch((error: unknown) => toast(errorMessage(error)))
  },

  syncSpeech(speech: SpeechStatus) {
    const state = this.runner?.current().state
    const key = state === undefined ? '' : speechKey(state)
    const speakPhase = speechPhase(speech, key)
    const progress = speechProgress(speech, key)
    if (speakPhase !== this.data.bar.speakPhase || progress !== this.data.bar.progress) {
      this.setData({ 'bar.speakPhase': speakPhase, 'bar.progress': progress })
    }
    const sheetSpeakPhase = speechPhase(speech, this.sheetSpeakKey)
    if (sheetSpeakPhase !== this.data.sheetSpeakPhase) this.setData({ sheetSpeakPhase })
  },

  /** 单词释义 朗读: reads the looked-up word from the shared lexicon. */
  onSheetSpeak() {
    const lemma = this.lookup?.lemma ?? ''
    if (lemma === '') return
    this.sheetSpeakKey = lexiconSpeechKey(lemma, 'us')
    toggleSpeech({ lexicon: { lemma } }, this.sheetSpeakKey).catch((error: unknown) => toast(errorMessage(error)))
  },

  /** Bookmarks after the account's notes synced: a note saved elsewhere shows as saved. */
  refreshNoteStates() {
    const state = this.runner?.current().state
    const target = state === undefined ? null : this.resultTarget(state)
    if (target !== null) this.setData({ 'bar.noteStars': this.saved?.starsOf(target) ?? 0 })
    if (this.data.sheetOpen) this.refreshSheetNotes()
  },

  /** 单词自动朗读: a finished word lookup is read aloud once, when the setting is on. */
  autoSpeak(state: ResultState) {
    if (this.run?.task !== 'translate' || state.status !== 'done' || state.kind !== 'word' || state.entryId === null) return
    if (state.entryId === this.autoSpokenId || !autoSpeakWord()) return
    this.autoSpokenId = state.entryId
    speak({ entryId: state.entryId }, state.entryId).catch((error: unknown) =>
      console.warn('[translate] auto speak failed', error),
    )
  },

  onCopy() {
    const run = this.run
    const state = this.runner?.current().state
    if (run === null || state === undefined || isBusy(state)) return
    const text = copyText({ task: run.task, kind: state.kind, output: state.text })
    if (text !== '') wx.setClipboardData({ data: text, fail: () => undefined })
  },

  onWordLink() {
    if (this.data.wordLink !== '') wx.navigateTo({ url: this.data.wordLink, fail: () => undefined })
  },

  // ---- 收藏 ----

  onResultNote() {
    const state = this.runner?.current().state
    const target = state === undefined ? null : this.resultTarget(state)
    if (target === null) return
    this.setData({ 'bar.noteStars': this.saved?.toggle(target) ?? 0 })
  },

  onResultStars(event: WechatMiniprogram.CustomEvent<{ level?: number }>) {
    const state = this.runner?.current().state
    const target = state === undefined ? null : this.resultTarget(state)
    if (target === null) return
    this.setData({ 'bar.noteStars': this.saved?.setStars(target, event.detail.level) ?? 0 })
  },

  // ---- 点词查词 ----

  onWordTap(event: WechatMiniprogram.BaseEvent<Record<string, never>, { w?: number | string }>) {
    const english = this.english
    const index = Number(event.currentTarget.dataset.w)
    if (!this.data.lookupOn || english === null || !Number.isInteger(index) || index < 0) return
    const next = selectWord(this.selection, index, english.text, english.words)
    this.select(next)
    if (next === null) this.closeSheet()
    else this.startLookup()
  },

  /** Highlights the words of `next` (only the words that change are sent to the view). */
  select(next: Selection | null) {
    const previous = this.selection
    this.selection = next
    const english = this.english
    if (english === null) return
    const patch: Record<string, boolean> = {}
    english.locations.forEach((location, index) => {
      const on = isSelected(next, index)
      if (on !== isSelected(previous, index)) patch[`tokens[${location.chip}].parts[${location.part}].on`] = on
    })
    if (Object.keys(patch).length > 0) this.setData(patch)
  },

  startLookup() {
    const english = this.english
    const selection = this.selection
    if (english === null || selection === null) return
    this.lookupGen += 1
    const generation = this.lookupGen
    const word = selectionText(english.text, english.words, selection)
    const sentence = sentenceAround(english.text, english.words, selection)
    const entryId = this.runner?.current().state.entryId ?? null
    this.lookup = null
    this.setData({ sheetOpen: true, sheet: { ...EMPTY_SHEET, title: word } }, () => this.revealSelection())
    lookupWord({ word, ...(sentence === '' ? {} : { sentence }), ...(entryId === null ? {} : { entryId }) })
      .then((result) => {
        if (generation !== this.lookupGen) return
        this.lookup = result
        const view = sheetView(result, word)
        this.setData({
          sheet: {
            ...EMPTY_SHEET,
            state: 'ready',
            title: view.headword,
            ipa: view.ipa,
            asWritten: view.asWritten,
            meaning: view.meaning,
            phrase: view.phrase,
            senses: [...view.senses],
            ...this.sheetNotes(),
          },
        })
      })
      .catch((error: unknown) => {
        if (generation !== this.lookupGen) return
        if (isLookupDisabled(error)) {
          lookupDisabled = true
          this.closeSheet()
          this.setData({ lookupOn: false })
          toast(errorMessage(error))
          return
        }
        if (redirectIfInviteRequired(error)) return
        this.setData({
          'sheet.state': 'error',
          'sheet.errorText': errorMessage(error),
          'sheet.canRetry': !(isApiError(error) && error.code === 'NOT_A_WORD'),
        })
      })
  },

  /** Scrolls the page when the sheet would hide the selected words. */
  revealSelection() {
    const selection = this.selection
    if (selection === null) return
    const query = this.createSelectorQuery()
    query.select(`#w${selection.start}`).boundingClientRect()
    query.select(`#w${selection.end}`).boundingClientRect()
    query.select('#body').boundingClientRect()
    query.select('#body').scrollOffset()
    query.exec((results: unknown[]) => {
      const [first, last, body, offset] = results as [
        Rect | null,
        Rect | null,
        Rect | null,
        WechatMiniprogram.ScrollOffsetCallbackResult | null,
      ]
      if (first === null || last === null || body === null || offset === null) return
      const target = revealScrollTop({
        top: first.top,
        bottom: last.bottom,
        viewTop: body.top,
        visibleBottom: windowInfo().height - this.data.sheetHeight,
        scrollTop: offset.scrollTop,
        margin: REVEAL_MARGIN_PX,
      })
      if (target !== null) this.scrollBodyTo(target)
    })
  },

  closeSheet() {
    this.lookupGen += 1
    this.lookup = null
    if (this.selection !== null) this.select(null)
    if (this.data.sheetOpen) this.setData({ sheetOpen: false })
  },

  onSheetClose() {
    this.closeSheet()
  },

  onSheetRetry() {
    this.startLookup()
  },

  onSheetMore() {
    const english = this.english
    const selection = this.selection
    const lookup = this.lookup
    if (english === null || selection === null || lookup === null) return
    const sentence = sentenceAround(english.text, english.words, selection, WORD_PAGE_SENTENCE_MAX)
    const entryId = this.runner?.current().state.entryId ?? null
    wx.navigateTo({ url: wordPageUrl(lookup.lemma, sentence, entryId), fail: () => undefined })
  },

  /** The sheet's two notes: the looked-up word (or phrase) and the phrase it sits in. */
  sheetTargets(): SheetTargets {
    return sheetTargets(this.lookup, this.runner?.current().state.entryId ?? null)
  },

  sheetNotes(): Pick<SheetData, 'headNote' | 'headStars' | 'phraseNote' | 'phraseStars'> {
    const { head, phrase } = this.sheetTargets()
    return {
      headNote: head !== null,
      headStars: head === null ? 0 : (this.saved?.starsOf(head) ?? 0),
      phraseNote: phrase !== null,
      phraseStars: phrase === null ? 0 : (this.saved?.starsOf(phrase) ?? 0),
    }
  },

  refreshSheetNotes() {
    const notes = this.sheetNotes()
    this.setData({
      'sheet.headStars': notes.headStars,
      'sheet.phraseStars': notes.phraseStars,
    })
  },

  onHeadNote() {
    const { head } = this.sheetTargets()
    if (head === null) return
    this.saved?.toggle(head)
    this.refreshSheetNotes()
  },

  onHeadStars(event: WechatMiniprogram.CustomEvent<{ level?: number }>) {
    const { head } = this.sheetTargets()
    if (head === null) return
    this.saved?.setStars(head, event.detail.level)
    this.refreshSheetNotes()
  },

  onPhraseNote() {
    const { phrase } = this.sheetTargets()
    if (phrase === null) return
    this.saved?.toggle(phrase)
    this.refreshSheetNotes()
  },

  onPhraseStars(event: WechatMiniprogram.CustomEvent<{ level?: number }>) {
    const { phrase } = this.sheetTargets()
    if (phrase === null) return
    this.saved?.setStars(phrase, event.detail.level)
    this.refreshSheetNotes()
  },
})
