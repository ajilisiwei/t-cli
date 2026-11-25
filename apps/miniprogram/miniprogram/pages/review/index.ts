/**
 * 学习 (tab; the route stays pages/review/index because reminder messages
 * open it): today's review with the scope choice (全部到期 / 只复习笔记本 /
 * 3 星以上), the latest 学习资料, 打印与导出 (本周合集, 单词卡, 自测清单 → the
 * export sheet; 导出记录) and the 学习计划 line. Every show re-reads
 * `GET /v1/learn/summary`, which also refreshes the tab badge.
 *
 * Against a server without the summary (404) the page falls back to the
 * review summary: no scope choice and no materials.
 */
import { errorMessage } from '../../lib/api'
import { localDateKey } from '../../lib/history'
import type { LearnSummary, MaterialListItem, ReviewScope } from '../../lib/learn-types'
import {
  KIND_LABELS,
  exportMaterialOf,
  homeDateLabel,
  isReviewScope,
  materialKey,
  materialMeta,
  materialStatus,
  materialUrl,
  noMaterialsText,
  planSummary,
  scopeChips,
  startLabel,
  todayView,
  type ScopeChip,
  type TodayView,
} from '../../lib/learn-view'
import type { ExportInput, ExportMaterial, SheetScope } from '../../lib/pdf-export'
import { fetchLearnSummary, fetchThisWeek, isNotFound } from '../../services/learn'
import { pruneExports } from '../../services/pdf'
import { askForReminderThen, loadReminderConfig, loadSummary } from '../../services/review'
import { redirectIfInviteRequired } from '../../services/session'
import { currentSettings, watchSettings } from '../../services/settings'
import { bindPageLook, currentLook, type Look } from '../../services/theme'
import { toast } from '../../services/ui'

const SESSION_PAGE = '/pages/review-session/index'

interface MaterialCard {
  key: string
  /** full: a 周期资料 with 开始学习 and PDF; card: an extension; row: a report. */
  layout: 'full' | 'card' | 'row'
  kindLabel: string
  dateLabel: string
  status: string
  statusTone: string
  title: string
  /** An extension's first reason; '' otherwise. */
  subtitle: string
  meta: string
  url: string
}

interface PrintTile {
  id: SheetScope
  icon: string
  label: string
  hint: string
  off: boolean
}

interface LearnHomeData extends Look {
  loaded: boolean
  errorText: string
  refreshing: boolean
  today: TodayView
  /** The server knows review scopes (v3). */
  scopeAvailable: boolean
  scope: ReviewScope
  scopes: ScopeChip[]
  /** '' when the chosen scope has nothing due. */
  startText: string
  materials: MaterialCard[]
  materialsEmpty: string
  tiles: PrintTile[]
  exportCount: number
  planText: string
  exportOpen: boolean
  exportInput: ExportInput
}

const EMPTY_REVIEW: LearnSummary['review'] = {
  dueByScope: { all: 0, notes: 0, stars3: 0 },
  doneToday: 0,
  estimatedMinutes: 0,
  streakDays: 0,
}

const NO_EXPORT: ExportInput = { origin: 'home', selection: [], week: [], initial: 'week' }

const planText = (): string => {
  const s = currentSettings()
  return planSummary({
    materialFrequency: s.materialFrequency,
    materialWeekday: s.materialWeekday,
    extendEnabled: s.extendEnabled,
    reminderHour: s.reminderHour,
  })
}

const cardOf = (item: MaterialListItem, today: string): MaterialCard => {
  const status = materialStatus(item)
  return {
    key: materialKey(item),
    layout: item.kind === 'weekly' ? 'row' : item.kind === 'extend' ? 'card' : 'full',
    kindLabel: KIND_LABELS[item.kind],
    dateLabel: homeDateLabel(item, today),
    status: status?.text ?? '',
    statusTone: status?.tone ?? '',
    title: item.title === '' ? KIND_LABELS[item.kind] : item.title,
    subtitle: item.subtitle ?? '',
    meta: materialMeta(item, currentSettings().materialParts),
    url: materialUrl(item),
  }
}

const sum = (materials: readonly ExportMaterial[], pick: (material: ExportMaterial) => number): number =>
  materials.reduce((total, material) => total + pick(material), 0)

const tilesFor = (week: readonly ExportMaterial[]): PrintTile[] => {
  const empty = week.length === 0
  return [
    {
      id: 'week',
      icon: 'doc',
      label: '本周合集',
      hint: empty ? '本周还没有资料' : `${week.length} 份 · 约 ${sum(week, (m) => m.pages)} 页`,
      off: empty,
    },
    { id: 'cards', icon: 'cards', label: '单词卡', hint: empty ? '剪开对折' : `剪开对折 · ${sum(week, (m) => m.words)} 张`, off: empty },
    { id: 'checklist', icon: 'checklist', label: '自测清单', hint: '对折遮住释义', off: false },
  ]
}

const initialData: LearnHomeData = {
  ...currentLook(),
  loaded: false,
  errorText: '',
  refreshing: false,
  today: todayView(EMPTY_REVIEW),
  scopeAvailable: false,
  scope: 'all',
  scopes: scopeChips(EMPTY_REVIEW.dueByScope, 'all'),
  startText: '',
  materials: [],
  materialsEmpty: '',
  tiles: tilesFor([]),
  exportCount: 0,
  planText: planText(),
  exportOpen: false,
  exportInput: NO_EXPORT,
}

