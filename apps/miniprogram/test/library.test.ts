import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_FILTER,
  EMPTY_LIBRARY,
  LIBRARY_PAGE_SIZE,
  MAX_QUERY_CODE_POINTS,
  appendItems,
  chipLevel,
  chipType,
  emptyLibraryText,
  itemsQuery,
  normalizeQuery,
  readItemsPage,
  sameFilter,
  toLibraryRow,
  type ItemSummary,
} from '../miniprogram/lib/library.ts'
import {
  formatDue,
  itemMeta,
  posLabel,
  readCardState,
  readItemDetail,
  statusNotice,
  toCardRow,
  toExercises,
  toSourceRows,
  toggleExercise,
  type ItemCard,
} from '../miniprogram/lib/item.ts'

const summary = (id: string, extra: Partial<ItemSummary> = {}): ItemSummary => ({
  id,
  type: 'word',
  display: id,
  lookupCount: 1,
  errorCount: 0,
  level: 'new',
  lastSeenAt: '2026-11-18T06:00:00.000Z',
  ...extra,
})

test('normalizeQuery trims, collapses whitespace and caps the length', () => {
  assert.equal(normalizeQuery('  look   forward\tto  '), 'look forward to')
  assert.equal(normalizeQuery('   '), '')
  const long = '词'.repeat(MAX_QUERY_CODE_POINTS + 10)
  assert.equal(Array.from(normalizeQuery(long)).length, MAX_QUERY_CODE_POINTS)
  // Code points, not UTF-16 units: an emoji is never cut in half.
  const emoji = '😀'.repeat(MAX_QUERY_CODE_POINTS + 1)
  assert.equal(normalizeQuery(emoji), '😀'.repeat(MAX_QUERY_CODE_POINTS))
})

test('itemsQuery sends only the filters that are set', () => {
  assert.deepEqual(itemsQuery(EMPTY_FILTER, 0), { limit: LIBRARY_PAGE_SIZE })
  assert.deepEqual(itemsQuery({ q: '  meti ', type: 'word', level: 'learning' }, 40, 10), {
    q: 'meti',
    type: 'word',
    level: 'learning',
    offset: 40,
    limit: 10,
  })
  assert.deepEqual(itemsQuery({ q: ' ', type: null, level: 'mastered' }, 0), { level: 'mastered', limit: 20 })
})

test('sameFilter compares the normalized search text', () => {
  assert.equal(sameFilter({ q: ' tear  ', type: null, level: null }, { q: 'tear', type: null, level: null }), true)
  assert.equal(sameFilter({ q: 'tear', type: 'word', level: null }, { q: 'tear', type: null, level: null }), false)
  assert.equal(sameFilter({ q: 'tear', type: null, level: 'new' }, { q: 'tear', type: null, level: null }), false)
})

test('chips map to filter values; 全部 and unknown values clear the filter', () => {
  assert.equal(chipType('phrase'), 'phrase')
  assert.equal(chipType(''), null)
  assert.equal(chipType('sentence'), null)
  assert.equal(chipLevel('mastered'), 'mastered')
  assert.equal(chipLevel(undefined), null)
})

test('readItemsPage validates the page and drops malformed items', () => {
  const page = readItemsPage({
    items: [
      summary('a'),
      { id: 'b', type: 'grammar', display: 'look forward to + doing', level: 'odd', lookupCount: -1, errorCount: 2.7 },
      { id: '', type: 'word', display: 'x' },
      { id: 'c', type: 'sentence', display: 'x' },
      { id: 'd', type: 'word' },
      'junk',
    ],
    nextOffset: 20,
  })
  assert.ok(page !== null)
  assert.deepEqual(
    page.items.map((item) => item.id),
    ['a', 'b'],
  )
  assert.equal(page.items[1]?.level, 'learning')
  assert.equal(page.items[1]?.lookupCount, 0)
  assert.equal(page.items[1]?.errorCount, 2)
  assert.equal(page.items[1]?.lastSeenAt, '')
  assert.equal(page.nextOffset, 20)
  assert.equal(readItemsPage({ items: [], nextOffset: null })?.nextOffset, null)
  assert.equal(readItemsPage({ items: [], nextOffset: 2.5 })?.nextOffset, null)
  assert.equal(readItemsPage({ items: 'x' }), null)
  assert.equal(readItemsPage(null), null)
})

test('appendItems skips items already shown', () => {
  const first = appendItems(EMPTY_LIBRARY, { items: [summary('a'), summary('b')], nextOffset: 2 })
  const second = appendItems(first, { items: [summary('b'), summary('c')], nextOffset: null })
  assert.deepEqual(
    second.items.map((item) => item.id),
    ['a', 'b', 'c'],
  )
  assert.equal(second.nextOffset, null)
  // The earlier state is untouched.
  assert.equal(first.items.length, 2)
})

