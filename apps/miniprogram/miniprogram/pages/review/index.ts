/**
 * 复习 (tab): answers one question — how many cards today, start? One ring
 * (done of done + due), one button, then the latest 每日材料, 词库 and 周报.
 * Every show re-reads the summary, which also refreshes the tab badge.
 */
import { errorMessage } from '../../lib/api'
import { storySpeechKey } from '../../lib/review-card'
import { formatDateLabel, materialTitle } from '../../lib/review-format'
import { homeView, ringStyle, type HomeView, type RingStyle } from '../../lib/review-home'
import { materialCounts } from '../../lib/review-material'
import type { DailyMaterialResponse } from '../../lib/review-types'
import { localDateKey } from '../../lib/history'
import { paletteFor } from '../../lib/palette'
import { speechPhase, type SpeechPhase, type SpeechStatus } from '../../lib/speaker'
import { askForReminderThen, fetchDailyMaterial, loadReminderConfig, loadSummary } from '../../services/review'
import { redirectIfInviteRequired } from '../../services/session'
import { reminderHour } from '../../services/settings'
import { speechStatus, stopSpeaking, toggleSpeech, watchSpeech } from '../../services/speech'
import { currentLook, watchLook, type Look } from '../../services/theme'
import { toast } from '../../services/ui'

const SESSION_PAGE = '/pages/review-session/index'
const MATERIALS_PAGE = '/pages/materials/index'

interface MaterialCard {
  date: string
  title: string
  counts: string
  hasStory: boolean
}

interface ReviewHomeData extends Look {
  dateLabel: string
  loaded: boolean
  view: HomeView
  ring: RingStyle
  errorText: string
  refreshing: boolean
  material: MaterialCard | null
  /** The latest material was looked up and there is none yet. */
  materialMissing: boolean
  storyPhase: SpeechPhase
}

const EMPTY_VIEW: HomeView = homeView({
  due: 0,
  newAvailable: 0,
  reviewDue: 0,
  doneToday: 0,
  estimatedMinutes: 0,
  streakDays: 0,
})

/** The ring in the theme's and accent's colours (literal: they go into an inline gradient). */
const ringFor = (view: HomeView, look: Pick<Look, 'theme' | 'accent'>): RingStyle => {
  const palette = paletteFor(look.theme, look.accent)
  return ringStyle(view.ringDegrees, palette.accent, palette.rule)
}

const initialData: ReviewHomeData = {
  ...currentLook(),
  dateLabel: '',
  loaded: false,
  view: EMPTY_VIEW,
  ring: ringFor(EMPTY_VIEW, currentLook()),
  errorText: '',
  refreshing: false,
  material: null,
  materialMissing: false,
  storyPhase: 'idle',
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
  stopWatchingSpeech: null as (() => void) | null,
  /** The audio key of the latest material's story; '' without one. */
  storyKey: '',
  /** 开始复习 was tapped and the session page is opening (no double navigation). */
  starting: false,

  onLoad() {
    this.stopWatchingTheme = watchLook((look) => this.setData({ ...look, ring: ringFor(this.data.view, look) }))
    this.stopWatchingSpeech = watchSpeech((speech) => this.syncSpeech(speech))
    const look = currentLook()
    this.setData({ ...look, ring: ringFor(this.data.view, look) })
  },

  onShow() {
    this.setData({ dateLabel: formatDateLabel(localDateKey(new Date())) })
    void this.load()
  },

  onHide() {
    stopSpeaking()
  },

  onUnload() {
    this.stopWatchingTheme?.()
    this.stopWatchingSpeech?.()
  },

  syncSpeech(speech: SpeechStatus) {
    const storyPhase = speechPhase(speech, this.storyKey)
    if (storyPhase !== this.data.storyPhase) this.setData({ storyPhase })
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
      const view = homeView(summary)
      this.setData({ view, ring: ringFor(view, this.data), loaded: true, errorText: '' })
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      this.setData({ errorText: errorMessage(error) })
    }
  },

  async loadMaterial(): Promise<void> {
    try {
      const material = await fetchDailyMaterial()
      const story = material?.content.story ?? null
      this.storyKey = material === null || story === null ? '' : storySpeechKey(material.date, story.text)
      this.setData({
        material: material === null ? null : materialCard(material, localDateKey(new Date())),
        materialMissing: material === null,
        storyPhase: speechPhase(speechStatus(), this.storyKey),
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
    if (material === null || this.storyKey === '') return
    toggleSpeech({ material: { kind: 'daily', date: material.date, section: 'story' } }, this.storyKey).catch(
      (error: unknown) => toast(errorMessage(error)),
    )
  },

  onLibrary() {
    wx.navigateTo({ url: '/pages/library/index', fail: () => undefined })
  },

  onWeekly() {
    wx.navigateTo({ url: '/pages/weekly/index', fail: () => undefined })
  },
})
