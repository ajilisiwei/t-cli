import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTypedCode, parseUserCode } from '../miniprogram/lib/user-code.ts'
import {
  DEVELOP_API_BASE_URL,
  PRODUCTION_API_BASE_URL,
  devLoginCode,
  resolveApiBaseUrl,
} from '../miniprogram/lib/env.ts'
import { TTS_KEEP_FILES, filesToEvict, ttsFileName } from '../miniprogram/lib/tts-cache.ts'
import {
  EMPTY_HISTORY,
  appendPage,
  dayKeys,
  formatEntryTime,
  formatInstant,
  localDateKey,
  readHistoryPage,
  toHistoryRow,
} from '../miniprogram/lib/history.ts'
import type { HistoryEntry } from '../miniprogram/lib/types.ts'

test('parseUserCode accepts the CLI QR payload', () => {
  assert.equal(parseUserCode('tcli://device?code=123456'), '123456')
  assert.equal(parseUserCode('  TCLI://device/?code=004213&v=1 '), '004213')
  assert.equal(parseUserCode('tcli://device?v=1&code=987654'), '987654')
})

test('parseUserCode accepts six typed digits', () => {
  assert.equal(parseUserCode('123456'), '123456')
  assert.equal(parseUserCode('123 456'), '123456')
  assert.equal(parseUserCode('123-456'), '123456')
  assert.equal(normalizeTypedCode(' 12 34 56 '), '123456')
})

test('parseUserCode rejects anything else', () => {
  for (const raw of [
    '',
    '12345',
    '1234567',
    'abcdef',
    'tcli://device?code=12345',
    'tcli://device?code=1234567',
    'tcli://device',
    'tcli://other?code=123456',
    'https://example.com/?code=123456',
    'tcli://device?code=12a456',
  ]) {
    assert.equal(parseUserCode(raw), null, raw)
  }
})

test('API base URL follows the environment', () => {
  assert.equal(resolveApiBaseUrl('develop', {}), DEVELOP_API_BASE_URL)
  assert.equal(resolveApiBaseUrl('develop', { apiBaseUrl: 'http://192.168.1.10:3000/' }), 'http://192.168.1.10:3000')
  assert.equal(resolveApiBaseUrl('develop', { apiBaseUrl: '  ' }), DEVELOP_API_BASE_URL)
  assert.equal(resolveApiBaseUrl('trial', { apiBaseUrl: 'http://192.168.1.10:3000' }), PRODUCTION_API_BASE_URL)
  assert.equal(resolveApiBaseUrl('release', {}), 'https://tcli.guangqingai.top')
})

test('dev login code is only produced in develop with a valid name', () => {
  assert.equal(devLoginCode('develop', { devLoginName: 'alice' }), 'dev:alice')
  assert.equal(devLoginCode('develop', { devLoginName: ' bob_2 ' }), 'dev:bob_2')
  assert.equal(devLoginCode('develop', {}), null)
  assert.equal(devLoginCode('develop', { devLoginName: 'Alice' }), null)
  assert.equal(devLoginCode('develop', { devLoginName: 'x'.repeat(33) }), null)
  assert.equal(devLoginCode('trial', { devLoginName: 'alice' }), null)
  assert.equal(devLoginCode('release', { devLoginName: 'alice' }), null)
})

test('TTS files are named per entry and old ones evicted', () => {
  assert.equal(ttsFileName('01JABCDEFGHJKMNPQRSTVWXYZ0'), 'tts-01JABCDEFGHJKMNPQRSTVWXYZ0.mp3')
  assert.equal(ttsFileName('../../etc/passwd'), 'tts-etcpasswd.mp3')
  const files = Array.from({ length: TTS_KEEP_FILES + 3 }, (_, i) => ({ name: `tts-${i}.mp3`, modified: i }))
  assert.deepEqual(filesToEvict([...files, { name: 'other.json', modified: -1 }]), ['tts-2.mp3', 'tts-1.mp3', 'tts-0.mp3'])
  assert.deepEqual(filesToEvict(files.slice(0, 3), 5), [])
})