Page({
  data: initialData,
  stopWatching: [] as (() => void)[],
  review: EMPTY_REVIEW,
  /** The summary's latest materials, by key (the PDF button finds its material here). */
  latest: [] as MaterialListItem[],
  week: [] as ExportMaterial[],
  /** 开始复习 was tapped and the session page is opening (no double navigation). */
  starting: false,

  onLoad() {
    this.stopWatching = [
      bindPageLook(this),
      watchSettings(() => this.setData({ planText: planText(), materials: this.cards() })),
    ]
  },

  onShow() {
    this.setData({ planText: planText(), exportCount: pruneExports().length })
    void this.load()
  },

  onUnload() {
    for (const stop of this.stopWatching) stop()
    this.stopWatching = []
  },

  async onRefresh() {
    this.setData({ refreshing: true })
    await this.load()
    this.setData({ refreshing: false })
  },

  onRetry() {
    void this.load()
  },

  async load(): Promise<void> {
    await Promise.all([this.loadSummary(), this.loadWeek(), loadReminderConfig()])
  },

  async loadSummary(): Promise<void> {
    try {
      const summary = await fetchLearnSummary()
      this.latest = [...summary.materials]
      this.showReview(summary.review, true)
      this.setData({
        materials: this.cards(),
        materialsEmpty: summary.materials.length === 0 ? noMaterialsText(currentSettings().materialFrequency) : '',
      })
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      if (isNotFound(error)) {
        await this.loadOldSummary()
        return
      }
      this.setData({ errorText: errorMessage(error) })
    }
  },

  /** A server before v3: the review summary only. */
  async loadOldSummary(): Promise<void> {
    try {
      const old = await loadSummary()
      const due = old.due
      this.latest = []
      this.showReview({ ...old, dueByScope: { all: due, notes: due, stars3: due } }, false)
      this.setData({ materials: [], materialsEmpty: '' })
    } catch (error: unknown) {
      if (!redirectIfInviteRequired(error)) this.setData({ errorText: errorMessage(error) })
    }
  },

  showReview(review: LearnSummary['review'], scopeAvailable: boolean) {
    this.review = review
    const scope = scopeAvailable ? this.data.scope : 'all'
    this.setData({
      loaded: true,
      errorText: '',
      today: todayView(review),
      scopeAvailable,
      scope,
      scopes: scopeChips(review.dueByScope, scope),
      startText: startLabel(scope, review.dueByScope[scope]),
    })
  },

  cards(): MaterialCard[] {
    const today = localDateKey(new Date())
    return this.latest.map((item) => cardOf(item, today))
  },

  async loadWeek(): Promise<void> {
    try {
      const items = await fetchThisWeek()
      this.week = items.flatMap((item) => exportMaterialOf(item) ?? [])
      this.setData({ tiles: tilesFor(this.week) })
    } catch (error: unknown) {
      // The tiles only lose their counts; the checklist still works.
      console.warn('[learn] this week not loaded', error)
    }
  },

  onScope(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: string }>) {
    const scope = event.currentTarget.dataset.id
    if (!isReviewScope(scope) || scope === this.data.scope) return
    const due = this.review.dueByScope
    this.setData({ scope, scopes: scopeChips(due, scope), startText: startLabel(scope, due[scope]) })
  },

  onStart() {
    if (this.starting || this.data.startText === '') return
    this.starting = true
    const url = this.data.scope === 'all' ? SESSION_PAGE : `${SESSION_PAGE}?scope=${this.data.scope}`
    // Synchronously inside the tap: the subscribe dialog needs the user gesture.
    askForReminderThen(currentSettings().reminderHour, () => {
      wx.navigateTo({
        url,
        complete: () => {
          this.starting = false
        },
      })
    })
  },

  onOpen(event: WechatMiniprogram.BaseEvent<Record<string, never>, { url?: string }>) {
    const url = event.currentTarget.dataset.url
    if (url !== undefined) wx.navigateTo({ url, fail: () => undefined })
  },

  onAllMaterials() {
    wx.navigateTo({ url: '/pages/learn-materials/index', fail: () => undefined })
  },

  onMaterialPdf(event: WechatMiniprogram.BaseEvent<Record<string, never>, { key?: string }>) {
    const item = this.latest.find((candidate) => materialKey(candidate) === event.currentTarget.dataset.key)
    const material = item === undefined ? null : exportMaterialOf(item)
    if (material === null) return
    this.openExport({ origin: 'material', selection: [material], week: this.week, initial: 'one' })
  },

  onTile(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: SheetScope; off?: boolean }>) {
    const { id, off } = event.currentTarget.dataset
    if (id === undefined) return
    if (off === true) {
      toast('本周还没有资料，可以先导出自测清单')
      return
    }
    this.openExport({ origin: 'home', selection: [], week: this.week, initial: id })
  },

  openExport(input: ExportInput) {
    this.setData({ exportInput: input, exportOpen: true })
  },

  onExportClose() {
    this.setData({ exportOpen: false })
  },

  onExported() {
    this.setData({ exportCount: pruneExports().length })
  },

  onExports() {
    wx.navigateTo({ url: '/pages/exports/index', fail: () => undefined })
  },

  onPlan() {
    wx.navigateTo({ url: '/pages/learn-plan/index', fail: () => undefined })
  },
})
