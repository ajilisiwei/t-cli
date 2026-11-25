/**
 * 学习资料: every material, newest first, grouped by week (本周, 上周, …),
 * filtered by kind (全部 / 周期资料 / 拓展 / 周报) and marked 未读 / 新 / 已学完.
 * 选择 turns the rows into checkboxes: the chosen materials (at most 8, no
 * reports) go into one PDF through the export sheet.
 */
import { errorMessage } from '../../lib/api'
import { localDateKey } from '../../lib/history'
import type { MaterialListItem } from '../../lib/learn-types'
import {
  MAX_EXPORT_MATERIALS,
  appendItems,
  exportMaterialOf,
  groupByWeek,
  materialKey,
  materialRow,
  type MaterialRow,
  type WeekGroup,
} from '../../lib/learn-view'
import type { ExportInput, ExportMaterial } from '../../lib/pdf-export'
import { fetchMaterialList, fetchThisWeek, type ListKind } from '../../services/learn'
import { safeBottomInset } from '../../services/platform'
import { redirectIfInviteRequired } from '../../services/session'
import { currentSettings } from '../../services/settings'
import { bindPageLook, currentLook, type Look } from '../../services/theme'
import { toast } from '../../services/ui'

type Tab = 'all' | 'periodic' | 'extend' | 'weekly'

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'periodic', label: '周期资料' },
  { id: 'extend', label: '拓展' },
  { id: 'weekly', label: '周报' },
]

/** 周期资料 (daily materials and digests) is filtered by the server, like every tab. */
const API_KIND: Readonly<Record<Tab, ListKind>> = { all: 'all', periodic: 'periodic', extend: 'extend', weekly: 'weekly' }

const EMPTY_TEXT: Readonly<Record<Tab, string>> = {
  all: '还没有学习资料。每天早上 5 点，前一天查过的词句会整理成一份资料。',
  periodic: '还没有周期资料。',
  extend: '还没有拓展资料。开启后每周一出一份。',
  weekly: '还没有周报。每周日早上出上一周的。',
}

interface RowView extends MaterialRow {
  checked: boolean
}

interface ListData extends Look {
  tabs: typeof TABS
  tab: Tab
  phase: 'loading' | 'ready' | 'error'
  errorText: string
  groups: WeekGroup<RowView>[]
  count: number
  hasMore: boolean
  loadingMore: boolean
  refreshing: boolean
  selecting: boolean
  selectedCount: number
  selectedPages: number
  emptyText: string
  safeBottom: number
  exportOpen: boolean
  exportInput: ExportInput
}

const initialData: ListData = {
  ...currentLook(),
  tabs: TABS,
  tab: 'all',
  phase: 'loading',
  errorText: '',
  groups: [],
  count: 0,
  hasMore: false,
  loadingMore: false,
  refreshing: false,
  selecting: false,
  selectedCount: 0,
  selectedPages: 0,
  emptyText: EMPTY_TEXT.all,
  safeBottom: 0,
  exportOpen: false,
  exportInput: { origin: 'selection', selection: [], week: [], initial: 'selected' },
}

