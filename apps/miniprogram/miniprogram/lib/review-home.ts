/**
 * The 学习 tab badge and the reminder asked for on 开始复习.
 */

/** Text for the 学习 tab badge; null removes it. WeChat shows at most 4 characters. */
export function badgeText(due: number): string | null {
  if (!Number.isFinite(due) || due <= 0) return null
  return due > 99 ? '99+' : String(Math.floor(due))
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
