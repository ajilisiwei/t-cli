/**
 * 学习统计: streak, a 17-week calendar heatmap (records + reviews per day),
 * 12 weeks of retention as bars, and totals. Restrained on purpose: no
 * points, no rankings (design: "克制的激励").
 */
import { errorMessage } from '../../lib/api'
import { localDateKey } from '../../lib/history'
import {
  HEATMAP_WEEKS,
  RETENTION_WEEKS,
  buildHeatmap,
  buildRetentionBars,
  heatmapDays,
  monthMarks,
  retentionSummary,
  totalCells,
  type HeatColumn,
  type MonthMark,
  type RetentionBar,
  type Stats,
  type TotalCell,
} from '../../lib/stats'
import { fetchStats } from '../../services/library'
import { redirectIfInviteRequired } from '../../services/session'
import { currentTheme, watchTheme, type Theme } from '../../services/theme'

interface StatsData {
  theme: Theme
  loading: boolean
  loaded: boolean
  errorText: string
  streakDays: number
  activeText: string
  columns: HeatColumn[]
  months: MonthMark[]
  /** Row labels left of the heatmap (Monday on top). */
  weekdays: { key: string; label: string }[]
  /** What the tapped day had (or a hint). */
  selected: string
  bars: RetentionBar[]
  retentionText: string
  totals: TotalCell[]
}

const DAY_HINT = '点一格看当天'

/** Heatmap geometry in rpx, mirrored in index.wxss: weekday labels + gap, then cell + gap per column. */
const FIRST_COLUMN_RPX = 48
const COLUMN_PITCH_RPX = 36

const initialData: StatsData = {
  theme: currentTheme(),
  loading: true,
  loaded: false,
  errorText: '',
  streakDays: 0,
  activeText: '',
  columns: [],
  months: [],
  weekdays: ['一', '', '三', '', '五', '', ''].map((label, i) => ({ key: `${i}`, label })),
  selected: DAY_HINT,
  bars: [],
  retentionText: '',
  totals: [],
}

const statsView = (stats: Stats, today: string): Partial<StatsData> => {
  const heatmap = buildHeatmap(stats.days, today, HEATMAP_WEEKS)
  const bars = buildRetentionBars(stats.retention, today, RETENTION_WEEKS)
  return {
    streakDays: stats.streakDays,
    activeText:
      heatmap.activeDays === 0 ? `近 ${HEATMAP_WEEKS} 周还没有记录` : `近 ${HEATMAP_WEEKS} 周有 ${heatmap.activeDays} 天在学`,
    columns: [...heatmap.columns],
    months: monthMarks(heatmap.columns, FIRST_COLUMN_RPX, COLUMN_PITCH_RPX),
    selected: DAY_HINT,
    bars,
    retentionText: retentionSummary(bars),
    totals: totalCells(stats.totals),
  }
}

Page({
  data: initialData,
  stopWatchingTheme: null as (() => void) | null,

  onLoad() {
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    this.setData({ theme: currentTheme() })
    void this.load()
  },

  onUnload() {
    this.stopWatchingTheme?.()
  },

  async load() {
    this.setData({ loading: true, errorText: '' })
    try {
      const stats = await fetchStats(heatmapDays(HEATMAP_WEEKS))
      this.setData({ ...statsView(stats, localDateKey(new Date())), loaded: true })
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      this.setData({ errorText: errorMessage(error) })
    } finally {
      this.setData({ loading: false })
    }
  },

  onRetry() {
    void this.load()
  },

  onDay(event: WechatMiniprogram.BaseEvent<Record<string, never>, { col?: number; row?: number }>) {
    const { col, row } = event.currentTarget.dataset
    const cell = this.data.columns[Number(col)]?.cells[Number(row)]
    if (cell === undefined || cell.future) return
    this.setData({ selected: cell.label })
  },
})
