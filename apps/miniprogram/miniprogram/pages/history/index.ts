/**
 * 我的 → 记录: every query from the CLI and the phone, newest first, with
 * infinite scroll. The first page is cached so records stay readable offline;
 * tapping a row shows the stored result instead of asking again.
 */
import { errorMessage } from '../../lib/api'
import {
  EMPTY_HISTORY,
  appendPage,
  dayKeys,
  readHistoryPage,
  toHistoryRow,
  type HistoryRow,
  type HistoryState,
} from '../../lib/history'
import { fetchHistory } from '../../services/endpoints'
import { redirectIfInviteRequired } from '../../services/session'
import { STORAGE_KEYS, readStorage, writeStorage } from '../../services/storage'
import { currentTheme, watchTheme, type Theme } from '../../services/theme'

interface HistoryData {
  theme: Theme
  rows: HistoryRow[]
  expandedId: string
  loading: boolean
  refreshing: boolean
  hasMore: boolean
  /** Showing the cached first page because the network failed. */
  offline: boolean
  errorText: string
  loaded: boolean
}

const initialData: HistoryData = {
  theme: currentTheme(),
  rows: [],
  expandedId: '',
  loading: false,
  refreshing: false,
  hasMore: false,
  offline: false,
  errorText: '',
  loaded: false,
}

Page({
  data: initialData,
  history: EMPTY_HISTORY as HistoryState,
  stopWatchingTheme: null as (() => void) | null,

  onLoad() {
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    this.setData({ theme: currentTheme() })
    const cached = readHistoryPage(readStorage(STORAGE_KEYS.historyFirstPage))
    if (cached !== null) this.show(appendPage(EMPTY_HISTORY, cached), { loaded: true })
    void this.loadFirstPage()
  },

  onUnload() {
    this.stopWatchingTheme?.()
  },

  show(history: HistoryState, extra: Partial<HistoryData> = {}) {
    this.history = history
    const { today, yesterday } = dayKeys(new Date())
    this.setData({
      rows: history.entries.map((entry) => toHistoryRow(entry, today, yesterday)),
      hasMore: history.hasMore,
      ...extra,
    })
  },

  async loadFirstPage() {
    this.setData({ loading: true, errorText: '' })
    try {
      const page = await fetchHistory(null)
      writeStorage(STORAGE_KEYS.historyFirstPage, page)
      this.show(appendPage(EMPTY_HISTORY, page), { offline: false, loaded: true })
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      const hasCache = this.history.entries.length > 0
      this.setData({ offline: hasCache, errorText: errorMessage(error), loaded: true })
    } finally {
      this.setData({ loading: false, refreshing: false })
    }
  },

  async onLoadMore() {
    const { history } = this
    if (this.data.loading || this.data.offline || !history.hasMore || history.nextBefore === null) return
    this.setData({ loading: true, errorText: '' })
    try {
      const page = await fetchHistory(history.nextBefore)
      this.show(appendPage(this.history, page))
    } catch (error: unknown) {
      this.setData({ errorText: errorMessage(error) })
    } finally {
      this.setData({ loading: false })
    }
  },

  onRefresh() {
    this.setData({ refreshing: true })
    void this.loadFirstPage()
  },

  onToggle(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: string }>) {
    const id = event.currentTarget.dataset.id ?? ''
    this.setData({ expandedId: this.data.expandedId === id ? '' : id })
  },
})
