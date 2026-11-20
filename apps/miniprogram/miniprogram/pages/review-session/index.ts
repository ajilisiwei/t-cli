/**
 * 复习卡: one card at a time. Tap flips it (and reads it aloud when 复习翻面
 * 自动朗读 is on); four grade buttons show the next interval under each;
 * swipe left = 忘记, right = 记得. Each rating is posted at once (queued when
 * offline) and can be withdrawn for 5 seconds. Long-press → 内容有误 reports
 * the card and drops its item from the session. The end screen shows time,
 * share remembered and tomorrow's estimate, then the session is over.
 *
 * All decisions live in lib/review-session.ts; this page dispatches events,
 * runs the side effects and renders.
 */
import { errorMessage } from '../../lib/api'
import { cardSpeechKey, cardView, type CardView, type FaceView } from '../../lib/review-card'
import { RATING_LABELS, durationParts, gradeButtons, percent, type GradeButton } from '../../lib/review-format'
import {
  UNDO_WINDOW_MS,
  currentCard,
  dropItem,
  expireUndo,
  flip,
  pause,
  progress,
  rate,
  resume,
  sessionStats,
  startSession,
  undoRating,
  type SessionState,
} from '../../lib/review-session'
import { classifySwipe, dragFeedback, type SwipeDirection } from '../../lib/review-swipe'
import type { QueueCard, Rating } from '../../lib/review-types'
import { diffWords } from '../../lib/word-diff'
import {
  fetchQueue,
  flushPending,
  newLogId,
  recordReview,
  reportCard,
  undoReview,
} from '../../services/review'
import { redirectIfInviteRequired } from '../../services/session'
import { autoSpeakOnFlip } from '../../services/settings'
import { prefetchSource, speakSource, stopSourceSpeech } from '../../services/speech'
import { currentTheme, watchTheme, type Theme } from '../../services/theme'
import { toast } from '../../services/ui'

type Phase = 'loading' | 'error' | 'empty' | 'reviewing' | 'done'
/** Where the ▶ sits: after the IPA it belongs to, or on its own line. */
type SpeakSlot = 'front' | 'back' | 'line'

interface EndStat {
  value: string
  unit: string
  label: string
}

interface EndStats {
  reviewed: number
  items: EndStat[]
}

interface SessionData {
  theme: Theme
  phase: Phase
  errorText: string
  label: string
  prompt: string
  front: FaceView | null
  back: FaceView | null
  flipped: boolean
  speakSlot: SpeakSlot
  buttons: GradeButton[]
  position: number
  total: number
  progressPct: number
  undoLabel: string
  undoing: boolean
  showGestureHint: boolean
  dragX: number
  dragTilt: number
  dragIntent: '' | SwipeDirection
  dragging: boolean
  safeBottom: number
  stats: EndStats | null
}

interface TouchStart {
  readonly x: number
  readonly y: number
  readonly at: number
}

const initialData: SessionData = {
  theme: currentTheme(),
  phase: 'loading',
  errorText: '',
  label: '',
  prompt: '',
  front: null,
  back: null,
  flipped: false,
  speakSlot: 'line',
  buttons: [],
  position: 0,
  total: 0,
  progressPct: 0,
  undoLabel: '',
  undoing: false,
  showGestureHint: false,
  dragX: 0,
  dragTilt: 0,
  dragIntent: '',
  dragging: false,
  safeBottom: 0,
  stats: null,
}

const REVIEW_TAB = '/pages/review/index'
/** Skip a drag frame unless the card moved at least this far (fewer setData calls). */
const DRAG_STEP_PX = 6

/** Height of the home indicator area below the safe area, in px. */
const safeBottomInset = (): number => {
  try {
    const info = wx.getWindowInfo()
    return info.safeArea ? Math.max(0, info.screenHeight - info.safeArea.bottom) : 0
  } catch {
    return 0
  }
}

/** Local midnight at the end of tomorrow: "明天" in the end screen. */
const endOfTomorrow = (now: number): number => {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 2).getTime()
}

const speakSlot = (view: CardView): SpeakSlot => (view.front.ipa !== '' ? 'front' : view.back.ipa !== '' ? 'back' : 'line')

