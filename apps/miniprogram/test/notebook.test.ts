import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_STARS,
  EMPTY_NOTEBOOK,
  EMPTY_NOTEBOOK_FILTER,
  advanceCursor,
  appendNotesPage,
  applyNoteChanges,
  canSavePhrase,
  chipKind,
  chipStars,
  collocationRows,
  emptyNotebookText,
  findNote,
  findSaved,
  formatIpa,
  highlightSentence,
  indexNotes,
  inflectionsOf,
  kindTabs,
  lemmaKey,
  lexiconSpeechKey,
  matchesNotebookFilter,
  myRecordView,
  notesQuery,
  phraseNoteInput,
  removeNote,
  replaceNote,
  sameNotebookFilter,
  savedStars,
  starChips,
  starsInput,
  summaryView,
  toNoteRow,
  toSavedNote,
  withSaved,
  wordNoteInput,
  wordPageUrl,
  wordView,
  type NotebookList,
  type UnitRecord,
} from '../miniprogram/lib/notebook.ts'
import { readNote, readNotesSummary } from '../miniprogram/lib/wire.ts'
import type { LookupResult, Note, NotesSummary } from '../miniprogram/lib/types.ts'

const note = (id: string, extra: Partial<Note> = {}): Note => ({
  id,
  kind: 'word',
  text: 'concise',
  translation: 'adj. 简洁的',
  lang: 'en',
  stars: 1,
  lemma: 'concise',
  entryId: null,
  itemId: `item-${id}`,
  seq: 1,
  createdAt: '2026-11-24T01:00:00.000Z',
  updatedAt: '2026-11-24T01:00:00.000Z',
  deletedAt: null,
  ...extra,
})

const summary: NotesSummary = {
  total: 182,
  thisWeek: 21,
  kinds: { word: 126, phrase: 33, sentence: 23 },
  levels: { new: 40, learning: 92, mastered: 0 },
}

const lookup: LookupResult = {
  lemma: 'decision',
  lang: 'en',
  entry: {
    lemma: 'decision',
    ipa: { us: '/dɪˈsɪʒən/', uk: 'dɪˈsɪʒn' },
    senses: [
      { pos: 'n.', gloss: '决定；决策', def: 'a choice that you make' },
      { pos: 'n.', gloss: '果断', def: 'the ability to decide quickly' },
    ],
    forms: [{ label: '复数', form: 'decisions' }],
    collocations: [
      { text: 'make a decision', gloss: '做出决定' },
      { text: 'a decision that has to be taken by everyone on the team before the end of the quarter', gloss: '很长' },
    ],
    examples: [
      { text: 'It was a hard decision.', gloss: '这是个艰难的决定。' },
      { text: 'We need a decision today.', gloss: '我们今天需要一个决定。' },
    ],
    contrasts: [{ word: 'choice', note: '强调可选项' }],
    memory: 'de- + cis（切）',
  },
  context: { meaning: '决定（公司做出的正式决定）', phrase: { text: 'key decisions', gloss: '关键决策' } },
  cached: true,
}

test('chips: kind and stars from tap data', () => {
  assert.equal(chipKind('phrase'), 'phrase')
  assert.equal(chipKind(''), null)
  assert.equal(chipKind('grammar'), null)
  assert.equal(chipStars('4'), 4)
  assert.equal(chipStars(2), 2)
  assert.equal(chipStars('0'), null)
  assert.equal(chipStars('5'), null)
  assert.equal(chipStars(''), null)
})

test('kindTabs carry the summary counts once known', () => {
  assert.deepEqual(
    kindTabs(summary, 'word').map((tab) => [tab.value, tab.label, tab.selected]),
    [
      ['', '全部 182', false],
      ['word', '单词 126', true],
      ['phrase', '词组 33', false],
      ['sentence', '句子 23', false],
    ],
  )
  assert.deepEqual(
    kindTabs(null, null).map((tab) => tab.label),
    ['全部', '单词', '词组', '句子'],
  )
})

test('starChips: 全部 then 4…1, one selected', () => {
  const chips = starChips(3)
  assert.deepEqual(
    chips.map((chip) => [chip.value, chip.label, chip.star, chip.selected]),
    [
      ['', '全部', false, false],
      ['4', '4', true, false],
      ['3', '3', true, true],
      ['2', '2', true, false],
      ['1', '1', true, false],
    ],
  )
  assert.equal(starChips(null)[0]?.selected, true)
  assert.equal(chips[1]?.aria, '只看 4 星')
})

