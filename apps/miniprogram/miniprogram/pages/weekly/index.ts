/**
 * 周报 (`?date=<Monday>` optional): one week's report — the AI summary,
 * totals, retention against the week before, the grammar points most often
 * wrong and the most repeated lookups — with previous/next week navigation
 * over the weeks that have a report. Tapping a ranked row searches 词库.
 */
import { errorMessage } from '../../lib/api'
import {
  mergeDates,
  percent,
  rankedRows,
  retentionChange,
  weekNeighbours,
  weekRangeLabel,
  type RankedRow,
  type WeeklyMaterial,
} from '../../lib/weekly'
import { fetchWeekly, fetchWeeklyDates } from '../../services/library'
import { redirectIfInviteRequired } from '../../services/session'
import { currentTheme, watchTheme, type Theme } from '../../services/theme'
import { toast } from '../../services/ui'

interface TotalView {
  key: string
  value: string
  label: string
}

interface WeeklyData {
  theme: Theme
  loading: boolean
  loaded: boolean
  /** Loaded and there is no report at all (or not for the requested week). */
  empty: boolean
  errorText: string
  range: string
  summary: string
  totals: TotalView[]
  thisWeek: string
  lastWeek: string
  change: string
  topErrors: RankedRow[]
  topLookups: RankedRow[]
  hasPrevious: boolean
  hasNext: boolean
}

const initialData: WeeklyData = {
  theme: currentTheme(),
  loading: true,
  loaded: false,
  empty: false,
  errorText: '',
  range: '',
  summary: '',
  totals: [],
  thisWeek: '—',
  lastWeek: '—',
  change: '',
  topErrors: [],
  topLookups: [],
  hasPrevious: false,
  hasNext: false,
}

const reportView = (material: WeeklyMaterial, thisYear: number): Partial<WeeklyData> => {
  const report = material.content
  return {
    range: weekRangeLabel(report.weekStart, report.weekEnd, thisYear),
    summary: report.summary,
    totals: [
      { key: 'entries', value: `${report.totals.entries}`, label: '条查询' },
      { key: 'newItems', value: `${report.totals.newItems}`, label: '个新单元' },
      { key: 'reviews', value: `${report.totals.reviews}`, label: '次复习' },
    ],
    thisWeek: percent(report.retention.thisWeek),
    lastWeek: percent(report.retention.lastWeek),
    change: retentionChange(report.retention.thisWeek, report.retention.lastWeek),
    topErrors: rankedRows(report.topErrors.map((row) => ({ name: row.title, count: row.count }))),
    topLookups: rankedRows(report.topLookups.map((row) => ({ name: row.display, count: row.count }))),
  }
}

type RankedEvent = WechatMiniprogram.BaseEvent<Record<string, never>, { text?: string }>

Page({
  data: initialData,
  /** Mondays with a report, newest first (as far as loaded). */
  dates: [] as string[],
  /** Older dates still to load, or null when the list is complete. */
  nextBefore: null as string | null,
  datesLoaded: false,
  current: null as string | null,
  generation: 0,
  stopWatchingTheme: null as (() => void) | null,

  onLoad(query: Record<string, string | undefined>) {
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    this.setData({ theme: currentTheme() })
    const date = query['date']
    void this.loadDates()
    void this.show(date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null)
  },

  onUnload() {
    this.stopWatchingTheme?.()
    this.generation += 1
  },

  /** Navigation is optional: without the date list the report still shows. */
  async loadDates() {
    try {
      const page = await fetchWeeklyDates(null)
      this.dates = mergeDates(this.dates, page.dates)
      this.nextBefore = page.nextBefore
      this.datesLoaded = true
      this.updateNavigation()
    } catch (error: unknown) {
      console.warn('[weekly] date list failed', error)
    }
  },

  updateNavigation() {
    const current = this.current
    if (current === null || !this.datesLoaded) {
      this.setData({ hasPrevious: false, hasNext: false })
      return
    }
    const { previous, next } = weekNeighbours(this.dates, current)
    this.setData({ hasPrevious: previous !== null || this.nextBefore !== null, hasNext: next !== null })
  },

  /** Shows the report of `monday`, or the latest when null. */
  async show(monday: string | null) {
    this.generation += 1
    const mine = this.generation
    this.setData({ loading: true, errorText: '' })
    try {
      const material = await fetchWeekly(monday)
      if (mine !== this.generation) return
      if (material === null && monday !== null) {
        // That week has no report (any more): show the latest instead.
        void this.show(null)
        return
      }
      if (material === null) {
        this.setData({ empty: true, loaded: true })
        return
      }
      this.current = material.date
      this.dates = mergeDates(this.dates, [material.date])
      this.setData({ ...reportView(material, new Date().getFullYear()), empty: false, loaded: true })
      this.updateNavigation()
    } catch (error: unknown) {
      if (mine !== this.generation || redirectIfInviteRequired(error)) return
      this.setData({ errorText: errorMessage(error) })
    } finally {
      if (mine === this.generation) this.setData({ loading: false })
    }
  },

  async onPrevious() {
    const current = this.current
    if (current === null || this.data.loading) return
    let { previous } = weekNeighbours(this.dates, current)
    if (previous === null && this.nextBefore !== null) {
      try {
        const page = await fetchWeeklyDates(this.nextBefore)
        this.dates = mergeDates(this.dates, page.dates)
        this.nextBefore = page.nextBefore
        previous = weekNeighbours(this.dates, current).previous
      } catch (error: unknown) {
        toast(errorMessage(error))
        return
      }
    }
    if (previous === null) {
      this.updateNavigation()
      toast('没有更早的周报了')
      return
    }
    void this.show(previous)
  },

  onNext() {
    const current = this.current
    if (current === null || this.data.loading) return
    const { next } = weekNeighbours(this.dates, current)
    if (next !== null) void this.show(next)
  },

  onRetry() {
    void this.show(this.current)
  },

  onSearchGrammar(event: RankedEvent) {
    const text = event.currentTarget.dataset.text ?? ''
    if (text !== '') {
      wx.navigateTo({ url: `/pages/library/index?type=grammar&q=${encodeURIComponent(text)}`, fail: () => undefined })
    }
  },

  onSearchLookup(event: RankedEvent) {
    const text = event.currentTarget.dataset.text ?? ''
    if (text !== '') wx.navigateTo({ url: `/pages/library/index?q=${encodeURIComponent(text)}`, fail: () => undefined })
  },
})
