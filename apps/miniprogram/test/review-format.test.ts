import test from 'node:test'
import assert from 'node:assert/strict'
import {
  durationParts,
  formatDateLabel,
  formatDuration,
  formatInterval,
  formatShare,
  formatShortDate,
  gradeButtons,
  materialTitle,
  percent,
  previousDate,
} from '../miniprogram/lib/review-format.ts'
import {
  badgeText,
  homeView,
  progressShare,
  reminderAccepted,
  reminderTemplateToAsk,
  ringDegrees,
  ringStyle,
} from '../miniprogram/lib/review-home.ts'
import { readReminderTemplateId } from '../miniprogram/lib/review-validate.ts'
import type { ReviewSummary } from '../miniprogram/lib/review-types.ts'

const MIN = 60
const HOUR = 3600
const DAY = 86_400

test('formatInterval picks the unit a person would say', () => {
  assert.equal(formatInterval(0), '1 分钟')
  assert.equal(formatInterval(45), '1 分钟')
  assert.equal(formatInterval(10 * MIN), '10 分钟')
  assert.equal(formatInterval(5 * HOUR), '5 小时')
  assert.equal(formatInterval(DAY), '1 天')
  assert.equal(formatInterval(3 * DAY), '3 天')
  assert.equal(formatInterval(29 * DAY), '29 天')
  assert.equal(formatInterval(45 * DAY), '2 个月')
  assert.equal(formatInterval(92 * DAY), '3 个月')
  assert.equal(formatInterval(400 * DAY), '1.1 年')
  assert.equal(formatInterval(730 * DAY), '2 年')
  assert.equal(formatInterval(36_500 * DAY), '100 年')
})

test('formatInterval steps up instead of showing 60 分钟 or 24 小时', () => {
  assert.equal(formatInterval(59 * MIN + 40), '1 小时')
  assert.equal(formatInterval(23 * HOUR + 50 * MIN), '1 天')
  assert.equal(formatInterval(29.6 * DAY), '1 个月')
  assert.equal(formatInterval(360 * DAY), '1 年')
})

test('formatInterval is empty for nonsense', () => {
  assert.equal(formatInterval(Number.NaN), '')
  assert.equal(formatInterval(-5), '')
  assert.equal(formatInterval(Number.POSITIVE_INFINITY), '')
})

test('gradeButtons label all four ratings with their interval', () => {
  assert.deepEqual(gradeButtons({ '1': 600, '2': DAY, '3': 3 * DAY, '4': 8 * DAY }), [
    { rating: 1, label: '忘记', interval: '10 分钟' },
    { rating: 2, label: '困难', interval: '1 天' },
    { rating: 3, label: '记得', interval: '3 天' },
    { rating: 4, label: '简单', interval: '8 天' },
  ])
})

test('formatDuration and formatShare', () => {
  assert.equal(formatDuration(0), '0 秒')
  assert.equal(formatDuration(400), '1 秒')
  assert.equal(formatDuration(42_000), '42 秒')
  assert.equal(formatDuration(6 * 60_000 + 20_000), '6 分钟')
  assert.equal(formatDuration(90 * 60_000), '1.5 小时')
  assert.equal(formatDuration(120 * 60_000), '2 小时')
  assert.deepEqual(durationParts(6 * 60_000), { value: '6', unit: '分钟' })
  assert.deepEqual(durationParts(Number.NaN), { value: '0', unit: '秒' })
  assert.equal(percent(5, 6), '83')
  assert.equal(percent(1, 0), '')
  assert.equal(formatShare(5, 6), '83%')
  assert.equal(formatShare(6, 6), '100%')
  assert.equal(formatShare(0, 0), '')
  assert.equal(formatShare(9, 6), '100%')
})

test('date labels', () => {
  assert.equal(formatDateLabel('2026-11-16'), '11月16日 周一')
  assert.equal(formatDateLabel('2026-11-15'), '11月15日 周日')
  assert.equal(formatDateLabel('2026-02-30'), '')
  assert.equal(formatDateLabel('yesterday'), '')
  assert.equal(formatShortDate('2026-11-15', '2026-11-20'), '11月15日')
  assert.equal(formatShortDate('2025-12-31', '2026-01-02'), '2025年12月31日')
  assert.equal(previousDate('2026-03-01'), '2026-02-28')
  assert.equal(previousDate('2024-03-01'), '2024-02-29')
  assert.equal(previousDate('2026-01-01'), '2025-12-31')
})