const endStats = (state: SessionState, now: number): EndStats => {
  const stats = sessionStats(state, endOfTomorrow(now))
  return {
    reviewed: stats.reviewed,
    items: [
      { ...durationParts(stats.durationMs), label: '用时' },
      { value: percent(stats.remembered, stats.reviewed), unit: '%', label: '记住' },
      // Cards of this session due again by the end of tomorrow (see the report: no server forecast).
      { value: String(stats.dueAgain), unit: '张', label: '明天再见' },
    ],
  }
}

const touchPoint = (event: WechatMiniprogram.TouchEvent): { x: number; y: number } | null => {
  const touch = event.changedTouches[0] ?? event.touches[0]
  return touch === undefined ? null : { x: touch.clientX, y: touch.clientY }
}

Page({
  data: initialData,
  session: null as SessionState | null,
  /** Card view of the current card, rebuilt only when the card changes. */
  view: null as { cardId: string; view: CardView } | null,
  undoTimer: null as number | null,
  undoBusy: false,
  touch: null as TouchStart | null,
  stopWatchingTheme: null as (() => void) | null,

  onLoad() {
    this.stopWatchingTheme = watchTheme((theme) => this.setData({ theme }))
    this.setData({ theme: currentTheme(), safeBottom: safeBottomInset() })
    void this.start()
  },

  onShow() {
    if (this.session === null) return
    const now = Date.now()
    this.session = resume(this.session, now)
    // A timer may not have fired while hidden.
    const undo = this.session.undo
    if (undo !== null && undo.until <= now) this.session = expireUndo(this.session, undo.logId)
    this.render()
  },

  onHide() {
    if (this.session !== null) this.session = pause(this.session, Date.now())
    stopSourceSpeech()
  },

  onUnload() {
    this.stopWatchingTheme?.()
    this.clearUndoTimer()
    stopSourceSpeech()
  },

  async start(): Promise<void> {
    this.setData({ phase: 'loading', errorText: '' })
    try {
      // Ratings queued offline first, so the queue reflects them.
      await flushPending()
      const cards = await fetchQueue()
      if (cards.length === 0) {
        this.setData({ phase: 'empty' })
        return
      }
      this.session = startSession(cards, Date.now())
      this.render()
      this.prefetchCurrent()
    } catch (error: unknown) {
      if (redirectIfInviteRequired(error)) return
      this.setData({ phase: 'error', errorText: errorMessage(error) })
    }
  },

  onRetry() {
    void this.start()
  },

  cardViewOf(card: QueueCard): CardView {
    if (this.view?.cardId !== card.id) this.view = { cardId: card.id, view: cardView(card, diffWords) }
    return this.view.view
  },

  render() {
    const state = this.session
    if (state === null) return
    const card = currentCard(state)
    const view = card === null ? null : this.cardViewOf(card)
    const { position, total, share } = progress(state)
    this.setData({
      phase: state.phase,
      label: view?.label ?? '',
      prompt: view?.prompt ?? '',
      front: view?.front ?? null,
      back: view?.back ?? null,
      flipped: state.flipped,
      speakSlot: view === null ? 'line' : speakSlot(view),
      buttons: card === null ? [] : gradeButtons(card.intervals),
      position,
      total,
      progressPct: Math.round(share * 100),
      undoLabel: state.undo === null ? '' : `已记为「${RATING_LABELS[state.undo.rating]}」`,
      showGestureHint: state.flipped && state.rated.length === 0,
      stats: state.phase === 'done' ? endStats(state, Date.now()) : null,
      dragX: 0,
      dragTilt: 0,
      dragIntent: '',
      dragging: false,
    })
  },

  /** Fetches the current card's audio while its front shows, so the flip speaks at once. */
  prefetchCurrent() {
    const card = this.session === null ? null : currentCard(this.session)
    if (card === null || !autoSpeakOnFlip()) return
    prefetchSource({ cardId: card.id }, cardSpeechKey(card)).catch(() => undefined)
  },

  speakCurrent(manual: boolean) {
    const card = this.session === null ? null : currentCard(this.session)
    if (card === null) return
    speakSource({ cardId: card.id }, cardSpeechKey(card)).catch((error: unknown) => {
      if (manual) toast(errorMessage(error))
      else console.warn('[review] reading the card aloud failed', error)
    })
  },

  flipCard() {
    if (this.session === null || this.session.flipped) return
    const next = flip(this.session)
    if (next === this.session) return
    this.session = next
    this.render()
    if (autoSpeakOnFlip()) this.speakCurrent(false)
  },

  onCardTap() {
    this.flipCard()
  },

  onReveal() {
    this.flipCard()
  },

  onSpeak() {
    this.speakCurrent(true)
  },

  onRate(event: WechatMiniprogram.BaseEvent<Record<string, never>, { rating?: number }>) {
    const rating = Number(event.currentTarget.dataset.rating)
    if (rating === 1 || rating === 2 || rating === 3 || rating === 4) this.rateCurrent(rating)
  },

  /** Rates the current card; false when it cannot be rated now. */
  rateCurrent(rating: Rating): boolean {
    // While an undo is on its way, the session must not move under it.
    if (this.session === null || this.undoBusy) return false
    const now = Date.now()
    const result = rate(this.session, rating, newLogId(now), now)
    if (result === null) return false
    stopSourceSpeech()
    recordReview(result.log)
    this.session = result.state
    this.armUndoTimer(result.log.id)
    this.render()
    this.prefetchCurrent()
    return true
  },

  armUndoTimer(logId: string) {
    this.clearUndoTimer()
    this.undoTimer = setTimeout(() => {
      this.undoTimer = null
      if (this.session === null || this.undoBusy) return
      this.session = expireUndo(this.session, logId)
      this.render()
    }, UNDO_WINDOW_MS) as unknown as number
  },

  clearUndoTimer() {
    if (this.undoTimer !== null) clearTimeout(this.undoTimer)
    this.undoTimer = null
  },

  async onUndo() {
    const undo = this.session?.undo ?? null
    if (undo === null || this.undoBusy) return
    this.undoBusy = true
    this.clearUndoTimer()
    stopSourceSpeech()
    this.setData({ undoing: true })
    try {
      const outcome = await undoReview(undo.logId)
      if (this.session === null) return
      if (outcome === 'undone') {
        this.session = undoRating(this.session, undo.logId, Date.now())
      } else {
        toast('已超过撤销时限')
        this.session = expireUndo(this.session, undo.logId)
      }
    } catch (error: unknown) {
      toast(`没有撤销：${errorMessage(error)}`)
      if (this.session !== null) this.session = expireUndo(this.session, undo.logId)
    } finally {
      this.undoBusy = false
      this.setData({ undoing: false })
      this.render()
    }
  },

  onLongPress() {
    const card = this.session === null ? null : currentCard(this.session)
    if (card === null) return
    wx.showActionSheet({
      itemList: ['内容有误'],
      success: (result) => {
        if (result.tapIndex === 0) void this.report(card)
      },
      // Dismissing the sheet is not an error.
      fail: () => undefined,
    })
  },

  async report(card: QueueCard): Promise<void> {
    try {
      await reportCard(card.id)
    } catch (error: unknown) {
      toast(errorMessage(error))
      return
    }
    if (this.session === null) return
    stopSourceSpeech()
    this.session = dropItem(this.session, card.itemId, Date.now())
    this.render()
    this.prefetchCurrent()
    toast('已反馈，这张卡会重新生成')
  },

  onTouchStart(event: WechatMiniprogram.TouchEvent) {
    const point = touchPoint(event)
    this.touch = point === null ? null : { ...point, at: Date.now() }
  },

  onTouchMove(event: WechatMiniprogram.TouchEvent) {
    const start = this.touch
    const point = touchPoint(event)
    if (start === null || point === null || !this.data.flipped || this.undoBusy) return
    const feedback = dragFeedback(point.x - start.x, point.y - start.y)
    const intent = feedback.intent ?? ''
    if (Math.abs(feedback.offset - this.data.dragX) < DRAG_STEP_PX && intent === this.data.dragIntent) return
    this.setData({ dragX: feedback.offset, dragTilt: feedback.offset / 24, dragIntent: intent, dragging: true })
  },

  onTouchEnd(event: WechatMiniprogram.TouchEvent) {
    const start = this.touch
    const point = touchPoint(event)
    this.touch = null
    if (start === null || point === null || !this.data.flipped) return
    const direction = classifySwipe({ dx: point.x - start.x, dy: point.y - start.y, dt: Date.now() - start.at })
    const rated = direction !== null && this.rateCurrent(direction === 'left' ? 1 : 3)
    if (!rated && (this.data.dragging || this.data.dragX !== 0)) {
      this.setData({ dragX: 0, dragTilt: 0, dragIntent: '', dragging: false })
    }
  },

  onFinish() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: REVIEW_TAB, fail: () => undefined }) })
  },
})
