/**
 * 笔记本 (tab): the saved words, phrases and sentences with their stars,
 * newest first. A summary card (total, 本周, mastery bar), type tabs with
 * counts and star filters on top; `GET /v1/notes` pages the list and
 * `GET /v1/notes/changes` patches it when the tab shows again (after the word
 * page or the translate page saved something). A word opens 单词详情; a phrase
 * or sentence expands in place with its stars editor (option B), 朗读 and 删除.
 */
import { errorMessage, isApiError } from '../../lib/api'
import {
  EMPTY_NOTEBOOK,
  EMPTY_NOTEBOOK_FILTER,
  advanceCursor,
  appendNotesPage,
  applyNoteChanges,
  chipKind,
  chipStars,
  emptyNotebookText,
  findNote,
  kindTabs,
  noteLemma,
  notesQuery,
  removeNote,
  replaceNote,
  sameNotebookFilter,
  starChips,
  summaryView,
  toNoteRow,
  wordPageUrl,
  type KindTab,
  type NotebookFilter,
  type NotebookList,
  type NoteRow,
  type StarChip,
  type SummaryView,
} from '../../lib/notebook'
import type { SpeechPhase, SpeechStatus } from '../../lib/speaker'
import type { NotesSummary, NoteStars } from '../../lib/types'
import { deleteNote, fetchNoteChanges, fetchNotesSummary, listNotes, saveNote } from '../../services/endpoints'
import { utcOffsetMinutes } from '../../services/platform'
import { redirectIfInviteRequired } from '../../services/session'
import { itemSpeechKey, speechStatus, stopSpeaking, toggleSpeech, watchSpeech } from '../../services/speech'
import { bindPageLook, currentTheme, type Theme } from '../../services/theme'
import { confirm, toast } from '../../services/ui'

/** Pages of changes applied in place before a full reload is cheaper. */
const MAX_CHANGE_PAGES = 5

interface NotebookData {
  theme: Theme
  /** null until the summary loads, and when it fails (the card is hidden). */
  summary: SummaryView | null
  kindTabs: KindTab[]
  starChips: StarChip[]
  rows: NoteRow[]
  expandedId: string
  loading: boolean
  refreshing: boolean
  loaded: boolean
  hasMore: boolean
  errorText: string
  emptyText: string
  /** The sounding audio key and its phase (a row's 朗读 shows it when the key is its unit's). */
  speakKey: string
  speakPhase: SpeechPhase
}

const initialData: NotebookData = {
  theme: currentTheme(),
  summary: null,
  kindTabs: kindTabs(null, null),
  starChips: starChips(null),
  rows: [],
  expandedId: '',
  loading: false,
  refreshing: false,
  loaded: false,
  hasMore: false,
  errorText: '',
  emptyText: emptyNotebookText(EMPTY_NOTEBOOK_FILTER),
  speakKey: '',
  speakPhase: 'idle',
}

type IdEvent = WechatMiniprogram.BaseEvent<Record<string, never>, { id?: string }>
type ValueEvent = WechatMiniprogram.BaseEvent<Record<string, never>, { value?: string }>
type StarsEvent = WechatMiniprogram.CustomEvent<{ level?: number }, Record<string, never>, { id?: string }>