test('library rows show type, counts and level', () => {
  assert.deepEqual(toLibraryRow(summary('meticulous', { lookupCount: 3, errorCount: 1, level: 'learning' })), {
    id: 'meticulous',
    display: 'meticulous',
    level: 'learning',
    levelLabel: '学习中',
    meta: '单词 · 查过 3 次 · 错 1 次',
  })
  assert.equal(toLibraryRow(summary('g', { type: 'grammar', lookupCount: 0, errorCount: 2 })).meta, '语法 · 错 2 次')
  assert.equal(toLibraryRow(summary('p', { type: 'phrase', lookupCount: 0 })).meta, '句型')
})

test('the empty list explains itself', () => {
  assert.equal(emptyLibraryText({ q: ' tear ', type: null, level: null }), '没有找到「tear」')
  assert.equal(emptyLibraryText({ q: '', type: 'word', level: null }), '没有符合筛选的单元')
  assert.equal(emptyLibraryText(EMPTY_FILTER), '词库还是空的。每天凌晨会把前一天查过的词句整理进来')
})

const wordDetail = {
  id: 'i1',
  type: 'word',
  display: 'meticulous',
  status: 'ready',
  content: {
    headword: 'meticulous',
    ipa: '/məˈtɪkjələs/',
    meanings: [
      { pos: 'adj', zh: '一丝不苟的' },
      { pos: 'adj.', zh: '' },
    ],
    examples: [
      { en: 'She keeps meticulous records.', zh: '她记录得一丝不苟。', fromUser: true },
      { en: 'A meticulous plan.', zh: '周密的计划。', fromUser: false },
      { en: '', zh: '空' },
    ],
    collocations: ['meticulous attention to detail', '', 3],
    synonyms: [{ word: 'careful', note: '更常用' }, { note: 'no word' }],
    family: ['meticulously', 'meticulousness'],
  },
  lookupCount: 3,
  errorCount: 0,
  firstSeenAt: '2026-11-01T01:00:00.000Z',
  lastSeenAt: '2026-11-18T01:00:00.000Z',
  level: 'learning',
  cards: [
    { id: 'c1', cardType: 'recognize', state: 'review', due: '2026-11-21T01:00:00.000Z', mastered: false, suspended: false },
    { id: 'c2', cardType: 'produce', state: 1, due: '2026-11-19T01:00:00.000Z', mastered: false, suspended: false },
    { id: '', cardType: 'cloze' },
  ],
  sources: [
    { entryId: 'e1', input: 'meticulous', createdAt: '2026-11-18T01:00:00.000Z' },
    { entryId: 'e2', input: '   ', createdAt: '2026-11-17T01:00:00.000Z' },
  ],
}

test('readItemDetail reads a word unit loosely', () => {
  const detail = readItemDetail(wordDetail)
  assert.ok(detail !== null)
  assert.equal(detail.status, 'ready')
  assert.ok(detail.content !== null && detail.content.kind === 'word')
  const content = detail.content
  assert.equal(content.ipa, 'məˈtɪkjələs')
  assert.deepEqual(content.meanings, [{ pos: 'adj', zh: '一丝不苟的' }])
  assert.equal(content.examples.length, 2)
  assert.equal(content.examples[0]?.fromUser, true)
  assert.deepEqual(content.collocations, ['meticulous attention to detail'])
  assert.deepEqual(content.synonyms, [{ word: 'careful', note: '更常用' }])
  assert.deepEqual(content.family, ['meticulously', 'meticulousness'])
  assert.deepEqual(
    detail.cards.map((card) => [card.id, card.state]),
    [
      ['c1', 'review'],
      ['c2', 'learning'],
    ],
  )
  assert.deepEqual(
    detail.sources.map((source) => source.entryId),
    ['e1'],
  )
})

test('readItemDetail: no content yet, other types, and unusable responses', () => {
  const pending = readItemDetail({ ...wordDetail, status: 'pending', content: null })
  assert.equal(pending?.content, null)
  // One-line notices end without 。 (README "Design system → States").
  assert.equal(statusNotice(pending!), '内容还在整理，通常第二天早上就能看到')
  const noHead = readItemDetail({ ...wordDetail, content: { ...wordDetail.content, headword: ' ' } })
  assert.equal(noHead?.content, null)
  const regen = readItemDetail({ ...wordDetail, status: 'needs_regen' })
  assert.equal(statusNotice(regen!), '内容正在重新生成，稍后再来看')
  assert.equal(statusNotice(readItemDetail(wordDetail)!), '')

  const phrase = readItemDetail({
    ...wordDetail,
    type: 'phrase',
    content: {
      phrase: 'be torn between A and B',
      zh: '在 A 和 B 之间左右为难',
      register: 'casual',
      alternatives: [{ en: "can't decide between A and B", note: '' }, { note: 'x' }],
      examples: [],
    },
  })
  assert.ok(phrase?.content?.kind === 'phrase')
  assert.equal(phrase.content.register, 'casual')
  assert.equal(phrase.content.alternatives.length, 1)

  const grammar = readItemDetail({
    ...wordDetail,
    type: 'grammar',
    content: {
      title: 'look forward to + 动名词',
      rule: 'to 是介词',
      wrong: 'I look forward to hear from you.',
      right: 'I look forward to hearing from you.',
      exercises: [{ wrong: 'a', right: 'b' }, { wrong: 'c' }],
    },
  })
  assert.ok(grammar?.content?.kind === 'grammar')
  assert.equal(grammar.content.exercises.length, 1)

  assert.equal(readItemDetail({ ...wordDetail, type: 'sentence' }), null)
  assert.equal(readItemDetail({ ...wordDetail, id: '' }), null)
  assert.equal(readItemDetail('x'), null)
  // Unknown status and level fall back instead of failing the page.
  const odd = readItemDetail({ ...wordDetail, status: 'weird', level: 'weird' })
  assert.equal(odd?.status, 'ready')
  assert.equal(odd?.level, 'learning')
})