test('notesQuery and filter matching', () => {
  assert.deepEqual(notesQuery(EMPTY_NOTEBOOK_FILTER, null), {})
  assert.deepEqual(notesQuery({ kind: 'sentence', stars: 4 }, 'X', 30), { kind: 'sentence', stars: 4, before: 'X', limit: 30 })
  assert.equal(matchesNotebookFilter(note('A'), { kind: 'word', stars: 1 }), true)
  assert.equal(matchesNotebookFilter(note('A'), { kind: 'phrase', stars: null }), false)
  assert.equal(matchesNotebookFilter(note('A', { stars: 2 }), { kind: null, stars: 1 }), false)
  assert.equal(matchesNotebookFilter(note('A', { deletedAt: '2026-11-24T02:00:00Z' }), EMPTY_NOTEBOOK_FILTER), false)
  assert.equal(sameNotebookFilter({ kind: 'word', stars: null }, { kind: 'word', stars: null }), true)
  assert.equal(sameNotebookFilter({ kind: 'word', stars: null }, { kind: 'word', stars: 1 }), false)
  assert.equal(emptyNotebookText({ kind: 'phrase', stars: 4 }), '没有 4 星的词组')
  assert.equal(emptyNotebookText({ kind: null, stars: 2 }), '没有 2 星的笔记')
})

test('appendNotesPage: newest first, no duplicates, paging cursor', () => {
  const first = appendNotesPage(EMPTY_NOTEBOOK, { notes: [note('C'), note('B')], nextBefore: 'B', hasMore: true })
  assert.deepEqual(first.notes.map((n) => n.id), ['C', 'B'])
  assert.equal(first.nextBefore, 'B')
  assert.equal(first.hasMore, true)
  const second = appendNotesPage(first, { notes: [note('B'), note('A')], nextBefore: null, hasMore: false })
  assert.deepEqual(second.notes.map((n) => n.id), ['C', 'B', 'A'])
  assert.equal(second.hasMore, false)
  assert.equal(second.nextBefore, null)
})

test('advanceCursor keeps the highest seq seen', () => {
  assert.equal(advanceCursor(0, []), 0)
  assert.equal(advanceCursor(5, [note('A', { seq: 3 }), note('B', { seq: 9 })]), 9)
  assert.equal(advanceCursor(12, [note('A', { seq: 3 })]), 12)
})

test('applyNoteChanges: replace, remove deleted, drop non-matching, insert new, skip unloaded', () => {
  const list: NotebookList = {
    notes: [note('E', { stars: 2 }), note('C', { stars: 2 }), note('B', { stars: 2 })],
    nextBefore: 'B',
    hasMore: true,
  }
  const filter = { kind: null, stars: 2 } as const
  const next = applyNoteChanges(
    list,
    [
      note('F', { stars: 2, seq: 10 }), // new, newest → inserted first
      note('E', { stars: 3, seq: 11 }), // no longer 2 stars → leaves
      note('C', { stars: 2, translation: '改了', seq: 12 }), // replaced
      note('B', { stars: 2, deletedAt: '2026-11-24T03:00:00Z', seq: 13 }), // deleted → leaves
      note('A', { stars: 2, seq: 14 }), // older than the loaded pages → comes with paging
      note('D', { stars: 2, seq: 15 }), // inside the loaded range → inserted in order
    ],
    filter,
  )
  assert.deepEqual(next.notes.map((n) => n.id), ['F', 'D', 'C'])
  assert.equal(findNote(next, 'C')?.translation, '改了')
  assert.equal(next.nextBefore, 'B')
  // Everything loaded: an old note that now matches is inserted too.
  const all = applyNoteChanges({ ...list, hasMore: false, nextBefore: null }, [note('A', { stars: 2 })], filter)
  assert.deepEqual(all.notes.map((n) => n.id), ['E', 'C', 'B', 'A'])
})

test('replaceNote and removeNote are local edits', () => {
  const list = appendNotesPage(EMPTY_NOTEBOOK, { notes: [note('B'), note('A')], nextBefore: null, hasMore: false })
  const starred = replaceNote(list, note('B', { stars: 4 }))
  assert.equal(findNote(starred, 'B')?.stars, 4)
  assert.equal(findNote(list, 'B')?.stars, 1)
  assert.deepEqual(removeNote(list, 'B').notes.map((n) => n.id), ['A'])
  assert.equal(findNote(list, 'Z'), null)
})

