/**
 * 查询记录 (`?q=<enc>` optional, e.g. from 单词详情): every query from the
 * CLI and the phone, grouped by local day (今天 / 昨天 / 11月22日 周日 · N 条).
 * A day strip with each day's count (`GET /v1/entries/days`; empty days are
 * greyed), a calendar to jump to any day, a source filter (全部 / 手机 / CLI)
 * and a debounced search narrow `GET /v1/entries/history`. Infinite scroll;
 * the unfiltered first page is cached so records stay readable offline;
 * tapping a row shows the stored result instead of asking again.
 */
import { errorMessage } from '../../lib/api'
import { EMPTY_HISTORY, appendPage, readHistoryPage, type HistoryState } from '../../lib/history'
import {
  EMPTY_RECORD_FILTER,
  HISTORY_SEARCH_DEBOUNCE_MS,
  SOURCE_CHIPS,
  chipSource,
  countsByDate,
  emptyRecordsText,
  groupByDay,
  historyFilters,
  isDateKey,
  isUnfiltered,
  localDateAt,
  normalizeHistoryQuery,
  sameRecordFilter,
  stripAnchor,
  stripChips,
  stripRange,
  type DayGroup,
  type DayRange,
  type RecordFilter,
  type SourceChip,
  type StripChip,
} from '../../lib/history-days'
import { fetchEntryDays, fetchHistory } from '../../services/endpoints'
import { utcOffsetMinutes } from '../../services/platform'
import { redirectIfInviteRequired } from '../../services/session'
import { STORAGE_KEYS, readStorage, writeStorage } from '../../services/storage'
import { bindPageLook, currentTheme, type Theme } from '../../services/theme'

interface HistoryData {
  theme: Theme
  query: string
  searchFocused: boolean
  sourceChips: readonly SourceChip[]
  /** '' = 全部. */
  sourceValue: string
  /** '' = every day. */
  selectedDate: string
  today: string
  /** The date picker's value: the selected day, else today. */
  pickerValue: string
  chips: StripChip[]
  /** The chip to scroll into view (a picked day). */
  stripInto: string
  groups: DayGroup[]
  expandedId: string
  loading: boolean
  refreshing: boolean
  hasMore: boolean
  /** Showing the cached first page because the network failed. */
  offline: boolean
  errorText: string
  emptyText: string
  loaded: boolean
}

const initialData: HistoryData = {
  theme: currentTheme(),
  query: '',
  searchFocused: false,
  sourceChips: SOURCE_CHIPS,
  sourceValue: '',
  selectedDate: '',
  today: '',
  pickerValue: '',
  chips: [],
  stripInto: '',
  groups: [],
  expandedId: '',
  loading: false,
  refreshing: false,
  hasMore: false,
  offline: false,
  errorText: '',
  emptyText: emptyRecordsText(EMPTY_RECORD_FILTER),
  loaded: false,
}

type ValueEvent = WechatMiniprogram.BaseEvent<Record<string, never>, { value?: string; date?: string; empty?: boolean }>

const decodeParam = (value: string | undefined): string => {
  try {
    return decodeURIComponent(value ?? '')
  } catch {
    return value ?? ''
  }
}

