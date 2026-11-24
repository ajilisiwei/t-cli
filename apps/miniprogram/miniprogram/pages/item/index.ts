/**
 * 学习单元 (`?id=<itemId>`): the unit's content by type, its review cards
 * and the records it came from. ▶ reads the unit aloud (`POST /v1/tts`
 * with `{ itemId }`); grammar exercises reveal their answer on tap.
 */
import { errorMessage } from '../../lib/api'
import { formatInstant } from '../../lib/history'
import {
  REGISTER_LABELS,
  itemMeta,
  posLabel,
  statusNotice,
  toCardRow,
  toExercises,
  toSourceRows,
  toggleExercise,
  type CardRow,
  type Example,
  type ExerciseView,
  type ItemContent,
  type ItemDetail,
  type SourceRow,
} from '../../lib/item'
import { LEVEL_LABELS, TYPE_LABELS } from '../../lib/library'
import { speechPhase, type SpeechPhase, type SpeechStatus } from '../../lib/speaker'
import { fetchItem } from '../../services/library'
import { redirectIfInviteRequired } from '../../services/session'
import { itemSpeechKey, speechStatus, stopSpeaking, toggleSpeech, watchSpeech } from '../../services/speech'
import { bindPageLook, currentTheme, type Theme } from '../../services/theme'
import { toast } from '../../services/ui'

interface WordView {
  headword: string
  ipa: string
  meanings: { key: string; pos: string; zh: string }[]
  examples: (Example & { key: string })[]
  collocations: string[]
  synonyms: { key: string; word: string; note: string }[]
  family: string
}

interface PhraseView {
  phrase: string
  zh: string
  register: string
  alternatives: { key: string; en: string; note: string }[]
  examples: (Example & { key: string })[]
}

interface GrammarView {
  title: string
  rule: string
  wrong: string
  right: string
}

interface ItemData {
  theme: Theme
  loading: boolean
  loaded: boolean
  errorText: string
  display: string
  meta: string
  notice: string
  word: WordView | null
  phrase: PhraseView | null
  grammar: GrammarView | null
  exercises: ExerciseView[]
  cards: CardRow[]
  sources: SourceRow[]
  speakPhase: SpeechPhase
}

const initialData: ItemData = {
  theme: currentTheme(),
  loading: true,
  loaded: false,
  errorText: '',
  display: '',
  meta: '',
  notice: '',
  word: null,
  phrase: null,
  grammar: null,
  exercises: [],
  cards: [],
  sources: [],
  speakPhase: 'idle',
}

/** An en space after the part of speech: margins do not apply to inline text under Skyline. */
const spaced = (pos: string): string => (pos === '' ? '' : `${pos}\u2002`)

const keyed = <T>(rows: readonly T[]): (T & { key: string })[] => rows.map((row, i) => ({ ...row, key: `${i}` }))

const contentViews = (
  content: ItemContent | null,
): Pick<ItemData, 'word' | 'phrase' | 'grammar'> => {
  if (content === null) return { word: null, phrase: null, grammar: null }
  switch (content.kind) {
    case 'word':
      return {
        word: {
          headword: content.headword,
          ipa: content.ipa,
          meanings: keyed(content.meanings.map((m) => ({ pos: spaced(posLabel(m.pos)), zh: m.zh }))),
          examples: keyed(content.examples),
          collocations: [...content.collocations],
          synonyms: keyed(content.synonyms),
          family: content.family.join(' · '),
        },
        phrase: null,
        grammar: null,
      }
    case 'phrase':
      return {
        word: null,
        phrase: {
          phrase: content.phrase,
          zh: content.zh,
          register: content.register === null ? '' : REGISTER_LABELS[content.register],
          alternatives: keyed(content.alternatives),
          examples: keyed(content.examples),
        },
        grammar: null,
      }
    case 'grammar':
      return {
        word: null,
        phrase: null,
        grammar: { title: content.title, rule: content.rule, wrong: content.wrong, right: content.right },
      }
  }
}

const detailView = (detail: ItemDetail, now: Date): Partial<ItemData> => ({
  display: detail.display,
  meta: itemMeta(detail, TYPE_LABELS[detail.type], LEVEL_LABELS[detail.level]),
  notice: statusNotice(detail),
  ...contentViews(detail.content),
  exercises: toExercises(detail.content),
  cards: detail.cards.map((card) => toCardRow(card, now)),
  sources: toSourceRows(detail.sources, (iso) => formatInstant(iso, now)),
})

Page({
  data: initialData,
  itemId: '',
  stopWatchingTheme: null as (() => void) | null,
  stopWatchingSpeech: null as (() => void) | null,

  onLoad(query: Record<string, string | undefined>) {
    this.stopWatchingTheme = bindPageLook(this)
    this.itemId = query['id'] ?? ''
    this.stopWatchingSpeech = watchSpeech((speech) => this.syncSpeech(speech))
    this.setData({ theme: currentTheme(), speakPhase: this.phaseOf(speechStatus()) })
    void this.load()
  },

  onUnload() {
    this.stopWatchingTheme?.()
    this.stopWatchingSpeech?.()
    if (this.phaseOf(speechStatus()) !== 'idle') stopSpeaking()
  },

  async load() {
    if (this.itemId === '') {
      this.setData({ loading: false, loaded: true, errorText: '没有找到这个单元' })
      return
    }
    this.setData({ loading: true, errorText: '' })
    try {
      const detail = await fetchItem(this.itemId)
      this.setData({ ...detailView(detail, new Date()), loaded: true })
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      this.setData({ errorText: errorMessage(error, { NOT_FOUND: '没有找到这个单元' }) })
    } finally {
      this.setData({ loading: false })
    }
  },

  onRetry() {
    void this.load()
  },

  onSpeak() {
    if (this.itemId === '') return
    toggleSpeech({ itemId: this.itemId }, itemSpeechKey(this.itemId)).catch((error: unknown) =>
      toast(errorMessage(error)),
    )
  },

  phaseOf(speech: SpeechStatus): SpeechPhase {
    return this.itemId === '' ? 'idle' : speechPhase(speech, itemSpeechKey(this.itemId))
  },

  syncSpeech(speech: SpeechStatus) {
    const speakPhase = this.phaseOf(speech)
    if (speakPhase !== this.data.speakPhase) this.setData({ speakPhase })
  },

  onReveal(event: WechatMiniprogram.BaseEvent<Record<string, never>, { index?: number }>) {
    const index = Number(event.currentTarget.dataset.index)
    if (!Number.isInteger(index)) return
    this.setData({ exercises: toggleExercise(this.data.exercises, index) })
  },
})
