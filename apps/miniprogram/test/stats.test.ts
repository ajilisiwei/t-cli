import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HEATMAP_WEEKS,
  RETENTION_WEEKS,
  addDays,
  buildHeatmap,
  buildRetentionBars,
  dayLabel,
  formatCount,
  heatLevel,
  heatmapDays,
  isDateKey,
  mondayOf,
  monthMarks,
  readStats,
  retentionSummary,
  totalCells,
  weekdayIndex,
} from '../miniprogram/lib/stats.ts'
import {
  mergeDates,
  percent,
  rankedRows,
  readMaterialDates,
  readWeeklyMaterial,
  retentionChange,
  weekNeighbours,
  weekRangeLabel,
} from '../miniprogram/lib/weekly.ts'

test('date keys: validation and day arithmetic', () => {
  assert.equal(isDateKey('2026-11-20'), true)
  assert.equal(isDateKey('2026-02-30'), false)
  assert.equal(isDateKey('2026-1-2'), false)
  assert.equal(isDateKey(20261120), false)
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(addDays('2024-03-01', -1), '2024-02-29')
  // 2026-11-20 is a Friday; weeks start on Monday.
  assert.equal(weekdayIndex('2026-11-20'), 4)
  assert.equal(weekdayIndex('2026-11-22'), 6)
  assert.equal(mondayOf('2026-11-22'), '2026-11-16')
  assert.equal(mondayOf('2026-11-16'), '2026-11-16')
  assert.equal(heatmapDays(), 119)
})

test('readStats keeps valid days and weeks and clamps rates', () => {
  const stats = readStats({
    days: [
      { date: '2026-11-18', entries: 3, reviews: 12 },
      { date: 'bad', entries: 1, reviews: 1 },
      { date: '2026-11-19', entries: -2, reviews: 'x' },
    ],
    streakDays: 4,
    retention: [
      { weekStart: '2026-11-16', rate: 1.2 },
      { weekStart: '2026-11-09', rate: 'x' },
      { weekStart: '2026-11-02', rate: 0.875 },
    ],
    totals: { entries: 120, items: 40, cards: 90, mastered: 2 },
  })
  assert.ok(stats !== null)
  assert.deepEqual(stats.days, [
    { date: '2026-11-18', entries: 3, reviews: 12 },
    { date: '2026-11-19', entries: 0, reviews: 0 },
  ])
  assert.deepEqual(stats.retention, [
    { weekStart: '2026-11-16', rate: 1 },
    { weekStart: '2026-11-02', rate: 0.875 },
  ])
  assert.equal(stats.streakDays, 4)
  assert.deepEqual(stats.totals, { entries: 120, items: 40, cards: 90, mastered: 2 })
  assert.deepEqual(readStats({ days: [] })?.totals, { entries: 0, items: 0, cards: 0, mastered: 0 })
  assert.equal(readStats({}), null)
})

test('heat levels scale to the busiest day, with a floor', () => {
  assert.equal(heatLevel(0, 50), 0)
  assert.equal(heatLevel(1, 1), 1) // one action is not a full square
  assert.equal(heatLevel(8, 8), 4)
  assert.equal(heatLevel(50, 50), 4)
  assert.equal(heatLevel(25, 50), 2)
  assert.equal(heatLevel(26, 50), 3)
  assert.equal(heatLevel(1, 50), 1)
})

test('the heatmap has 17 Monday-first weeks ending with today', () => {
  const today = '2026-11-20' // Friday
  const heatmap = buildHeatmap(
    [
      { date: '2026-11-20', entries: 2, reviews: 30 },
      { date: '2026-11-18', entries: 3, reviews: 0 },
      { date: '2026-11-21', entries: 9, reviews: 9 }, // the future: ignored
      { date: '2026-01-01', entries: 9, reviews: 9 }, // before the window
    ],
    today,
  )
  assert.equal(heatmap.columns.length, HEATMAP_WEEKS)
  const first = heatmap.columns[0]!
  const last = heatmap.columns[HEATMAP_WEEKS - 1]!
  assert.equal(first.cells[0]?.date, '2026-07-27')
  assert.equal(weekdayIndex(first.cells[0]!.date), 0)
  assert.equal(last.key, '2026-11-16')
  assert.equal(last.cells[4]?.date, today)
  assert.equal(last.cells[4]?.level, 4)
  assert.equal(last.cells[4]?.label, '11月20日 查询 2 条 · 复习 30 张')
  assert.equal(last.cells[2]?.level, 1)
  assert.deepEqual(
    last.cells.map((cell) => cell.future),
    [false, false, false, false, false, true, true],
  )
  assert.equal(last.cells[5]?.level, 0)
  assert.equal(last.cells[5]?.label, '')
  assert.equal(heatmap.activeDays, 2)
  assert.ok(heatmap.columns.every((column) => column.cells.length === 7))
})

