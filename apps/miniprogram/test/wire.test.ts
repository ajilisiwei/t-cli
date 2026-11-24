import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readEntryDays,
  readLexiconEntry,
  readLookupResult,
  readNote,
  readNoteChanges,
  readNoteEnvelope,
  readNotesPage,
  readSettings,
  readSpeechParts,
} from '../miniprogram/lib/wire.ts'

const entry = {
  lemma: 'decision',
  ipa: { us: '/dɪˈsɪʒ.ən/', uk: '/dɪˈsɪʒ.ən/' },
  senses: [{ pos: 'n.', gloss: '决定', def: 'A choice you make.' }],
  forms: [{ label: '复数', form: 'decisions' }],
  collocations: [{ text: 'make a decision', gloss: '做决定' }],
  examples: [
    { text: 'A hard decision.', gloss: '艰难的决定。' },
    { text: 'We need a decision.', gloss: '我们需要一个决定。' },
  ],
  contrasts: [{ word: 'choice', note: '强调可选项' }],
  memory: '',
}

const note = {
  id: '01JD0000000000000000000000',
  kind: 'word',
  text: 'decision',
  translation: '决定',
  lang: 'en',
  stars: 2,
  lemma: 'decision',
  entryId: null,
  itemId: '01JD0000000000000000000001',
  seq: 7,
  createdAt: '2026-11-24T08:00:00.000Z',
  updatedAt: '2026-11-24T08:00:00.000Z',
  deletedAt: null,
}

test('readSettings keeps valid v1 and v2 keys and drops the rest', () => {
  const settings = {
    explanationLang: 'en',
    autoSpeakWord: false,
    reminderHour: null,
    showDirection: true,
    accent: 'ochre',
    themeMode: 'time',
    themeFixed: 'dark',
    themeDayStart: '06:30',
    themeNightStart: '21:00',
    readingMode: true,
    readingFontStep: 2,
    importanceReview: false,
  }
  assert.deepEqual(readSettings(settings), settings)
  assert.deepEqual(
    readSettings({ accent: 'red', themeMode: 'auto', themeDayStart: '7:00', readingFontStep: 4, importanceReview: 'no', x: 1 }),
    {},
  )
  assert.deepEqual(readSettings(null), {})
  assert.deepEqual(readSettings([]), {})
})

test('readLookupResult: entry, context and cached; malformed list items are dropped', () => {
  const result = readLookupResult({
    lemma: 'decision',
    lang: 'en',
    entry: { ...entry, forms: [{ label: '复数', form: 'decisions' }, { label: 1 }, 'x'], examTags: ['CET4'] },
    context: { meaning: '决定', phrase: { text: 'make a decision', gloss: '做决定' } },
    cached: true,
  })
  assert.ok(result)
  assert.equal(result.lemma, 'decision')
  assert.equal(result.cached, true)
  assert.deepEqual(result.entry.forms, [{ label: '复数', form: 'decisions' }])
  assert.deepEqual(result.context, { meaning: '决定', phrase: { text: 'make a decision', gloss: '做决定' } })
  assert.equal('examTags' in result.entry, false)

  const bare = readLookupResult({ entry, context: null })
  assert.equal(bare?.lemma, 'decision', 'lemma falls back to the entry')
  assert.equal(bare?.context, null)
  assert.equal(bare?.cached, false)
  assert.deepEqual(readLookupResult({ entry, context: { meaning: '决定', phrase: null } })?.context, { meaning: '决定', phrase: null })
})

test('readLookupResult / readLexiconEntry: null without a lemma or senses', () => {
  assert.equal(readLookupResult(null), null)
  assert.equal(readLookupResult({ entry: { ...entry, senses: [] } }), null)
  assert.equal(readLexiconEntry({ ...entry, lemma: '' }), null)
  assert.equal(readLexiconEntry('decision'), null)
  const loose = readLexiconEntry({ lemma: 'x', senses: [{ pos: 'n.', gloss: 'g', def: 'd' }] })
  assert.deepEqual(loose, {
    lemma: 'x',
    ipa: { us: '', uk: '' },
    senses: [{ pos: 'n.', gloss: 'g', def: 'd' }],
    forms: [],
    collocations: [],
    examples: [],
    contrasts: [],
    memory: '',
  })
})

test('readNote: required id, kind, text, stars 1–4 and seq', () => {
  assert.deepEqual(readNote(note), note)
  assert.deepEqual(readNoteEnvelope({ note }), note)
  assert.equal(readNote({ ...note, stars: 0 }), null)
  assert.equal(readNote({ ...note, stars: 5 }), null)
  assert.equal(readNote({ ...note, kind: 'grammar' }), null)
  assert.equal(readNote({ ...note, seq: -1 }), null)
  assert.equal(readNote({ ...note, id: 1 }), null)
  assert.equal(readNoteEnvelope(note), null)
  const deleted = readNote({ ...note, translation: '', deletedAt: '2026-11-25T00:00:00.000Z' })
  assert.equal(deleted?.translation, null)
  assert.equal(deleted?.deletedAt, '2026-11-25T00:00:00.000Z')
})

test('readNotesPage and readNoteChanges', () => {
  const page = readNotesPage({ notes: [note, { bad: true }], nextBefore: note.id, hasMore: true })
  assert.equal(page?.notes.length, 1)
  assert.equal(page?.nextBefore, note.id)
  assert.equal(page?.hasMore, true)
  assert.deepEqual(readNotesPage({ notes: [], nextBefore: null, hasMore: true }), { notes: [], nextBefore: null, hasMore: false })
  assert.equal(readNotesPage({ nextBefore: null }), null)

  assert.deepEqual(readNoteChanges({ notes: [note], nextAfter: 7, hasMore: false }), { notes: [note], nextAfter: 7, hasMore: false })
  assert.equal(readNoteChanges({ notes: [note] }), null)
  assert.equal(readNoteChanges({ notes: 'x', nextAfter: 1 }), null)
})

test('readEntryDays keeps well-formed days only', () => {
  assert.deepEqual(
    readEntryDays({
      days: [
        { date: '2026-11-23', count: 3 },
        { date: '2026-11-24', count: 0 },
        { date: '24/11', count: 1 },
        { date: '2026-11-25', count: 1.5 },
        null,
      ],
    }),
    [{ date: '2026-11-23', count: 3 }],
  )
  assert.equal(readEntryDays({}), null)
  assert.equal(readEntryDays(null), null)
})

test('readSpeechParts: header names in any case; absent or inconsistent → null', () => {
  assert.deepEqual(readSpeechParts({ 'X-Speech-Part': '1', 'X-Speech-Parts': '3' }), { part: 1, parts: 3 })
  assert.deepEqual(readSpeechParts({ 'x-speech-part': 0, 'x-speech-parts': 1 }), { part: 0, parts: 1 })
  assert.equal(readSpeechParts({ 'X-Speech-Part': '3', 'X-Speech-Parts': '3' }), null)
  assert.equal(readSpeechParts({ 'X-Speech-Parts': '2' }), null)
  assert.equal(readSpeechParts({ 'X-Speech-Part': '-1', 'X-Speech-Parts': '2' }), null)
  assert.equal(readSpeechParts(undefined), null)
})
