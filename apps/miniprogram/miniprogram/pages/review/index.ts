/**
 * 复习 (tab): answers one question — how many cards today, start? One ring
 * (done of done + due), one button, then the latest 每日材料, 词库 and 周报.
 * Every show re-reads the summary, which also refreshes the tab badge.
 */
import { errorMessage } from '../../lib/api'
import { fingerprint } from '../../lib/review-card'
import { formatDateLabel, materialTitle } from '../../lib/review-format'
import { homeView, type HomeView } from '../../lib/review-home'
import { materialCounts } from '../../lib/review-material'
import type { DailyMaterialResponse } from '../../lib/review-types'
import { localDateKey } from '../../lib/history'
import { askForReminderThen, fetchDailyMaterial, loadReminderConfig, loadSummary } from '../../services/review'
import { redirectIfInviteRequired } from '../../services/session'
import { reminderHour } from '../../services/settings'
import { speakSource, stopSourceSpeech } from '../../services/speech'
import { currentTheme, watchTheme, type Theme } from '../../services/theme'
import { toast } from '../../services/ui'

const SESSION_PAGE = '/pages/review-session/index'
const MATERIALS_PAGE = '/pages/materials/index'

interface MaterialCard {
  date: string
  title: string
  counts: string
  hasStory: boolean
}

interface ReviewHomeData {
  theme: Theme
  dateLabel: string
  loaded: boolean
  view: HomeView
  errorText: string
  refreshing: boolean
  material: MaterialCard | null
  /** The latest material was looked up and there is none yet. */
  materialMissing: boolean
  playingStory: boolean
}

const EMPTY_VIEW: HomeView = homeView({
  due: 0,
  newAvailable: 0,
  reviewDue: 0,
  doneToday: 0,
  estimatedMinutes: 0,
  streakDays: 0,
})

const initialData: ReviewHomeData = {
  theme: currentTheme(),
  dateLabel: '',
  loaded: false,
  view: EMPTY_VIEW,
  errorText: '',
  refreshing: false,
  material: null,
  materialMissing: false,
  playingStory: false,
}

const materialCard = (material: DailyMaterialResponse, today: string): MaterialCard => ({
  date: material.date,
  title: materialTitle(material.date, today),
  counts: materialCounts(material.content) || '这天没有新内容',
  hasStory: material.content.story !== null,
})

Page({
  data: initialData,
  stopWatchingTheme: null as (() => void) | null,
  /** The latest material's story text: its audio cache key. */
  storyText: '',
  /** Counts story playbacks, so a stale one does not clear a newer one's state. */
  storyPlays: 0,
  /** 开始复习 was tapped and the session page is opening (no double navigation). */
  starting: false,

  onLoad() {
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    this.setData({ theme: currentTheme() })
  },

  onShow() {
    this.setData({ dateLabel: formatDateLabel(localDateKey(new Date())) })
    void this.load()
  },

  onHide() {
    stopSourceSpeech()
    this.setData({ playingStory: false })
  },

  onUnload() {
    this.stopWatchingTheme?.()
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
    await Promise.all([this.loadSummary(), this.loadMaterial(), loadReminderConfig()])
  },

  async loadSummary(): Promise<void> {
    try {
      const summary = await loadSummary()
      this.setData({ view: homeView(summary), loaded: true, errorText: '' })
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      this.setData({ errorText: errorMessage(error) })
    }
  },

  async loadMaterial(): Promise<void> {
    try {
      const material = await fetchDailyMaterial()
      this.storyText = material?.content.story?.text ?? ''
      this.setData({
        material: material === null ? null : materialCard(material, localDateKey(new Date())),
        materialMissing: material === null,
      })
    } catch (error: unknown) {
      // The summary reports being offline; the material block just stays as it was.
      console.warn('[review] latest material not loaded', error)
    }
  },

  onStart() {
    if (this.starting) return
    this.starting = true
    // Synchronously inside the tap: the subscribe dialog needs the user gesture.
    askForReminderThen(reminderHour(), () => {
      wx.navigateTo({
        url: SESSION_PAGE,
        complete: () => {
          this.starting = false
        },
      })
    })
  },

  onMaterial() {
    const date = this.data.material?.date
    wx.navigateTo({ url: date === undefined ? MATERIALS_PAGE : `${MATERIALS_PAGE}?date=${date}`, fail: () => undefined })
  },

  onPlayStory() {
    const material = this.data.material
    if (material === null || this.storyText === '') return
    if (this.data.playingStory) {
      stopSourceSpeech()
      this.setData({ playingStory: false })
      return
    }
    this.storyPlays += 1
    const play = this.storyPlays
    this.setData({ playingStory: true })
    speakSource(
      { material: { kind: 'daily', date: material.date, section: 'story' } },
      `s-${material.date}-${fingerprint(this.storyText)}`,
    )
      .catch((error: unknown) => toast(errorMessage(error)))
      .finally(() => {
        if (play === this.storyPlays) this.setData({ playingStory: false })
      })
  },

  onLibrary() {
    wx.navigateTo({ url: '/pages/library/index', fail: () => undefined })
  },

  onWeekly() {
    wx.navigateTo({ url: '/pages/weekly/index', fail: () => undefined })
  },
})