test('month labels sit on month starts and never crowd each other', () => {
  const heatmap = buildHeatmap([], '2026-11-20')
  const labelled = heatmap.columns
    .map((column, index) => [index, column.month] as const)
    .filter(([, month]) => month !== '')
  // The window starts on 2026-07-27, so August 1 is already in column 0.
  assert.deepEqual(labelled, [
    [0, '8月'],
    [5, '9月'],
    [9, '10月'],
    [13, '11月'],
  ])
  for (let i = 1; i < labelled.length; i += 1) assert.ok(labelled[i]![0] - labelled[i - 1]![0] >= 3)
  // A window starting well before the first month start labels its first column…
  const late = buildHeatmap([], '2026-12-30')
  assert.equal(late.columns[0]?.month, '9月')
  assert.equal(late.columns[3]?.month, '10月')
  // …but not when a month starts in the next column or two.
  const early = buildHeatmap([], '2026-12-16')
  assert.deepEqual(
    early.columns.slice(0, 3).map((column) => column.month),
    ['', '9月', ''],
  )
  assert.deepEqual(
    monthMarks(heatmap.columns, 48, 36).map((mark) => [mark.text, mark.left]),
    [
      ['8月', 48],
      ['9月', 228],
      ['10月', 372],
      ['11月', 516],
    ],
  )
})

test('day labels say what happened', () => {
  assert.equal(dayLabel('2026-11-03', 0, 0), '11月3日 没有记录')
  assert.equal(dayLabel('2026-11-03', 0, 4), '11月3日 复习 4 张')
  assert.equal(dayLabel('2026-11-03', 1, 0), '11月3日 查询 1 条')
})

test('retention bars cover 12 weeks ending this week', () => {
  const bars = buildRetentionBars(
    [
      { weekStart: '2026-11-16', rate: 0.92 },
      { weekStart: '2026-11-02', rate: 0.875 },
      { weekStart: '2026-01-05', rate: 0.5 }, // outside
    ],
    '2026-11-20',
  )
  assert.equal(bars.length, RETENTION_WEEKS)
  assert.equal(bars[0]?.weekStart, '2026-08-31')
  assert.equal(bars[11]?.weekStart, '2026-11-16')
  assert.deepEqual(
    { rate: bars[11]?.rate, height: bars[11]?.height, percent: bars[11]?.percent, mark: bars[11]?.mark },
    { rate: 0.92, height: 92, percent: '92%', mark: '92' },
  )
  assert.equal(bars[10]?.mark, '')
  assert.equal(bars[10]?.rate, null)
  assert.equal(bars[10]?.height, 0)
  assert.equal(bars[10]?.label, '11月9日那周 没有复习')
  assert.equal(bars[9]?.percent, '88%')
  assert.deepEqual(
    bars.map((bar) => bar.tick).filter((tick) => tick !== ''),
    ['8/31', '10/5', '11/16'],
  )
  assert.equal(retentionSummary(bars), '本周保持率 92%')
  const lastWeekOnly = buildRetentionBars([{ weekStart: '2026-11-09', rate: 0.8 }], '2026-11-20')
  assert.equal(retentionSummary(lastWeekOnly), '最近一次 80%（11月9日那周）')
  assert.equal(retentionSummary(buildRetentionBars([], '2026-11-20')), '近 12 周还没有复习过学过的卡片')
})

test('totals are formatted with separators', () => {
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(999), '999')
  assert.equal(formatCount(1234567), '1,234,567')
  assert.deepEqual(
    totalCells({ entries: 1234, items: 40, cards: 90, mastered: 2 }).map((cell) => cell.value),
    ['1,234', '40', '90', '2'],
  )
})

