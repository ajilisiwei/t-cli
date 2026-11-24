import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_RECORD_FILTER,
  MAX_HISTORY_QUERY,
  STRIP_DAYS,
  addDays,
  chipSource,
  countsByDate,
  dayHeader,
  emptyRecordsText,
  groupByDay,
  historyFilters,
  isDateKey,
  isUnfiltered,
  localClockAt,
  localDateAt,
  monthDay,
  normalizeHistoryQuery,
  sameRecordFilter,
  stripAnchor,
  stripChips,
  stripRange,
  toDayRow,
  weekdayOf,
} from '../miniprogram/lib/history-days.ts'
import type { HistoryEntry } from '../miniprogram/lib/types.ts'

const CHINA = 480

const entry = (id: string, createdAt: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  seq: 1,
  source: 'mp',
  task: 'translate',
  kind: 'word',
  input: 'concise',
  output: '**adj.** 简洁的\n更多解释',
  srcLang: 'en',
  mode: 'simple',
  createdAt,
  correctedInput: null,
  ...extra,
})

test('date keys: validity, arithmetic across months and years', () => {
  assert.equal(isDateKey('2026-11-24'), true)
  assert.equal(isDateKey('2026-02-30'), false)
  assert.equal(isDateKey('2026-1-1'), false)
  assert.equal(isDateKey(20261124), false)
  assert.equal(addDays('2026-11-24', -1), '2026-11-23')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('nope', 3), 'nope')
})

test('local date and clock at an explicit offset', () => {
  const ms = Date.parse('2026-11-23T16:30:00.000Z')
  assert.equal(localDateAt(ms, CHINA), '2026-11-24')
  assert.equal(localClockAt(ms, CHINA), '00:30')
  assert.equal(localDateAt(ms, 0), '2026-11-23')
  assert.equal(localDateAt(ms, -300), '2026-11-23')
  assert.equal(localClockAt(ms, -300), '11:30')
})

test('weekday, month-day and day headers', () => {
  assert.equal(weekdayOf('2026-11-24'), '周二')
  assert.equal(weekdayOf('2026-11-22'), '周日')
  assert.equal(weekdayOf('bad'), '')
  assert.equal(monthDay('2026-11-22', '2026-11-24'), '11月22日')
  assert.equal(monthDay('2025-11-22', '2026-11-24'), '2025年11月22日')
  assert.deepEqual(dayHeader('2026-11-24', '2026-11-24'), { label: '今天', full: '11月24日 周二' })
  assert.deepEqual(dayHeader('2026-11-23', '2026-11-24'), { label: '昨天', full: '11月23日 周一' })
  assert.deepEqual(dayHeader('2026-11-22', '2026-11-24'), { label: '11月22日', full: '周日' })
})

test('history query: trimmed, literal, at most 100 code points', () => {
  assert.equal(normalizeHistoryQuery('  look  up '), 'look  up')
  assert.equal(normalizeHistoryQuery('   '), '')
  const long = '词'.repeat(MAX_HISTORY_QUERY + 20)
  assert.equal(Array.from(normalizeHistoryQuery(long)).length, MAX_HISTORY_QUERY)
})

test('historyFilters leaves out absent filters and carries the offset with a date', () => {
  assert.deepEqual(historyFilters(EMPTY_RECORD_FILTER, CHINA), {})
  assert.deepEqual(historyFilters({ date: '2026-11-22', source: 'cli', q: ' deadline ' }, CHINA), {
    date: '2026-11-22',
    utcOffsetMinutes: CHINA,
    source: 'cli',
    q: 'deadline',
  })
  assert.deepEqual(historyFilters({ date: null, source: 'mp', q: '  ' }, CHINA), { source: 'mp' })
})

test('filter comparison, source chips and empty texts', () => {
  assert.equal(sameRecordFilter({ date: null, source: null, q: 'a ' }, { date: null, source: null, q: ' a' }), true)
  assert.equal(sameRecordFilter({ date: '2026-11-24', source: null, q: '' }, EMPTY_RECORD_FILTER), false)
  assert.equal(isUnfiltered({ date: null, source: null, q: '  ' }), true)
  assert.equal(chipSource('mp'), 'mp')
  assert.equal(chipSource('cli'), 'cli')
  assert.equal(chipSource(''), null)
  assert.equal(chipSource('h5'), null)
  assert.equal(emptyRecordsText(EMPTY_RECORD_FILTER), '还没有记录')
  assert.equal(emptyRecordsText({ date: '2026-11-21', source: null, q: '' }), '这一天没有符合条件的记录')
  assert.equal(emptyRecordsText({ date: null, source: 'cli', q: '' }), '还没有来自CLI的记录')
  assert.equal(emptyRecordsText({ date: '2026-11-21', source: 'mp', q: 'xyz' }), '没有包含「xyz」的记录')
})

