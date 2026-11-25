/**
 * 周期资料 (`?kind=daily|digest&date=YYYY-MM-DD&pages=n`; without a date the
 * latest): one scrolling page — the counts, 重点词, 词组与句型, 语法与易错,
 * 情景短文, 练习 (选词填空 answered here, 中译英 and 改错 on tap) and, for a
 * digest, 本周复习时忘过的. The parts follow 学习计划 › 资料里放什么
 * (`materialParts`). The bar at the bottom: 朗读 the story (daily only: the
 * speech endpoint reads a daily story), 导出 PDF, 学完了.
 */
import { errorMessage } from '../../lib/api'
import {
  answerCloze,
  clozeScore,
  clozeViews,
  exerciseCount,
  fixViews,
  translateViews,
  type ClozeView,
  type RevealView,
} from '../../lib/exercises'
import { NO_EXERCISES } from '../../lib/learn-wire'
import type { Exercises, PeriodicKind, PeriodicMaterial } from '../../lib/learn-types'
import { addDays, dayLabel, exportMaterial, exportMaterialOf, rangeLabel } from '../../lib/learn-view'
import type { ExportInput, ExportMaterial } from '../../lib/pdf-export'
import {
  cardWords,
  countCells,
  estimateMaterialPages,
  lapsesLabel,
  periodicTitle,
  phraseRows,
  showsPart,
  wordRows,
  type CountCell,
  type WordRow,
} from '../../lib/periodic-view'
import { fingerprint, storySpeechKey } from '../../lib/review-card'
import { storySegments, type StorySegment } from '../../lib/review-material'
import type { MaterialMistake } from '../../lib/review-types'
import { SPEECH_IDLE, type SpeechStatus } from '../../lib/speaker'
import type { MaterialPart } from '../../lib/types'
import { fetchPeriodic, fetchThisWeek, markRead } from '../../services/learn'
import { safeBottomInset } from '../../services/platform'
import { redirectIfInviteRequired } from '../../services/session'
import { currentSettings, watchSettings } from '../../services/settings'
import { speechStatus, stopSpeaking, toggleSpeech, watchSpeech, type SpeechSource } from '../../services/speech'
import { bindPageLook, currentLook, type Look } from '../../services/theme'
import { toast } from '../../services/ui'

type Phase = 'loading' | 'ready' | 'none' | 'error'

interface Shown {
  words: boolean
  phrases: boolean
  grammar: boolean
  story: boolean
  exercises: boolean
}

interface GrammarRow {
  itemId: string
  title: string
  wrong: string
  right: string
  rule: string
}

interface RecapRow {
  itemId: string
  display: string
  gloss: string
  lapses: string
}

interface StoryView {
  title: string
  segments: StorySegment[]
  zh: string
  key: string
}

