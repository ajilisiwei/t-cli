/**
 * 每日材料: one day's material, switched by section (概览 · 单词 · 句型 · 语法 ·
 * 短文 · 易错) and paged by date (‹ older, › newer). 朗读 reads a word or phrase
 * (TTS by item) or the story (TTS by material); grammar exercises show their
 * answer on tap. Opens on `?date=YYYY-MM-DD`, or on the latest material.
 */
import { errorMessage } from '../../lib/api'
import { fingerprint, storySpeechKey } from '../../lib/review-card'
import { formatDateLabel } from '../../lib/review-format'
import {
  dateNeighbours,
  grammarViews,
  overviewStats,
  phraseViews,
  sectionCountLabel,
  sections,
  storySegments,
  type GrammarView,
  type OverviewStat,
  type PhraseView,
  type SectionId,
  type StorySegment,
} from '../../lib/review-material'
import type { DailyMaterialResponse, MaterialMistake, MaterialWord } from '../../lib/review-types'
import { SPEECH_IDLE, type SpeechStatus } from '../../lib/speaker'
import { fetchDailyMaterial, fetchMaterialDates } from '../../services/review'
import { redirectIfInviteRequired } from '../../services/session'
import { speechStatus, stopSpeaking, toggleSpeech, watchSpeech, type SpeechSource } from '../../services/speech'
import { bindPageLook, currentTheme, type Theme } from '../../services/theme'
import { toast } from '../../services/ui'

type Phase = 'loading' | 'ready' | 'none' | 'error'

interface SectionTab {
  id: SectionId
  label: string
  countLabel: string
}

interface WordView extends MaterialWord {
  key: string
  collocationsText: string
  familyText: string
}

interface PhraseItem extends PhraseView {
  key: string
}

interface StoryView {
  title: string
  segments: StorySegment[]
  zh: string
  key: string
}

interface MaterialsData {
  theme: Theme
  phase: Phase
  errorText: string
  noneText: string
  date: string
  dateLabel: string
  older: string
  newer: string
  /** More dates exist beyond the loaded list (the ‹ arrow loads them). */
  moreOlder: boolean
  tabs: SectionTab[]
  section: SectionId
  stats: OverviewStat[]
  words: WordView[]
  phrases: PhraseItem[]
  grammar: GrammarView[]
  story: StoryView | null
  mistakes: MaterialMistake[]
  revealed: Record<string, boolean>
  showStoryZh: boolean
  /** What sounds; a button compares its key with `speech.key` (never '' for a key). */
  speech: SpeechStatus
  anchor: string
}