Page({
  data: initialData,
  list: EMPTY_NOTEBOOK as NotebookList,
  filter: EMPTY_NOTEBOOK_FILTER as NotebookFilter,
  summaryData: null as NotesSummary | null,
  /** `/v1/notes/changes` cursor; null until the first page arrived. */
  cursor: null as number | null,
  /** Bumped by every reload: responses of an older one are dropped. */
  generation: 0,
  /** Notes with a save or delete in flight (further taps wait). */
  busy: new Set<string>(),
  stopWatchingTheme: null as (() => void) | null,
  stopWatchingSpeech: null as (() => void) | null,

  onLoad() {
    this.busy = new Set<string>()
    this.stopWatchingTheme = bindPageLook(this)
    this.stopWatchingSpeech = watchSpeech((speech) => this.syncSpeech(speech))
    this.setData({ theme: currentTheme() })
    this.syncSpeech(speechStatus())
    void this.reload()
    void this.loadSummary()
  },

  /** Back from 单词详情 or another tab: apply what changed meanwhile. */
  onShow() {
    if (!this.data.loaded) return
    void this.refreshChanges()
    void this.loadSummary()
  },

  onHide() {
    if (this.isRowSpeech(speechStatus())) stopSpeaking()
  },

  onUnload() {
    this.stopWatchingTheme?.()
    this.stopWatchingSpeech?.()
    this.generation += 1
  },

  // ---- data

  show(list: NotebookList, extra: Partial<NotebookData> = {}) {
    this.list = list
    const expandedId = extra.expandedId ?? this.data.expandedId
    this.setData({
      rows: list.notes.map((note) => toNoteRow(note, expandedId)),
      hasMore: list.hasMore,
      emptyText: emptyNotebookText(this.filter),
      ...extra,
    })
  },

  async reload() {
    this.generation += 1
    const mine = this.generation
    this.setData({ loading: true, errorText: '' })
    try {
      const page = await listNotes(notesQuery(this.filter, null))
      if (mine !== this.generation) return
      this.cursor = advanceCursor(this.cursor ?? 0, page.notes)
      this.show(appendNotesPage(EMPTY_NOTEBOOK, page), { loaded: true })
    } catch (error: unknown) {
      if (mine !== this.generation || redirectIfInviteRequired(error)) return
      this.show(EMPTY_NOTEBOOK, { loaded: true, errorText: errorMessage(error) })
    } finally {
      if (mine === this.generation) this.setData({ loading: false, refreshing: false })
    }
  },

  async onLoadMore() {
    const before = this.list.nextBefore
    if (this.data.loading || !this.list.hasMore || before === null) return
    const mine = this.generation
    this.setData({ loading: true, errorText: '' })
    try {
      const page = await listNotes(notesQuery(this.filter, before))
      if (mine !== this.generation) return
      this.cursor = advanceCursor(this.cursor ?? 0, page.notes)
      this.show(appendNotesPage(this.list, page))
    } catch (error: unknown) {
      if (mine === this.generation) this.setData({ errorText: errorMessage(error) })
    } finally {
      if (mine === this.generation) this.setData({ loading: false })
    }
  },

  /** Applies `/v1/notes/changes` since the cursor; many changes → a full reload instead. */
  async refreshChanges() {
    if (this.cursor === null || this.data.loading) {
      if (this.cursor === null && !this.data.loading) void this.reload()
      return
    }
    const mine = this.generation
    try {
      for (let pages = 0; pages < MAX_CHANGE_PAGES; pages += 1) {
        const changes = await fetchNoteChanges(this.cursor ?? 0)
        if (mine !== this.generation) return
        // Applied to the list as it is now: a page loaded or a star set meanwhile stays.
        this.cursor = Math.max(this.cursor ?? 0, changes.nextAfter)
        this.show(applyNoteChanges(this.list, changes.notes, this.filter))
        if (!changes.hasMore) return
      }
      void this.reload()
    } catch (error: unknown) {
      // Offline or a hiccup: the list stays as it was; pulling down retries.
      console.warn('[notebook] changes failed', isApiError(error) ? error.code : error)
    }
  },

  async loadSummary() {
    try {
      const summary = await fetchNotesSummary(utcOffsetMinutes())
      this.summaryData = summary
      this.setData({ summary: summaryView(summary), kindTabs: kindTabs(summary, this.filter.kind) })
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      this.summaryData = null
      this.setData({ summary: null, kindTabs: kindTabs(null, this.filter.kind) })
    }
  },

  onRefresh() {
    this.setData({ refreshing: true })
    void this.reload()
    void this.loadSummary()
  },

  onRetry() {
    void this.reload()
    void this.loadSummary()
  },

  // ---- filters

  applyFilter(filter: NotebookFilter) {
    if (sameNotebookFilter(filter, this.filter) && this.data.errorText === '') return
    this.filter = filter
    this.setData({
      kindTabs: kindTabs(this.summaryData, filter.kind),
      starChips: starChips(filter.stars),
      expandedId: '',
    })
    void this.reload()
  },

  onKindTab(event: ValueEvent) {
    this.applyFilter({ ...this.filter, kind: chipKind(event.currentTarget.dataset.value) })
  },

  onStarChip(event: ValueEvent) {
    this.applyFilter({ ...this.filter, stars: chipStars(event.currentTarget.dataset.value) })
  },

  // ---- rows

  onRow(event: IdEvent) {
    const note = findNote(this.list, event.currentTarget.dataset.id ?? '')
    if (note === null) return
    if (note.kind === 'word') {
      wx.navigateTo({ url: wordPageUrl(noteLemma(note)), fail: () => undefined })
      return
    }
    const expandedId = this.data.expandedId === note.id ? '' : note.id
    this.show(this.list, { expandedId })
  },

  /** Taps inside an expanded row's editor stay there (no collapse). */
  onNoop() {},

  async onRowStars(event: StarsEvent) {
    const note = findNote(this.list, event.currentTarget.dataset.id ?? '')
    const stars = chipStars(event.detail.level)
    if (note === null || stars === null || stars === note.stars || this.busy.has(note.id)) return
    this.busy.add(note.id)
    this.show(replaceNote(this.list, { ...note, stars }))
    try {
      const saved = await saveNote(note.id, { kind: note.kind, text: note.text, lang: 'en', stars: stars as NoteStars })
      this.cursor = advanceCursor(this.cursor ?? 0, [saved])
      const current = findNote(this.list, note.id)
      // A PUT answer may lack the read-time fields (level, task): keep the shown ones.
      if (current !== null) {
        this.show(
          replaceNote(this.list, { ...saved, level: saved.level ?? current.level ?? null, task: saved.task ?? current.task ?? null }),
        )
      }
      void this.loadSummary()
    } catch (error: unknown) {
      const current = findNote(this.list, note.id)
      if (current !== null) this.show(replaceNote(this.list, { ...current, stars: note.stars }))
      toast(errorMessage(error))
    } finally {
      this.busy.delete(note.id)
    }
  },

  async onRowDelete(event: IdEvent) {
    const note = findNote(this.list, event.currentTarget.dataset.id ?? '')
    if (note === null || this.busy.has(note.id)) return
    const ok = await confirm({
      title: '删除这条笔记？',
      content: '复习卡片和复习进度会保留。',
      confirmText: '删除',
      destructive: true,
    })
    if (!ok) return
    this.busy.add(note.id)
    try {
      await deleteNote(note.id)
    } catch (error: unknown) {
      // NOT_FOUND: already gone elsewhere — the row should go too.
      if (!isApiError(error) || error.code !== 'NOT_FOUND') {
        toast(errorMessage(error))
        return
      }
    } finally {
      this.busy.delete(note.id)
    }
    if (this.isRowSpeech(speechStatus())) stopSpeaking()
    this.show(removeNote(this.list, note.id), { expandedId: '' })
    void this.loadSummary()
  },

  onRowSpeak(event: IdEvent) {
    const note = findNote(this.list, event.currentTarget.dataset.id ?? '')
    if (note === null) return
    if (note.itemId === null) {
      toast('稍后就能朗读')
      return
    }
    toggleSpeech({ itemId: note.itemId }, itemSpeechKey(note.itemId)).catch((error: unknown) =>
      toast(errorMessage(error)),
    )
  },

  // ---- speech

  isRowSpeech(speech: SpeechStatus): boolean {
    return speech.phase !== 'idle' && speech.key.startsWith('item-')
  },

  syncSpeech(speech: SpeechStatus) {
    if (speech.key !== this.data.speakKey || speech.phase !== this.data.speakPhase) {
      this.setData({ speakKey: speech.key, speakPhase: speech.phase })
    }
  },
})