interface MaterialsData extends Look {
  phase: Phase
  errorText: string
  noneText: string
  kind: PeriodicKind
  navTitle: string
  headLine: string
  title: string
  cells: CountCell[]
  show: Shown
  words: WordRow[]
  phrases: WordRow[]
  grammar: GrammarRow[]
  mistakes: MaterialMistake[]
  recap: RecapRow[]
  story: StoryView | null
  showStoryZh: boolean
  cloze: ClozeView[]
  score: string
  translate: RevealView[]
  fix: RevealView[]
  revealed: Record<string, boolean>
  /** 朗读 the story from the bar: a daily story that is shown. */
  canSpeakStory: boolean
  speech: SpeechStatus
  done: boolean
  marking: boolean
  safeBottom: number
  exportOpen: boolean
  exportInput: ExportInput
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const NAV_TITLES: Readonly<Record<PeriodicKind, string>> = { daily: '每日资料', digest: '每周合集' }

const shownParts = (parts: readonly MaterialPart[]): Shown => ({
  words: showsPart(parts, 'words'),
  phrases: showsPart(parts, 'phrases'),
  grammar: showsPart(parts, 'grammar'),
  story: showsPart(parts, 'story'),
  exercises: showsPart(parts, 'exercises'),
})

const itemKey = (itemId: string, text: string): string => `i-${itemId}-${fingerprint(text)}`

const headLine = (material: PeriodicMaterial): string => {
  if (material.kind === 'daily') return `根据 ${dayLabel(material.date)} 的学习生成`
  const range = material.range ?? { start: addDays(material.date, -6), end: material.date }
  return `${rangeLabel(range.start, range.end)} · 7 天合集`
}

const initialData: MaterialsData = {
  ...currentLook(),
  phase: 'loading',
  errorText: '',
  noneText: '',
  kind: 'daily',
  navTitle: NAV_TITLES.daily,
  headLine: '',
  title: '',
  cells: [],
  show: shownParts(currentSettings().materialParts),
  words: [],
  phrases: [],
  grammar: [],
  mistakes: [],
  recap: [],
  story: null,
  showStoryZh: false,
  cloze: [],
  score: '',
  translate: [],
  fix: [],
  revealed: {},
  canSpeakStory: false,
  speech: SPEECH_IDLE,
  done: false,
  marking: false,
  safeBottom: 0,
  exportOpen: false,
  exportInput: { origin: 'material', selection: [], week: [], initial: 'one' },
}

Page({
  data: initialData,
  stopWatching: [] as (() => void)[],
  material: null as PeriodicMaterial | null,
  exercises: NO_EXERCISES as Exercises,
  answers: {} as Readonly<Record<string, string>>,
  /** `pages` from the list (the PDF estimate); 0 = estimate here. */
  listPages: 0,
  week: [] as ExportMaterial[],

  onLoad(options: Record<string, string | undefined>) {
    const kind: PeriodicKind = options['kind'] === 'digest' ? 'digest' : 'daily'
    const date = options['date']
    this.listPages = Number(options['pages'] ?? 0) || 0
    this.stopWatching = [
      bindPageLook(this),
      watchSpeech((speech) => this.setData({ speech })),
      watchSettings(() => this.renderParts()),
    ]
    this.setData({ kind, navTitle: NAV_TITLES[kind], speech: speechStatus(), safeBottom: safeBottomInset() })
    void this.load(date !== undefined && DATE_RE.test(date) ? date : undefined)
    void this.loadWeek()
  },

  onHide() {
    stopSpeaking()
  },

  onUnload() {
    for (const stop of this.stopWatching) stop()
    this.stopWatching = []
    stopSpeaking()
  },

  async load(date?: string): Promise<void> {
    this.setData({ phase: 'loading', errorText: '' })
    try {
      const material = await fetchPeriodic(this.data.kind, date)
      if (material === null) {
        const what = this.data.kind === 'digest' ? '每周合集' : '每日资料'
        this.setData({ phase: 'none', noneText: date === undefined ? `还没有${what}` : `这天没有${what}` })
        return
      }
      this.render(material)
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      this.setData({ phase: 'error', errorText: errorMessage(error) })
    }
  },

  async loadWeek(): Promise<void> {
    try {
      this.week = (await fetchThisWeek()).flatMap((item) => exportMaterialOf(item) ?? [])
    } catch (error: unknown) {
      // 本周合集 is then not offered; this material still exports.
      console.warn('[materials] this week not loaded', error)
    }
  },

  render(material: PeriodicMaterial) {
    this.material = material
    this.exercises = material.exercises
    this.answers = {}
    const { content } = material
    const story = content.story
    this.setData({
      phase: 'ready',
      headLine: headLine(material),
      title: periodicTitle(material),
      words: wordRows(content.words, itemKey),
      phrases: phraseRows(content.phrases, itemKey),
      grammar: content.grammar.map((point) => ({
        itemId: point.itemId,
        title: point.title,
        wrong: point.wrong,
        right: point.right,
        rule: point.rule,
      })),
      mistakes: [...content.mistakes],
      recap: material.review.map((row) => ({ ...row, lapses: lapsesLabel(row.lapses) })),
      story:
        story === null
          ? null
          : {
              title: story.title,
              segments: storySegments(story.text, story.words),
              zh: story.zh,
              key: storySpeechKey(material.date, story.text),
            },
      showStoryZh: false,
      translate: translateViews(material.exercises),
      fix: fixViews(material.exercises),
      revealed: {},
      done: material.readAt !== null,
    })
    this.renderExercises()
    this.renderParts()
  },

  /** What `materialParts` shows; re-run when the plan changes. */
  renderParts() {
    const material = this.material
    const show = shownParts(currentSettings().materialParts)
    this.setData({
      show,
      cells: material === null ? [] : countCells(material, exerciseCount(material.exercises), currentSettings().materialParts),
      canSpeakStory: material?.kind === 'daily' && material.content.story !== null && show.story,
    })
  },

  renderExercises() {
    const cloze = clozeViews(this.exercises, this.answers)
    this.setData({ cloze, score: clozeScore(cloze) })
  },

  onRetry() {
    void this.load(this.material?.date)
  },

  onChoose(event: WechatMiniprogram.BaseEvent<Record<string, never>, { key?: string; text?: string }>) {
    const { key, text } = event.currentTarget.dataset
    if (key === undefined || text === undefined) return
    const next = answerCloze(this.answers, this.exercises, key, text)
    if (next === this.answers) return
    this.answers = next
    this.renderExercises()
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
    const material = this.material
    if (story === null || material === null || material.kind !== 'daily') return
    this.play({ material: { kind: 'daily', date: material.date, section: 'story' } }, story.key)
  },

  /** Plays `source`; tapping what loads or plays stops it. */
  play(source: SpeechSource, key: string) {
    toggleSpeech(source, key).catch((error: unknown) => toast(errorMessage(error)))
  },

  async onToggleRead() {
    const material = this.material
    if (material === null || this.data.marking) return
    const read = !this.data.done
    this.setData({ done: read, marking: true })
    try {
      const readAt = await markRead(material.kind, material.date, read)
      this.material = { ...material, readAt }
      this.setData({ done: readAt !== null })
      if (read) toast('学完了')
    } catch (error: unknown) {
      this.setData({ done: !read })
      toast(errorMessage(error))
    } finally {
      this.setData({ marking: false })
    }
  },

  onExport() {
    const material = this.material
    if (material === null) return
    const pages = this.listPages > 0 ? this.listPages : estimateMaterialPages(material, exerciseCount(material.exercises))
    const own = exportMaterial(material.kind, material.date, pages, cardWords(material))
    this.setData({ exportInput: { origin: 'material', selection: [own], week: this.week, initial: 'one' }, exportOpen: true })
  },

  onExportClose() {
    this.setData({ exportOpen: false })
  },
})