test('stripRange: the last month, or a window ending a few days after a date picked earlier', () => {
  const today = '2026-11-24'
  assert.deepEqual(stripRange(today, null), { from: addDays(today, -(STRIP_DAYS - 1)), to: today })
  assert.deepEqual(stripRange(today, '2026-11-10'), { from: addDays(today, -(STRIP_DAYS - 1)), to: today })
  assert.deepEqual(stripRange(today, '2026-03-05'), { from: addDays('2026-03-08', -(STRIP_DAYS - 1)), to: '2026-03-08' })
  // A picked day just outside the window: the window moves back and contains it.
  const justOutside = addDays(today, -STRIP_DAYS)
  assert.equal(stripRange(today, justOutside).to, addDays(justOutside, 3))
  assert.equal(stripRange(today, justOutside).from <= justOutside, true)
  // A picked day near the window's start never pushes its end past today.
  assert.equal(stripRange(today, addDays(today, -(STRIP_DAYS + 1)), STRIP_DAYS).to <= today, true)
  assert.deepEqual(stripRange(today, '2026-11-24', 3), { from: '2026-11-22', to: today })
})

test('stripChips: newest first, counts, greyed empty days, selection', () => {
  const today = '2026-11-24'
  const counts = countsByDate([
    { date: '2026-11-22', count: 2 },
    { date: '2026-11-24', count: 3 },
  ])
  const chips = stripChips({ from: '2026-11-21', to: today }, today, counts, '2026-11-21')
  assert.deepEqual(
    chips.map((chip) => [chip.date, chip.top, chip.mid, chip.countLabel, chip.empty, chip.selected]),
    [
      ['2026-11-24', '今天', '24', '3 条', false, false],
      ['2026-11-23', '周一', '23', '0 条', true, false],
      ['2026-11-22', '周日', '22', '2 条', false, false],
      // Selected (picked from the calendar) stays tappable even with no records.
      ['2026-11-21', '周六', '21', '0 条', false, true],
    ],
  )
  assert.equal(chips[0]?.anchor, stripAnchor('2026-11-24'))
  assert.equal(chips[0]?.anchor, 'day20261124')
  assert.equal(chips[2]?.aria, '11月22日 周日，2 条')
  // Unknown counts: nothing is greyed and no count is shown.
  const unknown = stripChips({ from: '2026-11-23', to: today }, today, null, null)
  assert.deepEqual(
    unknown.map((chip) => [chip.countLabel, chip.empty]),
    [
      ['', false],
      ['', false],
    ],
  )
})

test('toDayRow: clock at the offset, labels, first line preview, serif for Latin input', () => {
  const row = toDayRow(entry('a', '2026-11-24T01:41:00.000Z', { source: 'cli', task: 'check' }), CHINA)
  assert.equal(row.time, '09:41')
  assert.equal(row.sourceLabel, 'CLI')
  assert.equal(row.taskLabel, '纠错')
  assert.equal(row.preview, 'adj. 简洁的')
  assert.equal(row.serif, true)
  assert.equal(toDayRow(entry('b', '2026-11-24T01:41:00.000Z', { input: '灰度发布' }), CHINA).serif, false)
  assert.equal(toDayRow(entry('c', 'garbage'), CHINA).time, '')
})

test('groupByDay: newest day first, newest record first, header counts', () => {
  const today = '2026-11-24'
  const entries = [
    entry('3', '2026-11-24T01:00:00.000Z'), // 09:00 today
    entry('2', '2026-11-23T13:00:00.000Z'), // 21:00 yesterday
    // A CLI record pushed late: newer seq order, older time.
    entry('1', '2026-11-24T00:10:00.000Z', { source: 'cli' }), // 08:10 today
    entry('0', '2026-11-21T12:00:00.000Z'), // 20:00 Nov 21
  ]
  const groups = groupByDay(entries, CHINA, today, { '2026-11-24': 5 })
  assert.deepEqual(
    groups.map((group) => [group.date, group.label, group.full, group.countLabel, group.rows.map((row) => row.id)]),
    [
      ['2026-11-24', '今天', '11月24日 周二', '5 条', ['3', '1']],
      ['2026-11-23', '昨天', '11月23日 周一', '1 条', ['2']],
      ['2026-11-21', '11月21日', '周六', '1 条', ['0']],
    ],
  )
  // Without counts (a search), each header counts its loaded rows.
  assert.equal(groupByDay(entries, CHINA, today, null)[0]?.countLabel, '2 条')
  assert.deepEqual(groupByDay([], CHINA, today, null), [])
})
