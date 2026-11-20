/**
 * 复习 home: "one progress ring and one button". Turns the review summary
 * into what the page shows — the ring's two half-arc rotations, the counts
 * and the tab badge text.
 */
import type { ReviewSummary } from './review-types'

/**
 * The ring is two clipped half circles (no canvas, no conic gradient, so it
 * renders the same under Skyline and WebView). Each half holds an arc whose
 * top and right borders are coloured; rotating it by `angle - 135°` shows the
 * part of the circle from 0° up to `angle` inside that half.
 */
export interface RingAngles {
  /** Rotation in degrees of the arc clipped to the right half (0°–180°). */
  readonly right: number
  /** Rotation in degrees of the arc clipped to the left half (180°–360°). */
  readonly left: number
}

/** Share done in [0, 1]: done / (done + due); 0 when there is nothing at all. */
export function progressShare(done: number, due: number): number {
  const safeDone = Math.max(0, done)
  const total = safeDone + Math.max(0, due)
  return total === 0 ? 0 : safeDone / total
}

export function ringAngles(share: number): RingAngles {
  const clamped = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0
  const angle = clamped * 360
  return { right: Math.min(angle, 180) - 135, left: Math.max(angle, 180) - 135 }
}

/** Text for the 复习 tab badge; null removes it. WeChat shows at most 4 characters. */
export function badgeText(due: number): string | null {
  if (!Number.isFinite(due) || due <= 0) return null
  return due > 99 ? '99+' : String(Math.floor(due))
}

export type HomeMode = 'due' | 'finished' | 'idle'

export interface HomeView {
  /** due: cards to review; finished: all of today's done; idle: nothing today. */
  readonly mode: HomeMode
  readonly done: number
  readonly total: number
  readonly ring: RingAngles
  /** "新卡 12 · 复习 30 · 约 9 分钟" */
  readonly meta: string
  readonly streak: string
}

export function homeView(summary: ReviewSummary): HomeView {
  const done = Math.max(0, summary.doneToday)
  const due = Math.max(0, summary.due)
  const mode: HomeMode = due > 0 ? 'due' : done > 0 ? 'finished' : 'idle'
  const parts = [
    summary.newAvailable > 0 ? `新卡 ${summary.newAvailable}` : '',
    summary.reviewDue > 0 ? `复习 ${summary.reviewDue}` : '',
    due > 0 && summary.estimatedMinutes > 0 ? `约 ${summary.estimatedMinutes} 分钟` : '',
  ].filter((part) => part !== '')
  return {
    mode,
    done,
    total: done + due,
    ring: ringAngles(progressShare(done, due)),
    meta: parts.join(' · '),
    streak: summary.streakDays > 0 ? `连续 ${summary.streakDays} 天` : '',
  }
}

/**
 * WeChat one-time subscribe messages allow one reminder per acceptance, so
 * 开始复习 asks again each time — but only when the user turned reminders on
 * (`reminderHour` set) and the server has a template. The template to ask
 * for, or null to skip the dialog.
 */
export function reminderTemplateToAsk(reminderHour: number | null, templateId: string | null): string | null {
  return reminderHour === null || templateId === null || templateId === '' ? null : templateId
}

/** True when the subscribe dialog's answer accepted `templateId`. */
export function reminderAccepted(result: Readonly<Record<string, unknown>>, templateId: string): boolean {
  return result[templateId] === 'accept'
}