const initialData: MaterialsData = {
  theme: currentTheme(),
  phase: 'loading',
  errorText: '',
  noneText: '',
  date: '',
  dateLabel: '',
  older: '',
  newer: '',
  moreOlder: false,
  tabs: [],
  section: 'overview',
  stats: [],
  words: [],
  phrases: [],
  grammar: [],
  story: null,
  mistakes: [],
  revealed: {},
  showStoryZh: false,
  speech: SPEECH_IDLE,
  anchor: '',
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const wordViews = (words: readonly MaterialWord[]): WordView[] =>
  words.map((word) => ({
    ...word,
    key: `i-${word.itemId}-${fingerprint(word.headword)}`,
    collocationsText: word.collocations.join(' · '),
    familyText: word.family.join(' · '),
  }))

Page({
  data: initialData,
  stopWatchingTheme: null as (() => void) | null,
  dates: [] as string[],
  nextBefore: null as string | null,
  /** Materials already loaded on this page, by date (set in onLoad: page fields are per instance). */
  cache: null as Map<string, DailyMaterialResponse> | null,
  /** Counts loads, so a slow answer for a date the user left is ignored. */
  loads: 0,
  stopWatchingSpeech: null as (() => void) | null,

  onLoad(options: Record<string, string | undefined>) {
    this.stopWatchingTheme = bindPageLook(this)
    this.stopWatchingSpeech = watchSpeech((speech) => this.setData({ speech }))
    this.setData({ theme: currentTheme(), speech: speechStatus() })
    this.cache = new Map()
    this.dates = []
    const requested = options['date']
    void this.loadDates()
    void this.show(requested !== undefined && DATE_RE.test(requested) ? requested : undefined)
  },

  onHide() {
    stopSpeaking()
  },

  onUnload() {
    this.stopWatchingTheme?.()
    this.stopWatchingSpeech?.()
    stopSpeaking()
  },

  async loadDates(): Promise<void> {
    try {
      const page = await fetchMaterialDates(this.nextBefore)
      this.dates = [...new Set([...this.dates, ...page.dates])].sort().reverse()
      this.nextBefore = page.nextBefore
      this.updateNeighbours()
    } catch (error: unknown) {
      // Date paging is a convenience; the shown material stays usable.
      console.warn('[materials] dates not loaded', error)
    }
  },

  updateNeighbours() {
    const { older, newer } = dateNeighbours(this.dates, this.data.date)
    this.setData({ older, newer, moreOlder: older === '' && this.nextBefore !== null })
  },

  async show(date?: string): Promise<void> {
    this.loads += 1
    const load = this.loads
    stopSpeaking()
    const cached = date === undefined ? undefined : this.cache?.get(date)
    if (cached === undefined) this.setData({ phase: 'loading', errorText: '' })
    try {
      const material = cached ?? (await fetchDailyMaterial(date))
      if (load !== this.loads) return
      if (material === null) {
        this.setData({
          phase: 'none',
          date: date ?? '',
          dateLabel: date === undefined ? '' : formatDateLabel(date),
          noneText: date === undefined ? '还没有每日材料' : '这天没有材料',
        })
        this.updateNeighbours()
        return
      }
      this.cache?.set(material.date, material)
      this.render(material)
    } catch (error: unknown) {
      if (load !== this.loads || redirectIfInviteRequired(error)) return
      this.setData({ phase: 'error', errorText: errorMessage(error) })
    }
  },

  render(material: DailyMaterialResponse) {
    const { content } = material
    const tabs = sections(content).map((section) => ({
      id: section.id,
      label: section.label,
      countLabel: sectionCountLabel(section),
    }))
    const keep = tabs.some((tab) => tab.id === this.data.section)
    const story = content.story
    this.setData({
      phase: 'ready',
      date: material.date,
      dateLabel: formatDateLabel(material.date),
      tabs,
      section: keep ? this.data.section : 'overview',
      stats: overviewStats(content),
      words: wordViews(content.words),
      phrases: phraseViews(content.phrases).map((phrase) => ({
        ...phrase,
        key: `i-${phrase.itemId}-${fingerprint(phrase.phrase)}`,
      })),
      grammar: grammarViews(content.grammar),
      story:
        story === null
          ? null
          : {
              title: story.title,
              segments: storySegments(story.text, story.words),
              zh: story.zh,
              key: storySpeechKey(material.date, story.text),
            },
      mistakes: [...content.mistakes],
      revealed: {},
      showStoryZh: false,
    })
    this.updateNeighbours()
    this.scrollToTop()
  },

  scrollToTop() {
    this.setData({ anchor: '' }, () => this.setData({ anchor: 'mat-top' }))
  },

  onRetry() {
    void this.show(this.data.date === '' ? undefined : this.data.date)
  },

  async onOlder() {
    if (this.data.older === '' && this.data.moreOlder) await this.loadDates()
    if (this.data.older !== '') void this.show(this.data.older)
  },

  onNewer() {
    if (this.data.newer !== '') void this.show(this.data.newer)
  },

  onSection(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: SectionId }>) {
    const id = event.currentTarget.dataset.id
    if (id === undefined || id === this.data.section) return
    stopSpeaking()
    this.setData({ section: id })
    this.scrollToTop()
  },

  onReveal(event: WechatMiniprogram.BaseEvent<Record<string, never>, { key?: string }>) {
    const key = event.currentTarget.dataset.key
    if (key === undefined) return
    this.setData({ [`revealed.${key}`]: this.data.revealed[key] !== true })
  },

  onToggleStoryZh() {
    this.setData({ showStoryZh: !this.data.showStoryZh })
  },

  onPlayItem(event: WechatMiniprogram.BaseEvent<Record<string, never>, { id?: string; key?: string }>) {
    const { id, key } = event.currentTarget.dataset
    if (id === undefined || key === undefined) return
    this.play({ itemId: id }, key)
  },

  onPlayStory() {
    const story = this.data.story
    if (story === null) return
    this.play({ material: { kind: 'daily', date: this.data.date, section: 'story' } }, story.key)
  },

  /** Plays `source`; tapping what loads or plays stops it. */
  play(source: SpeechSource, key: string) {
    toggleSpeech(source, key).catch((error: unknown) => toast(errorMessage(error)))
  },
})
