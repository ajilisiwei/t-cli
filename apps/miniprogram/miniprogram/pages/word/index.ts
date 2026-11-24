/**
 * 单词详情 (`?lemma=<enc>&sentence=<enc>&entryId=<id>`, the last two
 * optional): the word's lexicon entry from `POST /v1/lookup` — 美/英 IPA with
 * speakers, 在本句中 (with a sentence), 释义, 词形变化, 常用搭配, 双语例句,
 * 近义辨析, 记忆 — then 我的记录 and the 「释义由 AI 生成」 note.
 *
 * The word and each collocation can be saved to 笔记本 (bookmark, default
 * 1 star) and starred: the word's stars sit beside its bookmark, a
 * collocation's on a line under its text (option B). Which ones are saved
 * comes from `GET /v1/notes/changes`, folded into an index kept for the app
 * session (module state below), so reopening the page costs one request.
 */
import { errorMessage, isApiError } from '../../lib/api'
import { localDateAt, monthDay } from '../../lib/history-days'
import { formatDue } from '../../lib/item'
import {
  DEFAULT_STARS,
  chipStars,
  collocationRows,
  findSaved,
  lemmaKey,
  lexiconSpeechKey,
  myRecordView,
  phraseNoteInput,
  savedStars,
  starsInput,
  toSavedNote,
  wordNoteInput,
  wordView,
  type CollocationRow,
  type MyRecordView,
  type SavedIndex,
  type SavedNote,
  type UnitRecord,
  type WordView,
} from '../../lib/notebook'
import { ULID_ENTROPY_BYTES, ulid } from '../../lib/review-ulid'
import type { SpeechPhase, SpeechStatus } from '../../lib/speaker'
import type { LookupRequest, LookupResult, Note, NoteInput, NoteKind, NoteStars } from '../../lib/types'
import { deleteNote, lookupWord, saveNote } from '../../services/endpoints'
import { rememberNote, rememberSaved, savedIndex, syncSavedNotes } from '../../services/saved-index'
import { fetchItem, fetchItems } from '../../services/library'
import { utcOffsetMinutes } from '../../services/platform'
import { redirectIfInviteRequired } from '../../services/session'
import { speechStatus, stopSpeaking, toggleSpeech, watchSpeech } from '../../services/speech'
import { bindPageLook, currentTheme, type Theme } from '../../services/theme'
import { toast } from '../../services/ui'

const HISTORY_PAGE = '/pages/history/index'
/** A ULID for a new note; `Math.random` is enough for an idempotency key. */
const newNoteId = (): string =>
  ulid(
    Date.now(),
    Array.from({ length: ULID_ENTROPY_BYTES }, () => Math.floor(Math.random() * 256)),
  )

const decodeParam = (value: string | undefined): string => {
  try {
    return decodeURIComponent(value ?? '').trim()
  } catch {
    return (value ?? '').trim()
  }
}

interface ExampleView {
  key: string
  index: number
  text: string
  gloss: string
  speakKey: string
}

interface WordData {
  theme: Theme
  loading: boolean
  errorText: string
  /** The word as asked (shown in the skeleton) and then the lemma. */
  lemma: string
  view: WordView | null
  examples: ExampleView[]
  keyUs: string
  keyUk: string
  /** 0 = not saved. */
  wordStars: number
  /** Saved state is known (synced, or the sync failed): bookmarks take taps from then on. */
  savedKnown: boolean
  collocations: CollocationRow[]
  record: MyRecordView | null
  speakKey: string
  speakPhase: SpeechPhase
}

const initialData: WordData = {
  theme: currentTheme(),
  loading: true,
  errorText: '',
  lemma: '',
  view: null,
  examples: [],
  keyUs: '',
  keyUk: '',
  wordStars: 0,
  savedKnown: false,
  collocations: [],
  record: null,
  speakKey: '',
  speakPhase: 'idle',
}

type IndexEvent = WechatMiniprogram.BaseEvent<Record<string, never>, { index?: number | string }>
type StarsEvent = WechatMiniprogram.CustomEvent<{ level?: number }, Record<string, never>, { index?: number | string }>

