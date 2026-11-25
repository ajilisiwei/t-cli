import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PART_OPTIONS,
  WEEKDAY_OPTIONS,
  activeMuted,
  chipsOf,
  frequencyHint,
  levelHint,
  mutedRows,
  togglePart,
  toggleTopic,
  unmute,
} from '../miniprogram/lib/learn-plan.ts'

test('weekdays read Monday first; the values are the setting (0 = Sunday)', () => {
  assert.deepEqual(
    WEEKDAY_OPTIONS.map((option) => option.id),
    [1, 2, 3, 4, 5, 6, 0],
  )
  assert.equal(WEEKDAY_OPTIONS[6]?.aria, '星期日')
})

test('togglePart keeps at least one part and the canonical order', () => {
  assert.deepEqual(togglePart(['words', 'story'], 'phrases'), ['words', 'phrases', 'story'])
  assert.deepEqual(togglePart(['words', 'story'], 'words'), ['story'])
  assert.equal(togglePart(['story'], 'story'), null)
  assert.deepEqual(
    chipsOf(PART_OPTIONS, (id) => id === 'story').map((chip) => chip.on),
    [false, false, false, true, false],
  )
})

test('toggleTopic adds and removes in the canonical order', () => {
  assert.deepEqual(toggleTopic(['tech'], 'work'), ['work', 'tech'])
  assert.deepEqual(toggleTopic(['work', 'tech'], 'work'), ['tech'])
})

test('muted topics: only those still in force; restore removes one', () => {
  const muted = [
    { topic: 'finance' as const, until: '2026-12-25' },
    { topic: 'travel' as const, until: '2026-11-25' },
  ]
  assert.deepEqual(activeMuted(muted, '2026-11-25'), [muted[0]])
  assert.deepEqual(mutedRows(muted, '2026-11-25'), [{ topic: 'finance', label: '财经 · 12月25日起恢复' }])
  assert.deepEqual(unmute(muted, 'finance'), [muted[1]])
})

test('levelHint: chosen level, or the effective one with its evidence', () => {
  assert.equal(levelHint('B2', null), 'B2：较正式的书面语和抽象话题。')
  assert.equal(levelHint('auto', null), '按最近 30 天的记住率自动定难度，默认 B1。')
  assert.equal(
    levelHint('auto', { setting: 'auto', effective: 'B1', retention30: 0.823, reviews30: 412 }),
    '当前按 B1 出题：最近 30 天的记住率是 82%（复习 412 次）。记住率高了会自动提一档。',
  )
  assert.match(levelHint('auto', { setting: 'auto', effective: 'B1', retention30: null, reviews30: 0 }), /^当前按 B1 出题。/)
  assert.match(frequencyHint('weekly'), /每周一份合集/)
})