Page({
  data: initialData,
  history: EMPTY_HISTORY as HistoryState,
  filter: EMPTY_RECORD_FILTER as RecordFilter,
  offset: 480,
  range: null as DayRange | null,
  /** Day counts of `range` for the current source; null while unknown. */
  counts: null as Readonly<Record<string, number>> | null,
  /** Bumped by every reload / days load: older responses are dropped. */
  generation: 0,
  daysGeneration: 0,
  searchTimer: null as ReturnType<typeof setTimeout> | null,
  stopWatchingTheme: null as (() => void) | null,

  onLoad(query: Record<string, string | undefined>) {
    this.stopWatchingTheme = bindPageLook(this)
    this.offset = utcOffsetMinutes()
    const today = localDateAt(Date.now(), this.offset)
    const q = normalizeHistoryQuery(decodeParam(query['q']))
    this.filter = { ...EMPTY_RECORD_FILTER, q }
    this.setData({ theme: currentTheme(), today, pickerValue: today, query: q })
    if (isUnfiltered(this.filter)) {
      const cached = readHistoryPage(readStorage(STORAGE_KEYS.historyFirstPage))
      if (cached !== null) this.show(appendPage(EMPTY_HISTORY, cached), { loaded: true })
    }
    void this.reload()
    void this.loadDays()
  },

  onUnload() {
    this.stopWatchingTheme?.()
    this.cancelSearchTimer()
    this.generation += 1
    this.daysGeneration += 1
  },

  // ---- records

  show(history: HistoryState, extra: Partial<HistoryData> = {}) {
    this.history = history
    const searching = normalizeHistoryQuery(this.filter.q) !== ''
    this.setData({
      groups: groupByDay(history.entries, this.offset, this.data.today, searching ? null : this.counts),
      hasMore: history.hasMore,
      emptyText: emptyRecordsText(this.filter),
      ...extra,
    })
  },

  async reload() {
    this.generation += 1
    const mine = this.generation
    const filter = this.filter
    this.setData({ loading: true, errorText: '' })
    try {
      const page = await fetchHistory(null, historyFilters(filter, this.offset))
      if (mine !== this.generation) return
      if (isUnfiltered(filter)) writeStorage(STORAGE_KEYS.historyFirstPage, page)
      this.show(appendPage(EMPTY_HISTORY, page), { offline: false, loaded: true, expandedId: '' })
    } catch (error: unknown) {
      if (mine !== this.generation || redirectIfInviteRequired(error)) return
      const hasCache = isUnfiltered(filter) && this.history.entries.length > 0
      if (!hasCache) this.show(EMPTY_HISTORY)
      this.setData({ offline: hasCache, errorText: errorMessage(error), loaded: true })
    } finally {
      if (mine === this.generation) this.setData({ loading: false, refreshing: false })
    }
  },

  async onLoadMore() {
    const { history } = this
    if (this.data.loading || this.data.offline || !history.hasMore || history.nextBefore === null) return
    const mine = this.generation
    this.setData({ loading: true, errorText: '' })
    try {
      const page = await fetchHistory(history.nextBefore, historyFilters(this.filter, this.offset))
      if (mine !== this.generation) return
      this.show(appendPage(this.history, page))
    } catch (error: unknown) {
      if (mine === this.generation) this.setData({ errorText: errorMessage(error) })
    } finally {
      if (mine === this.generation) this.setData({ loading: false })
    }
  },

  onRefresh() {
    this.setData({ refreshing: true })
    void this.reload()
    void this.loadDays()
  },

  /** 重试: the first page again, or the page that failed to load at the end. */
  onRetry() {
    if (this.history.entries.length === 0) void this.reload()
    else void this.onLoadMore()
  },

  onToggle(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: string }>) {
    const id = event.currentTarget.dataset.id ?? ''
    this.setData({ expandedId: this.data.expandedId === id ? '' : id })
  },

  // ---- day strip

  /** The strip's counts for the current window and source. Failing only leaves them unknown. */
  async loadDays() {
    this.daysGeneration += 1
    const mine = this.daysGeneration
    const range = stripRange(this.data.today, this.filter.date)
    this.range = range
    this.counts = null
    this.showChips()
    try {
      const days = await fetchEntryDays({
        from: range.from,
        to: range.to,
        utcOffsetMinutes: this.offset,
        ...(this.filter.source === null ? {} : { source: this.filter.source }),
      })
      if (mine !== this.daysGeneration) return
      this.counts = countsByDate(days)
      this.showChips()
      this.show(this.history)
    } catch (error: unknown) {
      if (mine !== this.daysGeneration) return
      console.warn('[history] day counts failed', error)
    }
  },

  showChips(extra: Partial<HistoryData> = {}) {
    if (this.range === null) return
    this.setData({
      chips: stripChips(this.range, this.data.today, this.counts, this.filter.date),
      selectedDate: this.filter.date ?? '',
      pickerValue: this.filter.date ?? this.data.today,
      ...extra,
    })
  },

  applyFilter(filter: RecordFilter, options: { readonly days?: boolean } = {}) {
    this.cancelSearchTimer()
    if (sameRecordFilter(filter, this.filter) && this.data.loaded && this.data.errorText === '') return
    const rangeBefore = this.range
    this.filter = filter
    const range = stripRange(this.data.today, filter.date)
    const moved = rangeBefore === null || range.from !== rangeBefore.from || range.to !== rangeBefore.to
    if (options.days === true || moved) void this.loadDays()
    else this.showChips()
    void this.reload()
  },

  onAllDays() {
    this.applyFilter({ ...this.filter, q: this.data.query, date: null })
  },

  onDayChip(event: ValueEvent) {
    const { date, empty } = event.currentTarget.dataset
    if (date === undefined || !isDateKey(date) || empty === true) return
    const next = this.filter.date === date ? null : date
    this.applyFilter({ ...this.filter, q: this.data.query, date: next })
  },

  onPickDate(event: WechatMiniprogram.PickerChange) {
    const date = String(event.detail.value)
    if (!isDateKey(date) || date > this.data.today) return
    this.applyFilter({ ...this.filter, q: this.data.query, date })
    this.setData({ stripInto: stripAnchor(date) })
  },

  onSourceChip(event: ValueEvent) {
    const source = chipSource(event.currentTarget.dataset.value)
    this.setData({ sourceValue: source ?? '' })
    this.applyFilter({ ...this.filter, q: this.data.query, source }, { days: true })
  },

  // ---- search

  cancelSearchTimer() {
    if (this.searchTimer !== null) clearTimeout(this.searchTimer)
    this.searchTimer = null
  },

  onQueryInput(event: WechatMiniprogram.Input) {
    const query = event.detail.value
    this.setData({ query })
    this.cancelSearchTimer()
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null
      this.applyFilter({ ...this.filter, q: query })
    }, HISTORY_SEARCH_DEBOUNCE_MS)
  },

  /** The keyboard's search key: no need to wait for the pause. */
  onQueryConfirm(event: WechatMiniprogram.InputConfirm) {
    this.applyFilter({ ...this.filter, q: event.detail.value })
  },

  onSearchFocus() {
    this.setData({ searchFocused: true })
  },

  onSearchBlur() {
    this.setData({ searchFocused: false })
  },

  onClearQuery() {
    this.setData({ query: '' })
    this.applyFilter({ ...this.filter, q: '' })
  },
})
