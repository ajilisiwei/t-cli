import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPORT_KEEP_MS,
  MAX_EXPORT_RECORDS,
  addRecord,
  daysLeft,
  exportedAtLabel,
  orphanFiles,
  pruneRecords,
  readRecords,
  recordRow,
  type ExportRecord,
} from '../miniprogram/lib/export-records.ts'

const DIR = 'wxfile://usr/exports'
const DAY = 86_400_000
const NOW = new Date(2026, 10, 25, 14, 3).getTime()

const record = (name: string, ageMs: number, pages: number | null = 3): ExportRecord => ({
  path: `${DIR}/${name}`,
  fileName: name,
  pages,
  bytes: 395_264,
  createdAt: NOW - ageMs,
})

test('readRecords keeps well-formed records, newest first', () => {
  const older = record('a.pdf', 2 * DAY)
  const newer = record('b.pdf', DAY)
  const newest = { ...newer, pages: 0, path: 'p', createdAt: NOW }
  assert.deepEqual(readRecords([older, { path: '', fileName: 'x' }, newer, 'junk', newest]), [
    { ...newest, pages: null },
    newer,
    older,
  ])
  assert.deepEqual(readRecords(null), [])
})

test('addRecord puts the new one first and replaces the same file', () => {
  const first = record('学习资料_1125.pdf', DAY)
  const again = record('学习资料_1125.pdf', 0, 4)
  const other = record('单词卡_1125.pdf', 2 * DAY)
  assert.deepEqual(addRecord([first, other], again), [again, other])
  const many = Array.from({ length: MAX_EXPORT_RECORDS }, (_, i) => record(`${i}.pdf`, i))
  assert.equal(addRecord(many, record('new.pdf', 0)).length, MAX_EXPORT_RECORDS)
})

test('pruneRecords: expired files go, missing files are forgotten', () => {
  const fresh = record('fresh.pdf', DAY)
  const old = record('old.pdf', EXPORT_KEEP_MS)
  const gone = record('gone.pdf', DAY)
  const pruned = pruneRecords([fresh, old, gone], NOW, (path) => path !== gone.path)
  assert.deepEqual(pruned.kept, [fresh])
  assert.deepEqual(pruned.expired, [old])
})

test('orphanFiles: files no kept record knows', () => {
  const kept = [record('a.pdf', 0)]
  assert.deepEqual(orphanFiles(['a.pdf', 'b.pdf'], DIR, kept), ['b.pdf'])
})

test('days left and the row text', () => {
  assert.equal(daysLeft(record('a.pdf', 0), NOW), 7)
  assert.equal(daysLeft(record('a.pdf', DAY + 1), NOW), 6)
  assert.equal(daysLeft(record('a.pdf', EXPORT_KEEP_MS - 1), NOW), 1)
  assert.equal(exportedAtLabel(NOW, NOW), '今天 14:03')
  assert.equal(exportedAtLabel(NOW - DAY, NOW), '昨天 14:03')
  assert.equal(exportedAtLabel(NOW - 3 * DAY, NOW), '11月22日 14:03')
  const row = recordRow(record('a.pdf', 0), NOW, (bytes) => `${Math.round(bytes / 1024)} KB`)
  assert.equal(row.meta, '今天 14:03 · 3 页 · 386 KB')
  assert.equal(row.left, '还剩 7 天')
  assert.equal(recordRow(record('a.pdf', 0, null), NOW, () => '1 KB').meta, '今天 14:03 · 1 KB')
})
