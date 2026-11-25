import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readAdoptResult,
  readExercises,
  readExtendMaterial,
  readLearnSummary,
  readMaterialList,
  readMaterialListItem,
  readPeriodicMaterial,
  readReadAt,
  readReasons,
} from '../miniprogram/lib/learn-wire.ts'
import { readDailyMaterial } from '../miniprogram/lib/review-material.ts'

const listItem = {
  kind: 'daily',
  date: '2026-11-24',
  title: '9 个词和一篇短文',
  subtitle: null,
  counts: { words: 6, phrases: 2, grammar: 1, exercises: 8, items: 0 },
  readAt: null,
  pages: 3,
  createdAt: '2026-11-24T21:00:00.000Z',
}

test('readMaterialListItem: kind and date required, counts default to 0', () => {
  assert.deepEqual(readMaterialListItem(listItem), listItem)
  assert.equal(readMaterialListItem({ ...listItem, kind: 'monthly' }), null)
  assert.equal(readMaterialListItem({ ...listItem, date: '24.11.2026' }), null)
  const sparse = readMaterialListItem({ kind: 'weekly', date: '2026-11-17' })
  assert.deepEqual(sparse?.counts, { words: 0, phrases: 0, grammar: 0, exercises: 0, items: 0 })
  assert.equal(sparse?.readAt, null)
  assert.equal(sparse?.pages, 0)
  assert.equal(sparse?.subtitle, null, 'an older server sends no subtitle')
})

test("readMaterialListItem: an extension's subtitle; blank or not a string is null", () => {
  const extend = { ...listItem, kind: 'extend', title: '开会和跟进的常用说法' }
  assert.equal(readMaterialListItem({ ...extend, subtitle: ' 最近 7 天你查了 6 个职场用词 ' })?.subtitle, '最近 7 天你查了 6 个职场用词')
  assert.equal(readMaterialListItem({ ...extend, subtitle: '  ' })?.subtitle, null)
  assert.equal(readMaterialListItem({ ...extend, subtitle: 3 })?.subtitle, null)
})

test('readMaterialList: rows and cursor; an old server without items is null', () => {
  const page = readMaterialList({ dates: ['2026-11-24'], items: [listItem, { kind: 'x' }], nextBefore: '2026-11-01' })
  assert.equal(page?.items.length, 1)
  assert.equal(page?.nextBefore, '2026-11-01')
  assert.equal(readMaterialList({ dates: ['2026-11-24'], nextBefore: null }), null)
  assert.equal(readMaterialList({ items: [], nextBefore: 'later' })?.nextBefore, null)
})

test('readLearnSummary: dueByScope is required; plan and level get defaults', () => {
  const summary = readLearnSummary({
    review: { dueByScope: { all: 18, notes: 7, stars3: 9 }, doneToday: 12, estimatedMinutes: 6, streakDays: 5 },
    materials: [listItem, null],
    plan: { materialFrequency: 'weekly', materialWeekday: 3, extendEnabled: false },
    level: { setting: 'auto', effective: 'B2', retention30: 0.91, reviews30: 160 },
  })
  assert.ok(summary)
  assert.deepEqual(summary.review.dueByScope, { all: 18, notes: 7, stars3: 9 })
  assert.equal(summary.materials.length, 1)
  assert.deepEqual(summary.plan, { materialFrequency: 'weekly', materialWeekday: 3, extendEnabled: false })
  assert.deepEqual(summary.level, { setting: 'auto', effective: 'B2', retention30: 0.91, reviews30: 160 })

  const bare = readLearnSummary({ review: { dueByScope: { all: 0, notes: 0, stars3: 0 } } })
  assert.deepEqual(bare?.plan, { materialFrequency: 'daily', materialWeekday: 1, extendEnabled: true })
  assert.deepEqual(bare?.level, { setting: 'auto', effective: 'B1', retention30: null, reviews30: 0 })
  assert.equal(readLearnSummary({ review: { dueByScope: { all: 1 } } }), null)
  assert.equal(readLearnSummary(null), null)
})

test('readExercises: lenient lists; every cloze base is in the bank', () => {
  const exercises = readExercises({
    bank: ['postpone', 'concise', ''],
    cloze: [
      { itemId: 'a', before: 'We need to ', after: ' the risk.', answer: 'mitigate', base: 'mitigate', zh: '我们需要降低风险。' },
      { itemId: 'b', before: '', after: '', answer: 'x', base: 'x', zh: '' },
      { itemId: 'c', before: 'Keep it ', after: '.', answer: '', base: 'concise', zh: '' },
    ],
    translate: [{ itemId: 'd', zh: '推迟会议', answer: 'Postpone the meeting.' }, { zh: '' }],
    fix: [{ itemId: 'e', wrong: 'I have sent it yesterday.', right: 'I sent it yesterday.' }, 'nope'],
  })
  assert.deepEqual(exercises.bank, ['concise', 'mitigate', 'postpone'])
  assert.equal(exercises.cloze.length, 1)
  assert.equal(exercises.cloze[0]?.before, 'We need to ')
  assert.equal(exercises.translate.length, 1)
  assert.equal(exercises.fix.length, 1)
  assert.deepEqual(readExercises(undefined), { bank: [], cloze: [], translate: [], fix: [] })
})