test('toNoteRow: clamps, labels, level tag, 纠错 tag, stars column', () => {
  const word = toNoteRow(note('A', { stars: 3, level: 'learning' }), '')
  assert.equal(word.lines, 1)
  assert.equal(word.kindLabel, '单词')
  assert.equal(word.levelLabel, '学习中')
  assert.equal(word.opensWord, true)
  assert.deepEqual(word.marks.map((mark) => mark.filled), [true, true, true, false])
  assert.equal(word.aria, 'concise，单词，学习中，3 星')

  const sentence = note('B', { kind: 'sentence', text: 'I finished it.', translation: null, task: 'check' })
  const row = toNoteRow(sentence, '')
  assert.equal(row.lines, 2)
  assert.equal(row.kindLabel, '句子 · 纠错')
  assert.equal(row.gloss, '')
  assert.equal(row.level, '')
  assert.equal(row.levelLabel, '')
  assert.equal(toNoteRow(sentence, 'B').lines, 0)
  assert.equal(toNoteRow(sentence, 'B').expanded, true)
  assert.equal(toNoteRow({ ...sentence, task: 'translate' }, '').kindLabel, '句子')
  // A word never expands; it opens 单词详情.
  assert.equal(toNoteRow(note('A'), 'A').expanded, false)
  assert.equal(toNoteRow(note('C', { kind: 'phrase', text: 'focus on' }), '').lines, 1)
  assert.equal(toNoteRow(note('D', { kind: 'sentence', text: '这个方案风险很高' }), '').serif, false)
})

test('readNote keeps level and task when the server sends them', () => {
  const wire = { ...note('01JD0000000000000000000000'), level: 'mastered', task: 'check' }
  assert.equal(readNote(wire)?.level, 'mastered')
  assert.equal(readNote(wire)?.task, 'check')
  const older = readNote({ ...wire, level: null, task: 'weird' })
  assert.equal(older?.level, undefined)
  assert.equal(older?.task, undefined)
  assert.equal(toNoteRow(older as Note, '').levelLabel, '')
})

test('readNotesSummary validates every count', () => {
  assert.deepEqual(readNotesSummary(summary), summary)
  assert.equal(readNotesSummary({ ...summary, total: -1 }), null)
  assert.equal(readNotesSummary({ ...summary, kinds: { word: 1, phrase: 2 } }), null)
  assert.equal(readNotesSummary({ ...summary, levels: null }), null)
  assert.equal(readNotesSummary(null), null)
})

test('summaryView: caption, bar without empty levels, full legend', () => {
  const view = summaryView(summary)
  assert.equal(view.total, 182)
  assert.equal(view.caption, '条笔记 · 本周 +21')
  assert.deepEqual(view.bar.map((s) => [s.key, s.count]), [
    ['new', 40],
    ['learning', 92],
  ])
  assert.deepEqual(view.legend.map((s) => s.label), ['新加', '学习中', '已掌握'])
  assert.equal(view.barAria, '新加 40，学习中 92，已掌握 0')
  assert.deepEqual(summaryView({ ...summary, levels: { new: 0, learning: 0, mastered: 0 } }).bar, [])
})

test('wordPageUrl encodes the lemma and optional sentence and record', () => {
  assert.equal(wordPageUrl('look forward to'), '/pages/word/index?lemma=look%20forward%20to')
  assert.equal(
    wordPageUrl('decision', { sentence: 'A & B?', entryId: '01J' }),
    '/pages/word/index?lemma=decision&sentence=A%20%26%20B%3F&entryId=01J',
  )
  assert.equal(wordPageUrl('x', { sentence: '', entryId: '' }), '/pages/word/index?lemma=x')
})

test('lemmaKey matches the server: quotes straightened, spaces collapsed, lowercased', () => {
  assert.equal(lemmaKey('  Don’t   Worry '), "don't worry")
  assert.equal(lemmaKey('“Quoted”'), '"quoted"')
})

