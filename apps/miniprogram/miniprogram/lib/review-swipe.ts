/**
 * Swipe grading on a flipped card: left = 忘记, right = 记得. A swipe must be
 * mostly horizontal (vertical drags scroll a long card) and either travel far
 * enough or be a quick flick; anything else snaps back.
 */

export type SwipeDirection = 'left' | 'right'

export interface SwipeMove {
  /** Horizontal travel in px (positive = right). */
  readonly dx: number
  /** Vertical travel in px. */
  readonly dy: number
  /** Duration of the touch in ms. */
  readonly dt: number
}

/** Travel that always counts. */
export const SWIPE_DISTANCE_PX = 80
/** Shorter travel that counts when it is this fast… */
export const FLICK_DISTANCE_PX = 40
/** …within this many ms. */
export const FLICK_MAX_MS = 250
/** Horizontal travel must exceed the vertical by this factor. */
export const HORIZONTAL_RATIO = 1.5

const isHorizontal = (dx: number, dy: number): boolean => Math.abs(dx) > Math.abs(dy) * HORIZONTAL_RATIO

/** The finished gesture, or null when it is not a swipe. */
export function classifySwipe(move: SwipeMove): SwipeDirection | null {
  const { dx, dy, dt } = move
  if (![dx, dy, dt].every(Number.isFinite) || !isHorizontal(dx, dy)) return null
  const distance = Math.abs(dx)
  const swiped = distance >= SWIPE_DISTANCE_PX || (distance >= FLICK_DISTANCE_PX && dt >= 0 && dt <= FLICK_MAX_MS)
  if (!swiped) return null
  return dx < 0 ? 'left' : 'right'
}

/**
 * Feedback while the finger is down: how far the card follows and which
 * grade a release would give. Vertical drags do not move the card.
 */
export interface DragFeedback {
  readonly offset: number
  readonly intent: SwipeDirection | null
}

/** The card follows at most this far. */
export const MAX_DRAG_PX = 140

export function dragFeedback(dx: number, dy: number): DragFeedback {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !isHorizontal(dx, dy)) return { offset: 0, intent: null }
  const offset = Math.max(-MAX_DRAG_PX, Math.min(MAX_DRAG_PX, Math.round(dx)))
  const intent = Math.abs(dx) >= SWIPE_DISTANCE_PX ? (dx < 0 ? 'left' : 'right') : null
  return { offset, intent }
}