test('materialTitle names today, yesterday or the date', () => {
  assert.equal(materialTitle('2026-11-20', '2026-11-20'), '今日材料')
  assert.equal(materialTitle('2026-11-19', '2026-11-20'), '昨日材料')
  assert.equal(materialTitle('2026-11-15', '2026-11-20'), '11月15日材料')
  assert.equal(materialTitle('2025-12-31', '2026-01-01'), '昨日材料')
})

const summary = (overrides: Partial<ReviewSummary>): ReviewSummary => ({
  due: 0,
  newAvailable: 0,
  reviewDue: 0,
  doneToday: 0,
  estimatedMinutes: 0,
  streakDays: 0,
  ...overrides,
})

test('progress ring: share, degrees and the conic gradient', () => {
  assert.equal(progressShare(18, 24), 18 / 42)
  assert.equal(progressShare(0, 0), 0)
  assert.equal(progressShare(5, 0), 1)
  assert.equal(progressShare(-3, 4), 0)
  assert.equal(ringDegrees(0), 0)
  assert.equal(ringDegrees(2 / 15), 48)
  assert.equal(ringDegrees(1 / 3), 120)
  assert.equal(ringDegrees(1), 360)
  assert.equal(ringDegrees(7), 360)
  assert.equal(ringDegrees(Number.NaN), 0)

  const partial = ringStyle(48, '#111111', '#eeeeee')
  assert.equal(
    partial.background,
    'background-image: conic-gradient(#111111 0deg, #111111 48deg, #eeeeee 48deg, #eeeeee 360deg);',
  )
  assert.equal(partial.endCap, 'transform: rotate(48deg);')
  assert.equal(partial.caps, true)
  // Empty and full rings have no caps; out-of-range angles are clamped.
  assert.equal(ringStyle(0, '#1', '#2').caps, false)
  assert.equal(ringStyle(360, '#1', '#2').caps, false)
  assert.equal(ringStyle(500, '#1', '#2').endCap, 'transform: rotate(360deg);')
  assert.equal(ringStyle(Number.NaN, '#1', '#2').caps, false)
})

test('badge text', () => {
  assert.equal(badgeText(0), null)
  assert.equal(badgeText(-1), null)
  assert.equal(badgeText(18), '18')
  assert.equal(badgeText(99), '99')
  assert.equal(badgeText(100), '99+')
})

test('homeView: due, finished and idle', () => {
  const due = homeView(
    summary({ due: 24, newAvailable: 12, reviewDue: 12, doneToday: 18, estimatedMinutes: 4, streakDays: 23 }),
  )
  assert.equal(due.mode, 'due')
  assert.equal(due.done, 18)
  assert.equal(due.total, 42)
  assert.equal(due.meta, '新卡 12 · 复习 12 · 约 4 分钟')
  assert.equal(due.streak, '连续 23 天')

  const finished = homeView(summary({ doneToday: 30, streakDays: 1 }))
  assert.equal(finished.mode, 'finished')
  assert.equal(finished.total, 30)
  assert.equal(finished.ringDegrees, 360)
  assert.equal(finished.meta, '')

  const idle = homeView(summary({}))
  assert.equal(idle.mode, 'idle')
  assert.equal(idle.streak, '')
})

test('reminders: ask on 开始复习 only when turned on and configured', () => {
  assert.equal(reminderTemplateToAsk(21, 'tmpl-1'), 'tmpl-1')
  assert.equal(reminderTemplateToAsk(0, 'tmpl-1'), 'tmpl-1', 'midnight is a valid hour')
  assert.equal(reminderTemplateToAsk(null, 'tmpl-1'), null)
  assert.equal(reminderTemplateToAsk(21, null), null)
  assert.equal(reminderAccepted({ errMsg: 'requestSubscribeMessage:ok', 'tmpl-1': 'accept' }, 'tmpl-1'), true)
  assert.equal(reminderAccepted({ 'tmpl-1': 'reject' }, 'tmpl-1'), false)
  assert.equal(reminderAccepted({ 'tmpl-2': 'accept' }, 'tmpl-1'), false)
  assert.equal(readReminderTemplateId({ reminderTemplateId: 'tmpl-1' }), 'tmpl-1')
  assert.equal(readReminderTemplateId({ reminderTemplateId: null }), null)
  assert.equal(readReminderTemplateId({ reminderTemplateId: '  ' }), null)
  assert.equal(readReminderTemplateId('x'), null)
})
