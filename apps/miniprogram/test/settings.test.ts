import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SETTING_DEFAULTS,
  applyLocalChange,
  effectiveSettings,
  hasPending,
  keepsPending,
  mergeAccount,
  settlePushed,
  type LocalSettings,
} from '../miniprogram/lib/settings.ts'
import type { Settings } from '../miniprogram/lib/types.ts'

const EMPTY: LocalSettings = { settings: {}, pending: {} }

test('defaults follow docs/api-v1.md (v2 → Settings)', () => {
  assert.deepEqual(effectiveSettings({}), {
    explanationLang: 'zh',
    autoSpeakWord: true,
    autoSpeakOnFlip: true,
    reminderHour: null,
    showDirection: false,
    accent: 'indigo',
    themeMode: 'system',
    themeFixed: 'light',
    themeDayStart: '07:00',
    themeNightStart: '19:00',
    readingMode: false,
    readingFontStep: 0,
    importanceReview: true,
  })
  assert.deepEqual(effectiveSettings({}), SETTING_DEFAULTS)
})

test('effectiveSettings keeps valid values and replaces malformed ones with the default', () => {
  const s = effectiveSettings({
    explanationLang: 'en',
    accent: 'plum',
    themeMode: 'time',
    themeFixed: 'dark',
    themeDayStart: '06:30',
    themeNightStart: '21:15',
    readingMode: true,
    readingFontStep: 3,
    importanceReview: false,
    showDirection: true,
    reminderHour: 0,
  })
  assert.equal(s.explanationLang, 'en')
  assert.equal(s.accent, 'plum')
  assert.equal(s.themeMode, 'time')
  assert.equal(s.themeFixed, 'dark')
  assert.equal(s.themeDayStart, '06:30')
  assert.equal(s.themeNightStart, '21:15')
  assert.equal(s.readingMode, true)
  assert.equal(s.readingFontStep, 3)
  assert.equal(s.importanceReview, false)
  assert.equal(s.showDirection, true)
  assert.equal(s.reminderHour, 0)

  // Values from an older cache or a bad write.
  const bad = { accent: 'neon', themeMode: 'auto', themeDayStart: '7:00', readingFontStep: 4, reminderHour: 24 }
  const fixed = effectiveSettings(bad as unknown as Settings)
  assert.equal(fixed.accent, 'indigo')
  assert.equal(fixed.themeMode, 'system')
  assert.equal(fixed.themeDayStart, '07:00')
  assert.equal(fixed.readingFontStep, 0)
  assert.equal(fixed.reminderHour, null)
  assert.equal(effectiveSettings({ reminderHour: null }).reminderHour, null)
})

test('a local change is in force at once and queued', () => {
  const local = applyLocalChange({ settings: { explanationLang: 'en' }, pending: {} }, { accent: 'pine' })
  assert.deepEqual(local.settings, { explanationLang: 'en', accent: 'pine' })
  assert.deepEqual(local.pending, { accent: 'pine' })
  assert.ok(hasPending(local.pending))
  assert.ok(!hasPending({}))

  const again = applyLocalChange(local, { accent: 'ochre', readingMode: true })
  assert.deepEqual(again.pending, { accent: 'ochre', readingMode: true })
  // Inputs are not modified.
  assert.deepEqual(local.pending, { accent: 'pine' })
})

test('reminderHour null is a change like any other', () => {
  const local = applyLocalChange({ settings: { reminderHour: 8 }, pending: {} }, { reminderHour: null })
  assert.deepEqual(local.pending, { reminderHour: null })
  assert.equal(local.settings.reminderHour, null)
})

test('after a push, the keys still holding the sent value leave the queue; newer changes stay', () => {
  const sent: Settings = { accent: 'pine', readingMode: true }
  // Changed again while the request was in flight.
  const pending: Settings = { accent: 'plum', readingMode: true, themeMode: 'fixed' }
  assert.deepEqual(settlePushed(pending, sent), { accent: 'plum', themeMode: 'fixed' })
  assert.deepEqual(settlePushed(sent, sent), {})
  assert.deepEqual(settlePushed({ reminderHour: null }, { reminderHour: null }), {})
})

test('the account arrives: pending keys keep the local value, others take the account’s', () => {
  const local: LocalSettings = {
    settings: { accent: 'pine', explanationLang: 'zh', readingMode: true },
    pending: { accent: 'pine' },
  }
  const account: Settings = { accent: 'ochre', explanationLang: 'en', readingMode: false }
  assert.deepEqual(mergeAccount(local, account), { accent: 'pine', explanationLang: 'en', readingMode: false })
})

test('keys the account lacks keep the local value (absent = the server default, never an override)', () => {
  const local: LocalSettings = { settings: { themeMode: 'time', accent: 'ink' }, pending: {} }
  assert.deepEqual(mergeAccount(local, { explanationLang: 'en' }), {
    themeMode: 'time',
    accent: 'ink',
    explanationLang: 'en',
  })
  assert.deepEqual(mergeAccount(EMPTY, {}), {})
})

test('a failed push keeps the queue unless the body was rejected', () => {
  assert.ok(keepsPending({ kind: 'network', status: null }))
  assert.ok(keepsPending({ kind: 'timeout', status: null }))
  assert.ok(keepsPending({ kind: 'auth', status: 401 }))
  assert.ok(keepsPending({ kind: 'http', status: 500 }))
  assert.ok(keepsPending({ kind: 'http', status: 429 }))
  assert.ok(!keepsPending({ kind: 'http', status: 400 }))
  assert.ok(!keepsPending({ kind: 'http', status: 422 }))
})

test('scenario: offline change, launch with another client’s change, push, pull', () => {
  // Offline on the phone: 主题色 → 松绿; the push fails and the change stays pending.
  let local = applyLocalChange(EMPTY, { accent: 'pine' })
  assert.ok(keepsPending({ kind: 'network', status: null }))

  // Meanwhile the CLI set the explanation language to English and the account still has indigo.
  const account: Settings = { explanationLang: 'en', accent: 'indigo' }

  // Next launch: a pull before the push lands (the push failed again) keeps the local accent.
  local = { settings: mergeAccount(local, account), pending: local.pending }
  assert.deepEqual(effectiveSettings(local.settings).accent, 'pine')
  assert.deepEqual(effectiveSettings(local.settings).explanationLang, 'en')

  // The network returns: the push succeeds and the server answers with the merged settings.
  const sent = local.pending
  const answer: Settings = { ...account, ...sent }
  const pending = settlePushed(local.pending, sent)
  local = { settings: mergeAccount({ settings: local.settings, pending }, answer), pending }
  assert.deepEqual(local.pending, {})
  assert.deepEqual(local.settings, { explanationLang: 'en', accent: 'pine' })

  // Later, another client picks 赭石: with nothing pending, the account wins.
  local = { settings: mergeAccount(local, { ...answer, accent: 'ochre' }), pending: local.pending }
  assert.equal(effectiveSettings(local.settings).accent, 'ochre')
})