const daily = {
  date: '2026-11-24',
  overview: { newWords: 1, newPhrases: 0, corrections: 0, streakDays: 3 },
  words: [{ itemId: 'w1', headword: 'mitigate', ipa: '/ˈmɪtɪɡeɪt/', meanings: [{ pos: 'v.', zh: '减轻' }], examples: [] }],
  phrases: [],
  grammar: [],
  story: null,
  mistakes: [],
}

test('readPeriodicMaterial: daily ignores digest fields; digest reads range and recap', () => {
  const day = readPeriodicMaterial(
    { date: '2026-11-24', kind: 'daily', createdAt: 'x', readAt: null, content: { ...daily, range: { start: 'a', end: 'b' } } },
    'daily',
    readDailyMaterial,
  )
  assert.equal(day?.kind, 'daily')
  assert.equal(day?.range, null)
  assert.equal(day?.content.words[0]?.headword, 'mitigate')
  assert.deepEqual(day?.exercises.cloze, [])
  assert.equal(day?.reasons.size, 0, 'an older server sends no reasons')

  const digest = readPeriodicMaterial(
    {
      date: '2026-11-24',
      kind: 'digest',
      createdAt: '2026-11-24T21:00:00Z',
      readAt: '2026-11-25T08:00:00Z',
      content: {
        ...daily,
        range: { start: '2026-11-18', end: '2026-11-24' },
        review: [{ itemId: 'r1', display: 'circle back', gloss: '回头再讨论', lapses: 2 }, { display: '' }],
      },
      exercises: { bank: ['mitigate'], cloze: [], translate: [], fix: [] },
      reasons: { w1: { stars: 3, lapses: 2, lookups: 1 } },
    },
    'digest',
    readDailyMaterial,
  )
  assert.deepEqual(digest?.reasons.get('w1'), { stars: 3, lapses: 2, lookups: 1 })
  assert.deepEqual(digest?.range, { start: '2026-11-18', end: '2026-11-24' })
  assert.deepEqual(digest?.review, [{ itemId: 'r1', display: 'circle back', gloss: '回头再讨论', lapses: 2 }])
  assert.equal(digest?.readAt, '2026-11-25T08:00:00Z')
  assert.equal(readPeriodicMaterial({ date: 'bad', content: daily }, 'daily', readDailyMaterial), null)
})

test('readReasons: by item id; counts default to 0, stars stay within 0–4, malformed entries are skipped', () => {
  const reasons = readReasons({
    w1: { stars: 2, lapses: 0, lookups: 3 },
    w2: { stars: 9, lapses: -1, lookups: 1.7 },
    w3: {},
    w4: 'junk',
    '': { stars: 1 },
  })
  assert.deepEqual(
    [...reasons],
    [
      ['w1', { stars: 2, lapses: 0, lookups: 3 }],
      ['w2', { stars: 4, lapses: 0, lookups: 1 }],
      ['w3', { stars: 0, lapses: 0, lookups: 0 }],
    ],
  )
  assert.equal(readReasons(null).size, 0)
  assert.equal(readReasons([{ stars: 1 }]).size, 0)
  // An id like "__proto__" is just a key.
  assert.deepEqual(readReasons(JSON.parse('{"__proto__": {"stars": 1}}')).get('__proto__'), { stars: 1, lapses: 0, lookups: 0 })
})

const extendItems = [
  { text: 'heads-up', kind: 'phrase', gloss: '提前告知', example: { en: 'Just a heads-up.', zh: '提前说一声。' } },
  { text: 'bandwidth', kind: 'word', gloss: '精力', example: { en: 'No bandwidth.', zh: '没精力。' } },
]

test('readExtendMaterial: items keep their indexes, known is per item', () => {
  const material = readExtendMaterial({
    date: '2026-11-23',
    createdAt: '2026-11-23T05:00:00Z',
    readAt: null,
    content: {
      focus: 'topic',
      topic: 'work',
      title: '职场邮件里常说的 10 个表达',
      level: 'B1',
      reasons: ['最近 7 天你查了 deadline 等 6 个职场用词'],
      evidence: ['deadline'],
      items: extendItems,
      passage: { title: 'Mail', text: 'Hi Tom,', zh: '汤姆你好' },
      grammar: null,
    },
    known: [false, true, true],
  })
  assert.ok(material)
  assert.equal(material.content.items.length, 2)
  assert.deepEqual(material.known, [false, true])
  assert.equal(material.content.topic, 'work')
  assert.equal(material.content.passage?.text, 'Hi Tom,')
  assert.equal(material.content.grammar, null)

  // A malformed item would shift the indexes adopt sends: the whole material is refused.
  const holey = readExtendMaterial({ date: '2026-11-23', content: { items: [extendItems[0], { text: '' }] } })
  assert.equal(holey, null)
  const odd = readExtendMaterial({ date: '2026-11-23', content: { focus: 'x', topic: 'y', level: 'Z', items: extendItems } })
  assert.equal(odd?.content.focus, 'topic')
  assert.equal(odd?.content.topic, 'other')
  assert.deepEqual(odd?.known, [false, false])
})

test('readAdoptResult and readReadAt', () => {
  assert.deepEqual(readAdoptResult({ added: [0, 2, -1, 'x'], known: [1] }), { added: [0, 2], known: [1] })
  assert.equal(readAdoptResult({ added: [] }), null)
  assert.equal(readReadAt({ readAt: '2026-11-25T08:00:00Z' }), '2026-11-25T08:00:00Z')
  assert.equal(readReadAt({ readAt: null }), null)
  assert.equal(readReadAt({}), undefined)
  assert.equal(readReadAt({ readAt: 3 }), undefined)
})