test('saved index: word by lemma, phrase and sentence by text, deleted kept for revival, live wins', () => {
  const word = note('W1', { text: 'Decision', lemma: 'decision', stars: 3, seq: 1 })
  const phrase = note('P1', { kind: 'phrase', text: 'make a decision', lemma: null, stars: 2, seq: 2 })
  const sentence = note('S1', { kind: 'sentence', text: 'A sentence.', seq: 3 })
  let index = indexNotes({}, [word, phrase, sentence])
  assert.equal(savedStars(index, 'word', 'DECISION'), 3)
  assert.equal(savedStars(index, 'phrase', 'Make  a decision'), 2)
  assert.equal(savedStars(index, 'phrase', 'decision'), 0)
  // Sentences are indexed too, so the 翻译 page never saves the same sentence twice.
  assert.equal(findSaved(index, 'sentence', 'A  sentence.')?.id, 'S1')
  assert.equal(Object.keys(index).length, 3)

  index = indexNotes(index, [{ ...phrase, deletedAt: '2026-11-24T05:00:00Z', seq: 4 }])
  assert.equal(savedStars(index, 'phrase', 'make a decision'), 0)
  assert.equal(findSaved(index, 'phrase', 'make a decision')?.id, 'P1')

  // A second id for the same word deleted later never hides the live one.
  index = indexNotes(index, [note('W2', { text: 'decision', lemma: 'decision', deletedAt: '2026-11-24T06:00:00Z', seq: 5 })])
  assert.equal(findSaved(index, 'word', 'decision')?.id, 'W1')

  const revived = withSaved(index, { ...toSavedNote(phrase), stars: 4 })
  assert.equal(savedStars(revived, 'phrase', 'make a decision'), 4)
  assert.equal(savedStars(index, 'phrase', 'make a decision'), 0)
})

test('note bodies: word with lemma, translation and record; phrase; stars change', () => {
  assert.deepEqual(wordNoteInput(lookup, DEFAULT_STARS, '01JREC'), {
    kind: 'word',
    text: 'decision',
    lang: 'en',
    stars: 1,
    lemma: 'decision',
    translation: 'n. 决定；决策',
    entryId: '01JREC',
  })
  assert.equal('entryId' in wordNoteInput(lookup, 2, ''), false)
  assert.deepEqual(phraseNoteInput('make a decision', '做出决定', 1), {
    kind: 'phrase',
    text: 'make a decision',
    lang: 'en',
    stars: 1,
    translation: '做出决定',
  })
  assert.equal('translation' in phraseNoteInput('x y', '', 1), false)
  const saved = toSavedNote(note('W1', { text: 'decision', stars: 1 }))
  assert.deepEqual(starsInput(saved, 4), { kind: 'word', text: 'decision', lang: 'en', stars: 4 })
})

test('canSavePhrase: 1–64 code points with a Latin letter', () => {
  assert.equal(canSavePhrase('make a decision'), true)
  assert.equal(canSavePhrase('a'.repeat(64)), true)
  assert.equal(canSavePhrase('a'.repeat(65)), false)
  assert.equal(canSavePhrase('做决定'), false)
  assert.equal(canSavePhrase('  '), false)
})

test('formatIpa: exactly one pair of slashes', () => {
  assert.equal(formatIpa('/kənˈsaɪs/'), '/kənˈsaɪs/')
  assert.equal(formatIpa('kənˈsaɪs'), '/kənˈsaɪs/')
  assert.equal(formatIpa('//kənˈsaɪs//'), '/kənˈsaɪs/')
  assert.equal(formatIpa('  '), '')
})

test('inflectionsOf covers regular forms', () => {
  assert.ok(inflectionsOf('decide').includes('decided'))
  assert.ok(inflectionsOf('decide').includes('deciding'))
  assert.ok(inflectionsOf('study').includes('studies'))
  assert.ok(inflectionsOf('stop').includes('stopped'))
  assert.ok(inflectionsOf('decision').includes('decisions'))
  assert.deepEqual(inflectionsOf('look forward to'), ['look forward to'])
})

test('highlightSentence marks the first whole-word occurrence', () => {
  const parts = highlightSentence('Please focus on the key decisions today.', ['decision'])
  assert.deepEqual(
    parts.map((p) => [p.text, p.hit]),
    [
      ['Please focus on the key ', false],
      ['decisions', true],
      [' today.', false],
    ],
  )
  // Irregular forms come from the entry; matching is case-insensitive and whole-word.
  assert.deepEqual(
    highlightSentence('Wentworth went home.', ['go', 'went']).map((p) => [p.text, p.hit]),
    [
      ['Wentworth ', false],
      ['went', true],
      [' home.', false],
    ],
  )
  assert.deepEqual(
    highlightSentence('I look forward to it.', ['look forward to']).map((p) => p.hit),
    [false, true, false],
  )
  assert.deepEqual(highlightSentence('Nothing here.', ['decision']), [{ key: '0', text: 'Nothing here.', hit: false }])
  assert.deepEqual(highlightSentence('', ['x']), [])
})