const weekly = {
  date: '2026-11-09',
  content: {
    weekStart: '2026-11-09',
    weekEnd: '2026-11-15',
    totals: { entries: 56, newItems: 18, reviews: 240 },
    topErrors: [{ title: 'look forward to + doing', count: 3 }, { title: '', count: 1 }],
    topLookups: [{ display: 'meticulous', count: 4 }, { count: 2 }],
    retention: { thisWeek: 0.92, lastWeek: 0.884 },
    summary: '  这周查得多。 ',
  },
  createdAt: '2026-11-16T21:00:00.000Z',
}

test('readWeeklyMaterial validates the report', () => {
  const material = readWeeklyMaterial(weekly)
  assert.ok(material !== null)
  assert.equal(material.date, '2026-11-09')
  assert.deepEqual(material.content.topErrors, [{ title: 'look forward to + doing', count: 3 }])
  assert.deepEqual(material.content.topLookups, [{ display: 'meticulous', count: 4 }])
  assert.equal(material.content.summary, '这周查得多。')
  const sparse = readWeeklyMaterial({ date: '2026-11-09', content: { retention: { thisWeek: 2 } } })
  assert.ok(sparse !== null)
  assert.equal(sparse.content.weekStart, '2026-11-09')
  assert.equal(sparse.content.weekEnd, '')
  assert.deepEqual(sparse.content.retention, { thisWeek: 1, lastWeek: null })
  assert.deepEqual(sparse.content.totals, { entries: 0, newItems: 0, reviews: 0 })
  assert.equal(readWeeklyMaterial({ date: 'x', content: {} }), null)
  assert.equal(readWeeklyMaterial({ date: '2026-11-09', content: null }), null)
})

test('weekly date lists merge newest first and give neighbours', () => {
  assert.deepEqual(readMaterialDates({ dates: ['2026-11-09', 'bad', '2026-11-02'], nextBefore: '2026-11-02' }), {
    dates: ['2026-11-09', '2026-11-02'],
    nextBefore: '2026-11-02',
  })
  assert.equal(readMaterialDates({ dates: [] })?.nextBefore, null)
  assert.equal(readMaterialDates({}), null)
  const dates = mergeDates(['2026-11-09', '2026-11-02'], ['2026-10-26', '2026-11-02', '2026-11-16'])
  assert.deepEqual(dates, ['2026-11-16', '2026-11-09', '2026-11-02', '2026-10-26'])
  assert.deepEqual(weekNeighbours(dates, '2026-11-09'), { previous: '2026-11-02', next: '2026-11-16' })
  assert.deepEqual(weekNeighbours(dates, '2026-11-16'), { previous: '2026-11-09', next: null })
  assert.deepEqual(weekNeighbours(dates, '2026-10-26'), { previous: null, next: '2026-11-02' })
  // A gap (no report that week) is skipped.
  assert.deepEqual(weekNeighbours(['2026-11-16', '2026-10-26'], '2026-11-16').previous, '2026-10-26')
})

test('week ranges, percentages and change', () => {
  assert.equal(weekRangeLabel('2026-11-09', '2026-11-15', 2026), '11月9日 – 15日')
  assert.equal(weekRangeLabel('2026-11-30', '2026-12-06', 2026), '11月30日 – 12月6日')
  assert.equal(weekRangeLabel('2025-11-03', '2025-11-09', 2026), '2025年11月3日 – 9日')
  assert.equal(weekRangeLabel('2025-12-29', '2026-01-04', 2026), '2025年12月29日 – 2026年1月4日')
  assert.equal(weekRangeLabel('2026-11-09', '', 2026), '11月9日起的一周')
  assert.equal(percent(0.884), '88%')
  assert.equal(percent(null), '—')
  assert.equal(retentionChange(0.92, 0.884), '比上周高 4 个百分点')
  assert.equal(retentionChange(0.8, 0.9), '比上周低 10 个百分点')
  assert.equal(retentionChange(0.9, 0.9), '与上周持平')
  assert.equal(retentionChange(0.9, null), '')
  assert.deepEqual(rankedRows([{ name: 'meticulous', count: 4 }]), [{ key: '0', text: 'meticulous', count: '4 次' }])
})