Page({
  data: initialData,
  asked: '',
  sentence: '',
  entryId: '',
  result: null as LookupResult | null,
  /** The first saved-state sync of this page; saving waits for it, so a saved word is never saved twice. */
  savedReady: null as Promise<SavedIndex> | null,
  /** Save keys with a request in flight (further taps wait). */
  busy: new Set<string>(),
  stopWatchingTheme: null as (() => void) | null,
  stopWatchingSpeech: null as (() => void) | null,

  onLoad(query: Record<string, string | undefined>) {
    this.busy = new Set<string>()
    this.stopWatchingTheme = bindPageLook(this)
    this.stopWatchingSpeech = watchSpeech((speech) => this.syncSpeech(speech))
    this.asked = decodeParam(query['lemma'])
    this.sentence = decodeParam(query['sentence'])
    this.entryId = decodeParam(query['entryId'])
    this.setData({ theme: currentTheme(), lemma: this.asked })
    this.syncSpeech(speechStatus())
    void this.load()
  },

  onUnload() {
    this.stopWatchingTheme?.()
    this.stopWatchingSpeech?.()
    if (speechStatus().key.startsWith('lex-')) stopSpeaking()
  },

  // ---- loading

  async load() {
    if (this.asked === '') {
      this.setData({ loading: false, errorText: '没有要查的词' })
      return
    }
    this.setData({ loading: true, errorText: '' })
    // Saved state loads beside the lookup; failing it only hides the marks.
    const saved = syncSavedNotes().catch(() => savedIndex())
    this.savedReady = saved
    try {
      const result = await this.lookup()
      this.result = result
      const view = wordView(result, this.sentence, this.asked)
      this.setData({
        lemma: result.lemma,
        view,
        examples: view.examples.map((example) => ({ ...example, speakKey: lexiconSpeechKey(result.lemma, example.index) })),
        keyUs: lexiconSpeechKey(result.lemma, 'us'),
        keyUk: lexiconSpeechKey(result.lemma, 'uk'),
      })
      this.showSaved(savedIndex())
      this.showSaved(await saved)
      this.setData({ savedKnown: true })
      void this.loadRecord()
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      this.setData({ errorText: errorMessage(error, { NOT_A_WORD: '没有查到这个词', NOT_FOUND: '没有找到这条记录' }) })
    } finally {
      this.setData({ loading: false })
    }
  },

  /** `POST /v1/lookup`; a record id the server does not know is dropped and the lookup retried. */
  async lookup(): Promise<LookupResult> {
    const request = (): LookupRequest => ({
      word: this.asked,
      ...(this.sentence === '' ? {} : { sentence: this.sentence }),
      ...(this.entryId === '' ? {} : { entryId: this.entryId }),
    })
    try {
      return await lookupWord(request())
    } catch (error: unknown) {
      if (this.entryId === '' || !isApiError(error) || error.code !== 'NOT_FOUND') throw error
      this.entryId = ''
      return lookupWord(request())
    }
  },

  onRetry() {
    void this.load()
  },

  showSaved(index: SavedIndex) {
    const { result } = this
    if (result === null) return
    this.setData({
      wordStars: savedStars(index, 'word', result.lemma),
      collocations: collocationRows(result, index),
    })
  },

  /** 我的记录: the word's learning unit — the saved note's, else a library search by lemma. */
  async loadRecord() {
    const { result } = this
    if (result === null) return
    const saved = findSaved(savedIndex(), 'word', result.lemma)
    let unit: UnitRecord | null = null
    try {
      let itemId = saved?.itemId ?? null
      if (itemId === null) {
        const page = await fetchItems({ q: result.lemma, type: 'word', level: null }, 0)
        itemId = page.items.find((item) => lemmaKey(item.display) === lemmaKey(result.lemma))?.id ?? null
      }
      if (itemId !== null) unit = await fetchItem(itemId)
    } catch (error: unknown) {
      console.warn('[word] record failed', isApiError(error) ? error.code : error)
    }
    const offset = utcOffsetMinutes()
    const now = Date.now()
    const today = localDateAt(now, offset)
    const formatDay = (iso: string): string => {
      const ms = Date.parse(iso)
      return Number.isNaN(ms) ? '' : monthDay(localDateAt(ms, offset), today)
    }
    const isSaved = this.data.wordStars > 0
    this.setData({
      record: myRecordView(unit, isSaved, now, formatDay, (iso) => formatDue(iso, new Date(now))),
    })
  },

  // ---- saving

  /** Saves (or revives) a note, or deletes it; returns the stars now shown (0 = not saved). */
  async toggleNote(kind: NoteKind, text: string, input: (stars: NoteStars) => NoteInput): Promise<number> {
    await this.savedReady
    const saved = findSaved(savedIndex(), kind, text)
    if (saved !== null && saved.live) {
      try {
        await deleteNote(saved.id)
      } catch (error: unknown) {
        if (!isApiError(error) || error.code !== 'NOT_FOUND') throw error
      }
      rememberSaved({ ...saved, live: false })
      return 0
    }
    // A deleted note is revived under its id, with the text it was stored with.
    const body = saved === null ? input(DEFAULT_STARS) : { ...input(DEFAULT_STARS), text: saved.text }
    const note = await saveNote(saved?.id ?? newNoteId(), body)
    rememberNote(note)
    return note.deletedAt === null ? note.stars : 0
  },

  async setStars(kind: NoteKind, text: string, stars: NoteStars): Promise<number> {
    const saved = findSaved(savedIndex(), kind, text)
    if (saved === null || !saved.live) return 0
    const note = await saveNote(saved.id, starsInput(saved, stars))
    rememberSaved(toSavedNote(note))
    return note.stars
  },

  async onToggleWord() {
    const { result } = this
    if (result === null || !this.data.savedKnown || this.busy.has('word')) return
    this.busy.add('word')
    const before = this.data.wordStars
    this.setData({ wordStars: before > 0 ? 0 : DEFAULT_STARS })
    try {
      const stars = await this.toggleNote('word', result.lemma, (s) => wordNoteInput(result, s, this.entryId))
      this.setData({ wordStars: stars })
      void this.loadRecord()
    } catch (error: unknown) {
      this.setData({ wordStars: before })
      toast(errorMessage(error))
    } finally {
      this.busy.delete('word')
    }
  },

  async onWordStars(event: StarsEvent) {
    const { result } = this
    const stars = chipStars(event.detail.level)
    if (result === null || stars === null || this.busy.has('word')) return
    this.busy.add('word')
    const before = this.data.wordStars
    this.setData({ wordStars: stars })
    try {
      this.setData({ wordStars: await this.setStars('word', result.lemma, stars) })
    } catch (error: unknown) {
      this.setData({ wordStars: before })
      toast(errorMessage(error))
    } finally {
      this.busy.delete('word')
    }
  },

  collocationAt(event: IndexEvent | StarsEvent): { index: number; row: CollocationRow } | null {
    const index = Number(event.currentTarget.dataset.index)
    const row = Number.isInteger(index) ? this.data.collocations[index] : undefined
    return row === undefined ? null : { index, row }
  },

  setCollocationStars(index: number, stars: number) {
    this.setData({ [`collocations[${index}].stars`]: stars })
  },

  async onToggleCollocation(event: IndexEvent) {
    const at = this.collocationAt(event)
    if (at === null || !at.row.savable || !this.data.savedKnown) return
    const key = `phrase:${lemmaKey(at.row.text)}`
    if (this.busy.has(key)) return
    this.busy.add(key)
    const before = at.row.stars
    this.setCollocationStars(at.index, before > 0 ? 0 : DEFAULT_STARS)
    try {
      const stars = await this.toggleNote('phrase', at.row.text, (s) => phraseNoteInput(at.row.text, at.row.gloss, s))
      this.setCollocationStars(at.index, stars)
    } catch (error: unknown) {
      this.setCollocationStars(at.index, before)
      toast(errorMessage(error))
    } finally {
      this.busy.delete(key)
    }
  },

  async onCollocationStars(event: StarsEvent) {
    const at = this.collocationAt(event)
    const stars = chipStars(event.detail.level)
    if (at === null || stars === null) return
    const key = `phrase:${lemmaKey(at.row.text)}`
    if (this.busy.has(key)) return
    this.busy.add(key)
    const before = at.row.stars
    this.setCollocationStars(at.index, stars)
    try {
      this.setCollocationStars(at.index, await this.setStars('phrase', at.row.text, stars))
    } catch (error: unknown) {
      this.setCollocationStars(at.index, before)
      toast(errorMessage(error))
    } finally {
      this.busy.delete(key)
    }
  },

  // ---- actions

  onCopy() {
    const { lemma } = this.data
    if (lemma !== '') wx.setClipboardData({ data: lemma, fail: () => undefined })
  },

  onSpeakWord(event: WechatMiniprogram.BaseEvent<Record<string, never>, { accent?: string }>) {
    const { result } = this
    if (result === null) return
    const accent = event.currentTarget.dataset.accent === 'uk' ? 'uk' : 'us'
    // One English voice reads the lemma for both accents (docs/api-v1.md, lexicon speech).
    toggleSpeech({ lexicon: { lemma: result.lemma } }, lexiconSpeechKey(result.lemma, accent)).catch((error: unknown) =>
      toast(errorMessage(error)),
    )
  },

  onSpeakExample(event: IndexEvent) {
    const { result } = this
    const index = Number(event.currentTarget.dataset.index)
    if (result === null || !Number.isInteger(index)) return
    toggleSpeech({ lexicon: { lemma: result.lemma, example: index } }, lexiconSpeechKey(result.lemma, index)).catch(
      (error: unknown) => toast(errorMessage(error)),
    )
  },

  onRecords() {
    const { lemma } = this.data
    if (lemma === '') return
    wx.navigateTo({ url: `${HISTORY_PAGE}?q=${encodeURIComponent(lemma)}`, fail: () => undefined })
  },

  syncSpeech(speech: SpeechStatus) {
    if (speech.key !== this.data.speakKey || speech.phase !== this.data.speakPhase) {
      this.setData({ speakKey: speech.key, speakPhase: speech.phase })
    }
  },
})
