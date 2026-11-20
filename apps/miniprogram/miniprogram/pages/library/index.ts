/**
 * 词库: every learning unit, newest first, searchable (debounced) and
 * filtered by type and level, with infinite scroll. Tapping a row opens the
 * 学习单元. Opened with `?q=` (and optionally `&type=`), e.g. from 周报, it
 * starts with that search.
 */
import { errorMessage } from '../../lib/api'
import {
  EMPTY_FILTER,
  EMPTY_LIBRARY,
  LEVEL_CHIPS,
  SEARCH_DEBOUNCE_MS,
  TYPE_CHIPS,
  appendItems,
  chipLevel,
  chipType,
  emptyLibraryText,
  normalizeQuery,
  sameFilter,
  toLibraryRow,
  type Chip,
  type LibraryFilter,
  type LibraryRow,
  type LibraryState,
} from '../../lib/library'
import { fetchItems } from '../../services/library'
import { redirectIfInviteRequired } from '../../services/session'
import { currentTheme, watchTheme, type Theme } from '../../services/theme'

interface LibraryData {
  theme: Theme
  query: string
  searchFocused: boolean
  /** '' = 全部. */
  typeValue: string
  levelValue: string
  typeChips: readonly Chip[]
  levelChips: readonly Chip[]
  rows: LibraryRow[]
  loading: boolean
  refreshing: boolean
  loaded: boolean
  hasMore: boolean
  errorText: string
  emptyText: string
}

const initialData: LibraryData = {
  theme: currentTheme(),
  query: '',
  searchFocused: false,
  typeValue: '',
  levelValue: '',
  typeChips: TYPE_CHIPS,
  levelChips: LEVEL_CHIPS,
  rows: [],
  loading: false,
  refreshing: false,
  loaded: false,
  hasMore: false,
  errorText: '',
  emptyText: '',
}

type ChipEvent = WechatMiniprogram.BaseEvent<Record<string, never>, { value?: string }>

const decodeParam = (value: string | undefined): string => {
  try {
    return decodeURIComponent(value ?? '')
  } catch {
    return value ?? ''
  }
}

Page({
  data: initialData,
  library: EMPTY_LIBRARY as LibraryState,
  filter: EMPTY_FILTER as LibraryFilter,
  /** Bumped by every new search: responses of an older one are dropped. */
  generation: 0,
  searchTimer: null as ReturnType<typeof setTimeout> | null,
  stopWatchingTheme: null as (() => void) | null,

  onLoad(query: Record<string, string | undefined>) {
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    const q = normalizeQuery(decodeParam(query['q']))
    const type = chipType(query['type'])
    this.filter = { q, type, level: null }
    this.setData({ theme: currentTheme(), query: q, typeValue: type ?? '' })
    void this.reload()
  },

  onUnload() {
    this.stopWatchingTheme?.()
    this.cancelSearchTimer()
    this.generation += 1
  },

  cancelSearchTimer() {
    if (this.searchTimer !== null) clearTimeout(this.searchTimer)
    this.searchTimer = null
  },

  applyFilter(filter: LibraryFilter) {
    this.cancelSearchTimer()
    if (sameFilter(filter, this.filter) && this.data.loaded && this.data.errorText === '') return
    this.filter = filter
    void this.reload()
  },

  show(library: LibraryState, extra: Partial<LibraryData> = {}) {
    this.library = library
    this.setData({
      rows: library.items.map(toLibraryRow),
      hasMore: library.nextOffset !== null,
      emptyText: emptyLibraryText(this.filter),
      ...extra,
    })
  },

  async reload() {
    this.generation += 1
    const mine = this.generation
    this.setData({ loading: true, errorText: '' })
    try {
      const page = await fetchItems(this.filter, 0)
      if (mine !== this.generation) return
      this.show(appendItems(EMPTY_LIBRARY, page), { loaded: true })
    } catch (error: unknown) {
      if (mine !== this.generation || redirectIfInviteRequired(error)) return
      this.show(EMPTY_LIBRARY, { loaded: true, errorText: errorMessage(error) })
    } finally {
      if (mine === this.generation) this.setData({ loading: false, refreshing: false })
    }
  },

  async onLoadMore() {
    const offset = this.library.nextOffset
    if (this.data.loading || offset === null) return
    const mine = this.generation
    this.setData({ loading: true, errorText: '' })
    try {
      const page = await fetchItems(this.filter, offset)
      if (mine !== this.generation) return
      this.show(appendItems(this.library, page))
    } catch (error: unknown) {
      if (mine !== this.generation) return
      this.setData({ errorText: errorMessage(error) })
    } finally {
      if (mine === this.generation) this.setData({ loading: false })
    }
  },

  onRefresh() {
    this.setData({ refreshing: true })
    void this.reload()
  },

  onQueryInput(event: WechatMiniprogram.Input) {
    const query = event.detail.value
    this.setData({ query })
    this.cancelSearchTimer()
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null
      this.applyFilter({ ...this.filter, q: query })
    }, SEARCH_DEBOUNCE_MS)
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

  onTypeChip(event: ChipEvent) {
    const type = chipType(event.currentTarget.dataset.value)
    this.setData({ typeValue: type ?? '' })
    this.applyFilter({ ...this.filter, q: this.data.query, type })
  },

  onLevelChip(event: ChipEvent) {
    const level = chipLevel(event.currentTarget.dataset.value)
    this.setData({ levelValue: level ?? '' })
    this.applyFilter({ ...this.filter, q: this.data.query, level })
  },

  onOpen(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: string }>) {
    const id = event.currentTarget.dataset.id
    if (id === undefined || id === '') return
    wx.navigateTo({ url: `/pages/item/index?id=${encodeURIComponent(id)}`, fail: () => undefined })
  },
})
