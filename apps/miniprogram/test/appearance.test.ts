import test from 'node:test'
import assert from 'node:assert/strict'
import {
  READING_STEPS,
  clampFontStep,
  clockLabel,
  clockMinutes,
  dayBar,
  fontStepLabel,
  isDaytime,
  msUntilThemeSwitch,
  readingType,
  resolveTheme,
  themeModeSummary,
  type ThemeRule,
} from '../miniprogram/lib/appearance.ts'

const rule = (overrides: Partial<ThemeRule> = {}): ThemeRule => ({
  mode: 'time',
  fixed: 'light',
  dayStart: '07:00',
  nightStart: '19:00',
  ...overrides,
})

/** A local time on 24 Nov 2026. */
const at = (hours: number, minutes = 0, seconds = 0): Date => new Date(2026, 10, 24, hours, minutes, seconds)

const MINUTE = 60_000
const HOUR = 60 * MINUTE

test('clockMinutes / clockLabel', () => {
  assert.equal(clockMinutes('00:00'), 0)
  assert.equal(clockMinutes('07:30'), 450)
  assert.equal(clockMinutes('23:59'), 1439)
  assert.equal(clockMinutes('24:00'), null)
  assert.equal(clockMinutes('7:00'), null)
  assert.equal(clockMinutes(''), null)
  assert.equal(clockLabel('07:00'), '7:00')
  assert.equal(clockLabel('19:05'), '19:05')
  assert.equal(clockLabel('00:30'), '0:30')
  assert.equal(clockLabel('bad'), 'bad')
})

test('isDaytime: [start, end), wrapping past midnight; equal times = light all day', () => {
  assert.ok(isDaytime(420, 420, 1140), 'at the day start')
  assert.ok(!isDaytime(1140, 420, 1140), 'at the night start')
  assert.ok(!isDaytime(0, 420, 1140))
  // Day from 20:00 to 06:00 (a night-shift schedule).
  assert.ok(isDaytime(23 * 60, 20 * 60, 6 * 60))
  assert.ok(isDaytime(60, 20 * 60, 6 * 60))
  assert.ok(!isDaytime(12 * 60, 20 * 60, 6 * 60))
  assert.ok(isDaytime(3 * 60, 600, 600))
})

test('resolveTheme per mode', () => {
  assert.equal(resolveTheme(rule({ mode: 'system' }), 'dark', at(12)), 'dark')
  assert.equal(resolveTheme(rule({ mode: 'system' }), 'light', at(23)), 'light')
  assert.equal(resolveTheme(rule({ mode: 'fixed', fixed: 'dark' }), 'light', at(12)), 'dark')
  assert.equal(resolveTheme(rule({ mode: 'fixed', fixed: 'light' }), 'dark', at(23)), 'light')
  assert.equal(resolveTheme(rule(), 'dark', at(7)), 'light')
  assert.equal(resolveTheme(rule(), 'dark', at(18, 59)), 'light')
  assert.equal(resolveTheme(rule(), 'light', at(19)), 'dark')
  assert.equal(resolveTheme(rule(), 'light', at(6, 59)), 'dark')
  // Malformed times fall back to 07:00 / 19:00.
  assert.equal(resolveTheme(rule({ dayStart: 'x', nightStart: 'y' }), 'light', at(20)), 'dark')
})

test('msUntilThemeSwitch: the next boundary, today or tomorrow', () => {
  assert.equal(msUntilThemeSwitch(rule(), at(6)), HOUR)
  assert.equal(msUntilThemeSwitch(rule(), at(12)), 7 * HOUR)
  assert.equal(msUntilThemeSwitch(rule(), at(19)), 12 * HOUR, 'exactly at a boundary → the next one')
  assert.equal(msUntilThemeSwitch(rule(), at(23, 30)), 7.5 * HOUR)
  assert.equal(msUntilThemeSwitch(rule(), at(18, 59, 30)), 30_000)
  assert.equal(msUntilThemeSwitch(rule({ mode: 'system' }), at(12)), null)
  assert.equal(msUntilThemeSwitch(rule({ mode: 'fixed' }), at(12)), null)
  assert.equal(msUntilThemeSwitch(rule({ dayStart: '08:00', nightStart: '08:00' }), at(12)), null)
})

test('dayBar: light and dark stretches of the day, and where now is', () => {
  const plain = dayBar(rule(), at(12))
  assert.deepEqual(
    plain.segments.map(({ kind }) => kind),
    ['night', 'day', 'night'],
  )
  assert.deepEqual(
    plain.segments.map(({ share }) => share),
    [29.2, 50, 20.8],
  )
  assert.equal(plain.now, 50)

  const wrapped = dayBar(rule({ dayStart: '20:00', nightStart: '06:00' }), at(0))
  assert.deepEqual(
    wrapped.segments.map(({ kind }) => kind),
    ['day', 'night', 'day'],
  )
  assert.equal(wrapped.now, 0)

  assert.deepEqual(dayBar(rule({ dayStart: '00:00', nightStart: '12:00' }), at(6)).segments, [
    { kind: 'day', share: 50 },
    { kind: 'night', share: 50 },
  ])
  assert.deepEqual(dayBar(rule({ dayStart: '09:00', nightStart: '09:00' }), at(6)).segments, [
    { kind: 'day', share: 100 },
  ])
})

test('themeModeSummary: the 深浅模式 row value', () => {
  assert.equal(themeModeSummary(rule({ mode: 'system' })), '跟随系统')
  assert.equal(themeModeSummary(rule()), '跟随时间')
  assert.equal(themeModeSummary(rule({ mode: 'fixed', fixed: 'dark' })), '固定深色')
  assert.equal(themeModeSummary(rule({ mode: 'fixed', fixed: 'light' })), '固定浅色')
})

test('readingType: usual sizes without 阅读模式; with it, every step larger than the last', () => {
  const normal = readingType(false, 3)
  assert.deepEqual(normal, readingType(false, 0))
  let previous = normal
  for (let step = 0; step < READING_STEPS; step += 1) {
    const type = readingType(true, step)
    assert.ok(type.word > previous.word && type.body > previous.body, `step ${step}`)
    assert.ok(type.lineHeight > previous.lineHeight, `step ${step} line height`)
    previous = type
  }
  assert.deepEqual(readingType(true, 9), readingType(true, 3))
  assert.deepEqual(readingType(true, -1), readingType(true, 0))
})

test('font steps clamp to 0–3 and read as 第 n 档', () => {
  assert.equal(clampFontStep(-2), 0)
  assert.equal(clampFontStep(1.4), 1)
  assert.equal(clampFontStep(7), 3)
  assert.equal(clampFontStep(Number.NaN), 0)
  assert.equal(fontStepLabel(1), '字号第 2 档，共 4 档')
})