const entry = (id: string, seq: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  seq,
  source: 'cli',
  task: 'translate',
  kind: 'sentence',
  input: `input ${id}`,
  output: `output ${id}`,
  srcLang: 'zh',
  mode: 'simple',
  createdAt: '2026-11-18T14:03:00+08:00',
  correctedInput: null,
  ...overrides,
})

test('history pages append without duplicates', () => {
  const first = appendPage(EMPTY_HISTORY, { entries: [entry('c', 3), entry('b', 2)], nextBefore: 2, hasMore: true })
  assert.deepEqual(first.entries.map((e) => e.id), ['c', 'b'])
  assert.equal(first.nextBefore, 2)
  const second = appendPage(first, { entries: [entry('b', 2), entry('a', 1)], nextBefore: null, hasMore: false })
  assert.deepEqual(second.entries.map((e) => e.id), ['c', 'b', 'a'])
  assert.equal(second.hasMore, false)
  assert.equal(second.nextBefore, null)
})

test('entry times read the recorded wall clock', () => {
  assert.equal(formatEntryTime('2026-11-18T14:03:59+08:00', '2026-11-18', '2026-11-17'), '今天 14:03')
  assert.equal(formatEntryTime('2026-11-17T09:12:00-05:00', '2026-11-18', '2026-11-17'), '昨天 09:12')
  assert.equal(formatEntryTime('2026-03-02T08:30:00Z', '2026-11-18', '2026-11-17'), '3月2日 08:30')
  assert.equal(formatEntryTime('2025-12-31T23:59:00+08:00', '2026-11-18', '2026-11-17'), '2025年12月31日')
  assert.equal(formatEntryTime('garbage', '2026-11-18', '2026-11-17'), '')
  assert.equal(localDateKey(new Date(2026, 0, 5)), '2026-01-05')
})

test('server instants are shown in local time', () => {
  // Built from local dates so the assertion holds in any time zone.
  const now = new Date(2026, 10, 18, 20, 0)
  assert.deepEqual(dayKeys(new Date(2026, 0, 1, 9)), { today: '2026-01-01', yesterday: '2025-12-31' })
  assert.equal(formatInstant(new Date(2026, 10, 18, 14, 3).toISOString(), now), '今天 14:03')
  assert.equal(formatInstant(new Date(2026, 10, 17, 23, 59).toISOString(), now), '昨天 23:59')
  assert.equal(formatInstant(new Date(2026, 1, 3, 7, 5).toISOString(), now), '2月3日 07:05')
  assert.equal(formatInstant('not a date', now), '')
})

test('history rows label source and task and preview the first line', () => {
  const row = toHistoryRow(
    entry('x', 1, { source: 'mp', task: 'check', output: '\n**Fixed sentence.**\n\n分析' }),
    '2026-11-18',
    '2026-11-17',
  )
  assert.equal(row.sourceLabel, '小程序')
  assert.equal(row.taskLabel, '纠错')
  assert.equal(row.preview, 'Fixed sentence.')
  assert.equal(row.time, '今天 14:03')
})

test('history pages are validated, from the API or the offline cache', () => {
  assert.equal(readHistoryPage(''), null)
  assert.equal(readHistoryPage({ entries: 'nope' }), null)
  const page = readHistoryPage({
    entries: [entry('a', 2), { id: 3 }, { ...entry('b', 1), seq: '1' }],
    nextBefore: 2,
    hasMore: true,
  })
  assert.deepEqual(page?.entries.map((e) => e.id), ['a'])
  assert.equal(page?.hasMore, true)
  const last = readHistoryPage({ entries: [], nextBefore: null, hasMore: false })
  assert.deepEqual(last, { entries: [], nextBefore: null, hasMore: false })
})
