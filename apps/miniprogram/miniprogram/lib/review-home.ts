/**
 * 复习 home: "one progress ring and one button". Turns the review summary
 * into what the page shows — the ring, the counts and the tab badge text.
 */
import type { ReviewSummary } from './review-types'

/** Share done in [0, 1]: done / (done + due); 0 when there is nothing at all. */
export function progressShare(done: number, due: number): number {
  const safeDone = Math.max(0, done)
  const total = safeDone + Math.max(0, due)
  return total === 0 ? 0 : safeDone / total
}

/** Degrees of the ring filled, 0–360 (one decimal), from a share in [0, 1]. */
export function ringDegrees(share: number): number {
  const clamped = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0
  return Math.round(clamped * 3600) / 10
}

/** Inline styles of the progress ring; colours are literal (lib/palette.ts). */
export interface RingStyle {
  /** The ring itself: `fill` from 12 o'clock up to the angle, `track` after. */
  readonly background: string
  /** Turns the end cap's arm to the angle. */
  readonly endCap: string
  /** Round caps at both ends, only for a partial ring. */
  readonly caps: boolean
}

/**
 * The ring is a conic gradient with hard stops (the same angle twice), a
 * disc in the page colour on top making it a ring, and two dots as round
 * caps. Skyline supports conic gradients; it does not draw rounded boxes
 * with different border colours per side, which an arc made of borders
 * needs. CSS variables are not used inside the inline gradient on purpose.
 */
export function ringStyle(degrees: number, fill: string, track: string): RingStyle {
  const angle = Number.isFinite(degrees) ? Math.min(360, Math.max(0, degrees)) : 0
  return {
    background: `background-image: conic-gradient(${fill} 0deg, ${fill} ${angle}deg, ${track} ${angle}deg, ${track} 360deg);`,
    endCap: `transform: rotate(${angle}deg);`,
    caps: angle > 0 && angle < 360,
  }
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
  /** Degrees of the ring filled (see ringStyle). */
  readonly ringDegrees: number
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
    ringDegrees: ringDegrees(progressShare(done, due)),
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
