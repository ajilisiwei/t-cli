import test from 'node:test'
import assert from 'node:assert/strict'
import type { MaterialListItem } from '../miniprogram/lib/learn-types.ts'
import {
  addDays,
  appendItems,
  dayLabel,
  groupByWeek,
  homeDateLabel,
  localStamp,
  materialDateLabel,
  materialMeta,
  materialRow,
  materialStatus,
  materialUrl,
  mondayOf,
  noMaterialsText,
  planSummary,
  rangeLabel,
  relativeDay,
  scopeChips,
  startLabel,
  thisWeekPrintable,
  todayView,
  weekTitle,
} from '../miniprogram/lib/learn-view.ts'

const ALL_PARTS = ['words', 'phrases', 'grammar', 'story', 'exercises'] as const

const item = (overrides: Partial<MaterialListItem>): MaterialListItem => ({
  kind: 'daily',
  date: '2026-11-24',
  title: '9 个词和一篇短文',
  counts: { words: 6, phrases: 2, grammar: 1, exercises: 8, items: 0 },
  readAt: null,
  pages: 3,
  createdAt: '',
  ...overrides,
})

test('calendar helpers: days, Mondays, labels', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(addDays('nope', 1), '')
  // 2026-11-25 is a Wednesday.
  assert.equal(mondayOf('2026-11-25'), '2026-11-23')
  assert.equal(mondayOf('2026-11-29'), '2026-11-23')
  assert.equal(mondayOf('2026-11-23'), '2026-11-23')
  assert.equal(dayLabel('2026-11-25'), '11月25日 周三')
  assert.equal(rangeLabel('2026-11-17', '2026-11-23'), '11月17日–23日')
  assert.equal(rangeLabel('2026-10-27', '2026-11-02'), '10月27日–11月2日')
})

test('relativeDay: 今天, 昨天, earlier this week, else the date', () => {
  const today = '2026-11-25'
  assert.equal(relativeDay('2026-11-25', today), '今天')
  assert.equal(relativeDay('2026-11-24', today), '昨天')
  assert.equal(relativeDay('2026-11-23', today), '本周一')
  assert.equal(relativeDay('2026-11-22', today), '11月22日')
})

test('localStamp reads the local day and time of an ISO instant', () => {
  const local = new Date(2026, 10, 25, 5, 3)
  assert.deepEqual(localStamp(local.toISOString()), { date: '2026-11-25', time: '05:03' })
  assert.equal(localStamp(''), null)
  assert.equal(localStamp('not a date'), null)
})

test('dates of list rows and home cards per kind', () => {
  assert.equal(materialDateLabel(item({ kind: 'daily' })), '11月24日 周二')
  assert.equal(materialDateLabel(item({ kind: 'digest', date: '2026-11-24' })), '11月18日–24日')
  assert.equal(materialDateLabel(item({ kind: 'weekly', date: '2026-11-17' })), '11月17日–23日')
  const today = '2026-11-25'
  const created = new Date(2026, 10, 25, 5, 0).toISOString()
  assert.equal(homeDateLabel(item({ kind: 'daily', createdAt: created }), today), '今天 05:00')
  assert.equal(homeDateLabel(item({ kind: 'daily', createdAt: '' }), today), '昨天')
  assert.equal(homeDateLabel(item({ kind: 'extend', date: '2026-11-23' }), today), '本周一')
})

test('materialMeta lists the parts shown; extension and report differ', () => {
  assert.equal(materialMeta(item({}), ALL_PARTS), '单词 6 · 词组 2 · 语法 1 · 练习 8 题')
  assert.equal(materialMeta(item({}), ['words', 'story']), '单词 6')
  assert.equal(materialMeta(item({ counts: { words: 0, phrases: 0, grammar: 0, exercises: 0, items: 0 } }), ALL_PARTS), '')
  assert.equal(materialMeta(item({ kind: 'extend', counts: { words: 0, phrases: 0, grammar: 0, exercises: 0, items: 10 } }), ALL_PARTS), '10 个词和表达')
  assert.equal(materialMeta(item({ kind: 'weekly' }), ALL_PARTS), '')
})

test('materialStatus: 未读 / 新 / 已学完; none for a report', () => {
  assert.deepEqual(materialStatus(item({})), { text: '未读', tone: 'accent' })
  assert.deepEqual(materialStatus(item({ kind: 'extend' })), { text: '新', tone: 'accent' })
  assert.deepEqual(materialStatus(item({ readAt: '2026-11-25T01:00:00Z' })), { text: '已学完', tone: 'muted' })
  assert.equal(materialStatus(item({ kind: 'weekly' })), null)
})