Page({
  data: initialData,
  stopWatchingTheme: null as (() => void) | null,
  items: [] as MaterialListItem[],
  nextBefore: null as string | null,
  /** Chosen materials by key, in the order they were picked. */
  picked: [] as ExportMaterial[],
  week: [] as ExportMaterial[],
  /** Bumped by every first-page load, so a slow answer for another tab is ignored. */
  generation: 0,
  shown: false,

  onLoad() {
    this.stopWatchingTheme = bindPageLook(this)
    this.setData({ safeBottom: safeBottomInset() })
  },

  onShow() {
    // Coming back from a material: its 学完了 may have changed.
    void this.loadFirst(this.shown)
    this.shown = true
    fetchThisWeek()
      .then((items) => {
        this.week = items.flatMap((item) => exportMaterialOf(item) ?? [])
      })
      .catch((error: unknown) => console.warn('[learn-materials] this week not loaded', error))
  },

  onUnload() {
    this.stopWatchingTheme?.()
  },

  /** The first page of the current tab; `quiet` keeps the rows on screen meanwhile. */
  async loadFirst(quiet = false): Promise<void> {
    this.generation += 1
    const generation = this.generation
    if (!quiet) this.setData({ phase: 'loading', errorText: '' })
    try {
      const page = await fetchMaterialList(API_KIND[this.data.tab], null)
      if (generation !== this.generation) return
      this.items = [...page.items]
      this.nextBefore = page.nextBefore
      this.render()
    } catch (error: unknown) {
      if (generation !== this.generation || redirectIfInviteRequired(error)) return
      if (quiet) console.warn('[learn-materials] refresh failed', error)
      else this.setData({ phase: 'error', errorText: errorMessage(error) })
    }
  },

  async onMore() {
    if (this.nextBefore === null || this.data.loadingMore || this.data.phase !== 'ready') return
    const generation = this.generation
    this.setData({ loadingMore: true })
    try {
      const page = await fetchMaterialList(API_KIND[this.data.tab], this.nextBefore)
      if (generation !== this.generation) return
      this.items = appendItems(this.items, page.items)
      this.nextBefore = page.nextBefore
      this.render()
    } catch (error: unknown) {
      toast(errorMessage(error))
    } finally {
      this.setData({ loadingMore: false })
    }
  },

  onRetry() {
    void this.loadFirst()
  },

  async onRefresh() {
    this.setData({ refreshing: true })
    await this.loadFirst(true)
    this.setData({ refreshing: false })
  },

  render() {
    const parts = currentSettings().materialParts
    const pickedKeys = new Set(this.picked.map((material) => materialKey(material)))
    const rows = this.items.map((item): RowView => ({ ...materialRow(item, parts), checked: pickedKeys.has(materialKey(item)) }))
    this.setData({
      phase: 'ready',
      groups: groupByWeek(rows, localDateKey(new Date())),
      count: rows.length,
      hasMore: this.nextBefore !== null,
      emptyText: EMPTY_TEXT[this.data.tab],
      selectedCount: this.picked.length,
      selectedPages: this.picked.reduce((sum, material) => sum + material.pages, 0),
    })
  },

  onTab(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: Tab }>) {
    const tab = event.currentTarget.dataset.id
    if (tab === undefined || tab === this.data.tab) return
    this.setData({ tab, groups: [], count: 0 })
    void this.loadFirst()
  },

  onToggleSelect() {
    const selecting = !this.data.selecting
    if (!selecting) this.picked = []
    this.setData({ selecting })
    this.render()
  },

  onRow(event: WechatMiniprogram.BaseEvent<Record<string, never>, { key?: string; url?: string }>) {
    const { key, url } = event.currentTarget.dataset
    if (!this.data.selecting) {
      if (url !== undefined) wx.navigateTo({ url, fail: () => undefined })
      return
    }
    const item = this.items.find((candidate) => materialKey(candidate) === key)
    const material = item === undefined ? null : exportMaterialOf(item)
    if (material === null) {
      toast('周报不能导出 PDF')
      return
    }
    const already = this.picked.some((picked) => materialKey(picked) === key)
    if (!already && this.picked.length >= MAX_EXPORT_MATERIALS) {
      toast(`一次最多合并 ${MAX_EXPORT_MATERIALS} 份`)
      return
    }
    this.picked = already ? this.picked.filter((picked) => materialKey(picked) !== key) : [...this.picked, material]
    this.render()
  },

  onExport() {
    if (this.picked.length === 0) return
    // Oldest first reads like a book.
    const selection = [...this.picked].sort((a, b) => a.date.localeCompare(b.date))
    this.setData({
      exportInput: { origin: 'selection', selection, week: this.week, initial: 'selected' },
      exportOpen: true,
    })
  },

  onExportClose() {
    this.setData({ exportOpen: false })
  },
})