test('readCardState accepts names and FSRS numbers', () => {
  assert.equal(readCardState('relearning'), 'relearning')
  assert.equal(readCardState(2), 'review')
  assert.equal(readCardState(9), 'new')
  assert.equal(readCardState('x'), 'new')
})

test('formatDue words the next review in local time', () => {
  const now = new Date(2026, 10, 18, 10, 0)
  assert.equal(formatDue(new Date(2026, 10, 18, 9, 0).toISOString(), now), '待复习')
  assert.equal(formatDue(new Date(2026, 10, 18, 18, 30).toISOString(), now), '今天 18:30')
  assert.equal(formatDue(new Date(2026, 10, 19, 8, 0).toISOString(), now), '明天')
  assert.equal(formatDue(new Date(2026, 10, 21, 8, 0).toISOString(), now), '3 天后')
  assert.equal(formatDue(new Date(2026, 11, 24, 8, 0).toISOString(), now), '12月24日')
  assert.equal(formatDue(new Date(2027, 2, 1, 8, 0).toISOString(), now), '2027年3月1日')
  assert.equal(formatDue('nope', now), '')
})

test('card rows say when a card comes up, or why it does not', () => {
  const now = new Date(2026, 10, 18, 10, 0)
  const card = (extra: Partial<ItemCard>): ItemCard => ({
    id: 'c',
    cardType: 'recognize',
    state: 'review',
    due: new Date(2026, 10, 19, 8, 0).toISOString(),
    mastered: false,
    suspended: false,
    ...extra,
  })
  assert.deepEqual(toCardRow(card({}), now), {
    id: 'c',
    typeLabel: '认词',
    stateLabel: '复习中',
    dueLabel: '明天',
    resting: false,
  })
  assert.equal(toCardRow(card({ state: 'new' }), now).dueLabel, '等待首次复习')
  assert.equal(toCardRow(card({ mastered: true }), now).stateLabel, '已掌握')
  assert.equal(toCardRow(card({ suspended: true, mastered: true }), now).stateLabel, '已暂停')
  assert.equal(toCardRow(card({ cardType: 'fix' }), now).typeLabel, '改错')
  assert.equal(toCardRow(card({ cardType: 'future-type' }), now).typeLabel, 'future-type')
})

test('exercises reveal their answer without mutating the list', () => {
  const detail = readItemDetail({
    ...wordDetail,
    type: 'grammar',
    content: { title: 't', rule: '', wrong: '', right: '', exercises: [{ wrong: 'a', right: 'b' }, { wrong: 'c', right: 'd' }] },
  })
  const exercises = toExercises(detail?.content ?? null)
  assert.deepEqual(
    exercises.map((e) => [e.key, e.revealed]),
    [
      ['0', false],
      ['1', false],
    ],
  )
  const revealed = toggleExercise(exercises, 1)
  assert.equal(revealed[1]?.revealed, true)
  assert.equal(exercises[1]?.revealed, false)
  assert.equal(toggleExercise(revealed, 1)[1]?.revealed, false)
  assert.deepEqual(toExercises(readItemDetail(wordDetail)?.content ?? null), [])
})

test('sources, meta and part-of-speech labels', () => {
  assert.deepEqual(
    toSourceRows([{ entryId: 'e', input: 'x', createdAt: 'T' }], (iso) => `at ${iso}`),
    [{ id: 'e', input: 'x', time: 'at T' }],
  )
  const detail = readItemDetail({ ...wordDetail, errorCount: 2 })!
  assert.equal(itemMeta(detail, '单词', '学习中'), '单词 · 学习中 · 查过 3 次 · 错 2 次')
  assert.equal(posLabel('adj'), 'adj.')
  assert.equal(posLabel('n.'), 'n.')
  assert.equal(posLabel('形容词'), '形容词')
  assert.equal(posLabel(' '), '')
})
