import test from 'node:test'
import assert from 'node:assert/strict'
import {
  durationParts,
  formatDuration,
  formatInterval,
  formatShare,
  gradeButtons,
  percent,
} from '../miniprogram/lib/review-format.ts'
import { badgeText, reminderAccepted, reminderTemplateToAsk } from '../miniprogram/lib/review-home.ts'
import { readReminderTemplateId } from '../miniprogram/lib/review-validate.ts'

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

test('badge text', () => {
  assert.equal(badgeText(0), null)
  assert.equal(badgeText(-1), null)
  assert.equal(badgeText(18), '18')
  assert.equal(badgeText(99), '99')
  assert.equal(badgeText(100), '99+')
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