test('wordView: IPA, keyed sections, example indexes, 在本句中', () => {
  const view = wordView(lookup, 'Focus on the key decisions.', 'decisions')
  assert.equal(view.ipaUs, '/dɪˈsɪʒən/')
  assert.equal(view.ipaUk, '/dɪˈsɪʒn/')
  assert.deepEqual(view.senses.map((s) => s.key), ['0', '1'])
  assert.deepEqual(view.examples.map((e) => e.index), [0, 1])
  assert.equal(view.memory, 'de- + cis（切）')
  assert.equal(view.context?.meaning, '决定（公司做出的正式决定）')
  assert.deepEqual(view.context?.phrase, { text: 'key decisions', gloss: '关键决策' })
  assert.deepEqual(
    view.context?.segments.filter((s) => s.hit).map((s) => s.text),
    ['decisions'],
  )
  assert.equal(wordView({ ...lookup, context: null }, 'Focus.', 'x').context, null)
  assert.equal(wordView(lookup, '', 'x').context, null)
})

test('collocationRows: saved stars, savable, labels', () => {
  const index = indexNotes({}, [note('P1', { kind: 'phrase', text: 'make a decision', stars: 2 })])
  const rows = collocationRows(lookup, index)
  assert.deepEqual(
    rows.map((row) => [row.text.slice(0, 15), row.stars, row.savable]),
    [
      ['make a decision', 2, true],
      ['a decision that', 0, false],
    ],
  )
  assert.equal(rows[0]?.aria, '取消收藏 make a decision')
})

test('myRecordView: lookups, review status and due wording', () => {
  const now = Date.parse('2026-11-24T04:00:00Z')
  const day = (iso: string): string => `D(${iso.slice(0, 10)})`
  const due = (iso: string): string => `due(${iso.slice(0, 10)})`
  const unit = (extra: Partial<UnitRecord> = {}): UnitRecord => ({
    lookupCount: 3,
    firstSeenAt: '2026-11-18T02:00:00Z',
    level: 'learning',
    cards: [
      { state: 'review', due: '2026-12-10T00:00:00Z', mastered: false, suspended: false },
      { state: 'review', due: '2026-12-01T00:00:00Z', mastered: false, suspended: false },
      { state: 'review', due: '2026-11-25T00:00:00Z', mastered: false, suspended: true },
    ],
    ...extra,
  })
  assert.deepEqual(myRecordView(unit(), true, now, day, due), {
    lookups: '查过 3 次 · 第一次是 D(2026-11-18)',
    review: '复习卡片：学习中 · 下次 due(2026-12-01)',
  })
  assert.equal(
    myRecordView(unit({ cards: [{ state: 'review', due: '2026-11-20T00:00:00Z', mastered: false, suspended: false }] }), true, now, day, due)
      .review,
    '复习卡片：学习中 · 待复习',
  )
  assert.equal(myRecordView(unit({ level: 'mastered' }), true, now, day, due).review, '复习卡片：已掌握')
  assert.equal(myRecordView(unit({ level: 'new' }), true, now, day, due).review, '复习卡片：还没开始复习')
  assert.equal(myRecordView(unit({ cards: [] }), false, now, day, due).review, '还没有复习卡片')
  assert.equal(myRecordView(unit({ lookupCount: 0 }), false, now, day, due).lookups, '')
  assert.deepEqual(myRecordView(null, false, now, day, due), { lookups: '', review: '还没有复习卡片' })
  assert.equal(myRecordView(null, true, now, day, due).review, '复习卡片稍后生成')
})

test('lexiconSpeechKey: a file-safe key per lemma and part', () => {
  assert.equal(lexiconSpeechKey('Decision', 'us'), 'lex-decision-us')
  assert.equal(lexiconSpeechKey('look forward to', 'uk'), 'lex-look_forward_to-uk')
  assert.equal(lexiconSpeechKey("don\u2019t", 1), 'lex-don_t-ex1')
})
