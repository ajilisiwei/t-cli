import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DELETE_CONFIRM,
  REMINDER_OPTIONS,
  SUBSCRIBE_MESSAGES,
  defaultExportFileName,
  exportFileName,
  formatBytes,
  headerValue,
  hourToOption,
  isExportFile,
  optionToHour,
  readDeleted,
  readGrantAvailable,
  readReminderTemplate,
  reminderLabel,
  subscribeFailure,
  subscribeOutcome,
} from '../miniprogram/lib/account.ts'

const now = new Date(2026, 10, 20, 9, 30)

test('the export is named after the local date by default', () => {
  assert.equal(defaultExportFileName(now), 't-cli-export-20261120.md')
  assert.equal(defaultExportFileName(new Date(2027, 0, 3)), 't-cli-export-20270103.md')
})

test('exportFileName takes a plain .md name from Content-Disposition', () => {
  assert.equal(exportFileName('attachment; filename="t-cli-export-20261119.md"', now), 't-cli-export-20261119.md')
  assert.equal(exportFileName('attachment; filename=t-cli-export-20261119.md', now), 't-cli-export-20261119.md')
  assert.equal(
    exportFileName("attachment; filename*=UTF-8''t-cli-export-20261118.md; filename=\"x.md\"", now),
    't-cli-export-20261118.md',
  )
})

test('exportFileName never returns a path or another file type', () => {
  for (const header of [
    'attachment; filename="../../etc/passwd.md"',
    'attachment; filename="a/b.md"',
    'attachment; filename="..md"',
    'attachment; filename="export.txt"',
    'attachment; filename=""',
    "attachment; filename*=UTF-8''%2E%2E%2Fx.md",
    'attachment',
    'inline; filename="中文.md"',
  ]) {
    assert.equal(exportFileName(header, now), 't-cli-export-20261120.md', header)
  }
  assert.equal(exportFileName(null, now), 't-cli-export-20261120.md')
})

test('headers are looked up case-insensitively', () => {
  assert.equal(headerValue({ 'Content-Disposition': 'a' }, 'content-disposition'), 'a')
  assert.equal(headerValue({ 'content-disposition': ['b'] }, 'Content-Disposition'), 'b')
  assert.equal(headerValue({ other: 'c' }, 'content-disposition'), null)
  assert.equal(headerValue(null, 'x'), null)
})

test('export files and sizes', () => {
  assert.equal(isExportFile('t-cli-export-20261120.md'), true)
  assert.equal(isExportFile('tts-abc.mp3'), false)
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(1536 * 1024), '1.5 MB')
  assert.equal(formatBytes(Number.NaN), '0 B')
})

test('reminder config, grants and deletion responses are validated', () => {
  assert.equal(readReminderTemplate({ reminderTemplateId: 'tmpl-1' }), 'tmpl-1')
  assert.equal(readReminderTemplate({ reminderTemplateId: null }), null)
  assert.equal(readReminderTemplate({ reminderTemplateId: '' }), undefined)
  assert.equal(readReminderTemplate({}), undefined)
  assert.equal(readReminderTemplate('x'), undefined)
  assert.equal(readGrantAvailable({ available: 2 }), 2)
  assert.equal(readGrantAvailable({ available: 0 }), 0)
  assert.equal(readGrantAvailable({ available: -1 }), null)
  assert.equal(readGrantAvailable({}), null)
  assert.equal(readDeleted({ deleted: true }), true)
  assert.equal(readDeleted({ deleted: 'yes' }), false)
  assert.equal(DELETE_CONFIRM, 'DELETE')
})

test('the subscribe dialog answer is read per template', () => {
  const result = { errMsg: 'requestSubscribeMessage:ok', 'tmpl-1': 'accept', 'tmpl-2': 'reject' }
  assert.equal(subscribeOutcome(result, 'tmpl-1'), 'accept')
  assert.equal(subscribeOutcome(result, 'tmpl-2'), 'reject')
  assert.equal(subscribeOutcome(result, 'tmpl-3'), 'unknown')
  assert.equal(subscribeOutcome({ t: 'ban' }, 't'), 'ban')
  assert.equal(subscribeOutcome(null, 't'), 'unknown')
  assert.equal(subscribeFailure(20004), 'off')
  assert.equal(subscribeFailure(10005), 'unknown')
  for (const outcome of ['reject', 'ban', 'filter', 'off', 'unknown'] as const) {
    assert.ok(SUBSCRIBE_MESSAGES[outcome].length > 0)
  }
})

test('the reminder picker maps rows to hours', () => {
  assert.equal(REMINDER_OPTIONS.length, 25)
  assert.equal(REMINDER_OPTIONS[0], '关闭')
  assert.equal(REMINDER_OPTIONS[22], '21:00')
  assert.equal(hourToOption(null), 0)
  assert.equal(hourToOption(21), 22)
  assert.equal(hourToOption(24), 0)
  assert.equal(optionToHour(22), 21)
  assert.equal(optionToHour('1'), 0)
  assert.equal(optionToHour(0), null)
  assert.equal(optionToHour('x'), null)
  for (let hour = 0; hour < 24; hour += 1) assert.equal(optionToHour(hourToOption(hour)), hour)
  assert.equal(reminderLabel(null), '关闭')
  assert.equal(reminderLabel(7), '每天 7:00')
})