test('materialUrl opens the page of each kind', () => {
  assert.equal(materialUrl(item({})), '/pages/materials/index?kind=daily&date=2026-11-24&pages=3')
  assert.equal(materialUrl(item({ kind: 'digest' })), '/pages/materials/index?kind=digest&date=2026-11-24&pages=3')
  assert.equal(materialUrl(item({ kind: 'extend', date: '2026-11-23', pages: 2 })), '/pages/extend/index?date=2026-11-23&pages=2')
  assert.equal(materialUrl(item({ kind: 'weekly', date: '2026-11-17' })), '/pages/weekly/index?date=2026-11-17')
})

test('materialRow: a title is never empty; weekly is not printable', () => {
  const row = materialRow(item({ kind: 'weekly', title: '', date: '2026-11-17' }), ALL_PARTS)
  assert.equal(row.title, '周报')
  assert.equal(row.printable, false)
  assert.equal(row.statusTone, '')
  assert.equal(row.key, 'weekly:2026-11-17')
})

test('appendItems skips a kind and date already loaded', () => {
  const first = [item({ date: '2026-11-24' }), item({ kind: 'extend', date: '2026-11-23' })]
  const next = [item({ kind: 'extend', date: '2026-11-23' }), item({ date: '2026-11-22' })]
  assert.deepEqual(
    appendItems(first, next).map((row) => `${row.kind}:${row.date}`),
    ['daily:2026-11-24', 'extend:2026-11-23', 'daily:2026-11-22'],
  )
})

test('groupByWeek: 本周, 上周, then ranges; order kept', () => {
  const today = '2026-11-25'
  const rows = [
    { date: '2026-11-25' },
    { date: '2026-11-23' },
    { date: '2026-11-22' },
    { date: '2026-11-17' },
    { date: '2026-11-10' },
  ]
  const groups = groupByWeek(rows, today)
  assert.deepEqual(
    groups.map((group) => [group.title, group.rows.length]),
    [
      ['本周', 2],
      ['上周', 2],
      ['11月9日–15日', 1],
    ],
  )
  assert.equal(weekTitle('2026-11-23', today), '本周')
})

test('thisWeekPrintable: Monday to today, no reports, at most 8', () => {
  const today = '2026-11-25'
  const items = [
    item({ date: '2026-11-25' }),
    item({ kind: 'weekly', date: '2026-11-23' }),
    item({ kind: 'extend', date: '2026-11-23' }),
    item({ date: '2026-11-22' }),
  ]
  assert.deepEqual(
    thisWeekPrintable(items, today).map((row) => `${row.kind}:${row.date}`),
    ['daily:2026-11-25', 'extend:2026-11-23'],
  )
  const many = Array.from({ length: 10 }, () => item({ date: '2026-11-24' }))
  assert.equal(thisWeekPrintable(many, today).length, 8)
})

test('scope chips and the start button', () => {
  const chips = scopeChips({ all: 18, notes: 7, stars3: 9 }, 'notes')
  assert.deepEqual(
    chips.map((chip) => [chip.label, chip.checked]),
    [
      ['全部到期 18', false],
      ['只复习笔记本 7', true],
      ['3 星以上 9', false],
    ],
  )
  assert.equal(startLabel('all', 18), '开始复习 · 18 张')
  assert.equal(startLabel('notes', 7), '复习笔记本 · 7 张')
  assert.equal(startLabel('stars3', 9), '复习 3 星以上 · 9 张')
  assert.equal(startLabel('stars3', 0), '')
})

test('todayView: due, finished and idle', () => {
  const review = { dueByScope: { all: 18, notes: 7, stars3: 9 }, doneToday: 12, estimatedMinutes: 6, streakDays: 5 }
  const due = todayView(review)
  assert.equal(due.mode, 'due')
  assert.equal(due.caption, '今天要复习 · 连续 5 天')
  assert.equal(due.dueUnit, '张 · 约 6 分钟')
  assert.equal(due.meterPct, 40)
  assert.equal(due.meterLabel, '今天已完成 12 张，还剩 18 张')
  assert.equal(todayView({ ...review, dueByScope: { all: 0, notes: 0, stars3: 0 } }).mode, 'finished')
  const idle = todayView({ dueByScope: { all: 0, notes: 0, stars3: 0 }, doneToday: 0, estimatedMinutes: 0, streakDays: 0 })
  assert.equal(idle.mode, 'idle')
  assert.equal(idle.caption, '今天的复习')
  assert.equal(idle.meterPct, 0)
})

test('planSummary and the empty-materials text', () => {
  assert.equal(
    planSummary({ materialFrequency: 'daily', materialWeekday: 1, extendEnabled: true, reminderHour: 21 }),
    '每天出资料 · 拓展每周一份 · 21:00 提醒复习',
  )
  assert.equal(
    planSummary({ materialFrequency: 'weekly', materialWeekday: 0, extendEnabled: false, reminderHour: null }),
    '每周日出合集',
  )
  assert.equal(
    planSummary({ materialFrequency: 'off', materialWeekday: 1, extendEnabled: true, reminderHour: null }),
    '周期资料已关闭 · 拓展每周一份',
  )
  assert.match(noMaterialsText('off'), /学习计划/)
})
