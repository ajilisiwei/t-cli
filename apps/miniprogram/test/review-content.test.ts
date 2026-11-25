import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readBatchResult,
  readFace,
  readQueueCard,
  readQueueCards,
  readSummary,
} from '../miniprogram/lib/review-validate.ts'
import {
  cardSpeechKey,
  cardView,
  clozeSegments,
  containsCjk,
  fingerprint,
  fixSegments,
  markOccurrences,
  storySpeechKey,
} from '../miniprogram/lib/review-card.ts'
import { readDailyMaterial, storySegments } from '../miniprogram/lib/review-material.ts'
import { diffWords } from '../miniprogram/lib/word-diff.ts'
import type { QueueCard } from '../miniprogram/lib/review-types.ts'

const wireCard = {
  id: 'card-1',
  itemId: 'item-1',
  itemType: 'word',
  cardType: 'recognize',
  front: { text: 'meticulous', ipa: '/məˈtɪkjələs/' },
  back: {
    text: 'adj. 一丝不苟的；极其仔细的',
    example: { en: 'She keeps meticulous records.', zh: '她一丝不苟地记录。' },
  },
  state: 'review',
  intervals: { '1': 600, '2': 86400, '3': 259200, '4': 691200 },
}

test('readSummary needs every count', () => {
  const ok = { due: 24, newAvailable: 12, reviewDue: 12, doneToday: 18, estimatedMinutes: 4, streakDays: 23 }
  assert.deepEqual(readSummary(ok), ok)
  assert.equal(readSummary({ ...ok, due: -1 }), null)
  assert.equal(readSummary({ ...ok, streakDays: '3' }), null)
  assert.equal(readSummary([]), null)
})

test('readQueueCard keeps contract cards and skips broken ones', () => {
  assert.deepEqual(readQueueCard(wireCard), wireCard)
  assert.equal(readQueueCard({ ...wireCard, itemType: 'idiom' }), null)
  assert.equal(readQueueCard({ ...wireCard, state: 'mastered' }), null)
  assert.equal(readQueueCard({ ...wireCard, front: { text: '  ' } }), null)
  assert.equal(readQueueCard({ ...wireCard, intervals: { '1': 600, '2': 1, '3': 2 } }), null)
  const cards = readQueueCards({ cards: [wireCard, { id: 'broken' }, { ...wireCard, id: 'card-2' }] })
  assert.deepEqual(
    cards?.map((card) => card.id),
    ['card-1', 'card-2'],
  )
  assert.equal(readQueueCards({ items: [] }), null)
})

test('readFace drops empty optional fields', () => {
  assert.deepEqual(readFace({ text: 'a', ipa: '', sub: 'x', example: { en: 'e' } }), { text: 'a', sub: 'x' })
})

test('readBatchResult lists accepted ids and the rejected ids it can name', () => {
  assert.deepEqual(
    readBatchResult({
      accepted: ['a', 'b'],
      rejected: [
        { id: 'c', errors: ['unknown card'] },
        { id: null, errors: ['bad'] },
      ],
      cards: [],
    }),
    { accepted: ['a', 'b'], rejected: ['c'] },
  )
  assert.equal(readBatchResult({ accepted: [] }), null)
})

const queueCard = (overrides: Partial<QueueCard>): QueueCard => ({ ...(wireCard as QueueCard), ...overrides })

test('cardView: recognize shows a serif headword, then the meanings', () => {
  const view = cardView(queueCard({}), diffWords)
  assert.equal(view.label, '认词')
  assert.equal(view.front.serif, true)
  assert.equal(view.front.headword, true)
  // The server sends IPA in slashes; the page adds its own, so the view has none.
  assert.equal(view.front.ipa, 'məˈtɪkjələs')
  assert.equal(cardView(queueCard({ front: { text: 'x', ipa: 'bare' } }), diffWords).front.ipa, 'bare')
  assert.equal(view.back.serif, false)
  assert.equal(view.back.headword, false)
  assert.equal(view.back.exampleEn, 'She keeps meticulous records.')
})

test('cardView: cloze marks the blank and, on the back, the answer', () => {
  const view = cardView(
    queueCard({
      cardType: 'cloze',
      front: { text: 'She keeps ____ records.', sub: '她一丝不苟地记录。' },
      back: { text: 'She keeps meticulous records.', sub: 'meticulous' },
    }),
    diffWords,
  )
  assert.deepEqual(view.front.segments, [
    { text: 'She keeps ', mark: false },
    { text: '____', mark: true },
    { text: ' records.', mark: false },
  ])
  assert.equal(view.front.headword, false)
  assert.equal(view.front.subSerif, false)
  assert.deepEqual(view.back.segments, [
    { text: 'She keeps ', mark: false },
    { text: 'meticulous', mark: true },
    { text: ' records.', mark: false },
  ])
})

test('cardView: fix marks the corrected words', () => {
  const view = cardView(
    queueCard({
      itemType: 'grammar',
      cardType: 'fix',
      front: { text: 'I look forward to hear from you.' },
      back: { text: 'I look forward to hearing from you.', sub: 'look forward to + 动名词' },
    }),
    diffWords,
  )
  assert.equal(view.label, '改错')
  assert.deepEqual(view.back.segments, [
    { text: 'I look forward to ', mark: false },
    { text: 'hearing', mark: true },
    { text: ' from you.', mark: false },
  ])
})

test('cardView: an unknown card type still renders', () => {
  const view = cardView(queueCard({ cardType: 'future-type' }), diffWords)
  assert.equal(view.label, '复习')
  assert.equal(view.front.segments[0]?.text, 'meticulous')
})

test('segment helpers', () => {
  assert.deepEqual(clozeSegments('____ is ___ here'), [
    { text: '____', mark: true },
    { text: ' is ', mark: false },
    { text: '____', mark: true },
    { text: ' here', mark: false },
  ])
  assert.deepEqual(clozeSegments('no blank_here'), [{ text: 'no blank_here', mark: false }])
  assert.deepEqual(markOccurrences('Be torn between be and bee', 'be'), [
    { text: 'Be', mark: true },
    { text: ' torn between ', mark: false },
    { text: 'be', mark: true },
    { text: ' and bee', mark: false },
  ])
  assert.deepEqual(markOccurrences('a (b) c', '(b)'), [
    { text: 'a ', mark: false },
    { text: '(b)', mark: true },
    { text: ' c', mark: false },
  ])
  assert.deepEqual(markOccurrences('text', ''), [{ text: 'text', mark: false }])
  assert.deepEqual(fixSegments('same', 'same', diffWords), [{ text: 'same', mark: false }])
  assert.equal(containsCjk('hello'), false)
  assert.equal(containsCjk('n. 单词'), true)
})

test('speech keys change when the faces change', () => {
  const a = queueCard({})
  const b = queueCard({ back: { text: 'adj. 细致的' } })
  assert.notEqual(cardSpeechKey(a), cardSpeechKey(b))
  assert.equal(cardSpeechKey(a), cardSpeechKey(queueCard({})))
  assert.match(cardSpeechKey(a), /^c-card-1-[0-9a-z]+$/)
  assert.equal(fingerprint(''), (0x811c9dc5).toString(36))
  assert.match(storySpeechKey('2026-11-20', 'Once upon a time.'), /^s-2026-11-20-[0-9a-z]+$/)
  assert.notEqual(storySpeechKey('2026-11-20', 'a'), storySpeechKey('2026-11-20', 'b'))
})

const material = {
  date: '2026-11-19',
  overview: { newWords: 2, newPhrases: 1, corrections: 1, streakDays: 23 },
  words: [
    {
      itemId: 'w1',
      headword: 'meticulous',
      ipa: '/məˈtɪkjələs/',
      meanings: [{ pos: 'adj.', zh: '一丝不苟的' }, { pos: 'adj.' }],
      examples: [
        { en: 'She keeps meticulous records.', zh: '她一丝不苟地记录。', fromUser: false },
        { en: 'A meticulous plan.', zh: '周密的计划。', fromUser: true },
      ],
      collocations: ['meticulous attention to detail'],
      synonyms: [{ word: 'careful', note: '更常用' }],
      family: ['meticulously'],
    },
    { itemId: 'w2' },
  ],
  phrases: [
    {
      itemId: 'p1',
      phrase: 'be torn between A and B',
      zh: '在 A 和 B 之间左右为难',
      register: 'casual',
      alternatives: [{ en: "can't decide between A and B", note: '' }],
      examples: [],
    },
  ],
  grammar: [
    {
      itemId: 'g1',
      title: 'look forward to + 动名词',
      rule: 'to 是介词',
      wrong: 'I look forward to hear from you.',
      right: 'I look forward to hearing from you.',
      exercises: [{ wrong: 'I look forward to see you.', right: 'I look forward to seeing you.' }, { wrong: 'x' }],
    },
  ],
  story: { title: 'A Careful Plan', text: 'She was meticulously careful.', words: ['meticulous', 'careful'], zh: '她非常小心。' },
  mistakes: [],
}

test('readDailyMaterial is lenient with entries and strict with the envelope', () => {
  const read = readDailyMaterial(material)
  assert.ok(read)
  assert.equal(read.words.length, 1, 'the word without a headword is skipped')
  assert.equal(read.words[0]?.meanings.length, 1)
  assert.equal(read.words[0]?.ipa, 'məˈtɪkjələs', 'IPA without its slashes')
  assert.equal(read.words[0]?.examples[1]?.fromUser, true)
  assert.equal(read.phrases[0]?.register, 'casual')
  assert.equal(read.grammar[0]?.exercises.length, 1)
  assert.equal(read.story?.title, 'A Careful Plan')
  assert.deepEqual(readDailyMaterial({})?.words, [])
  assert.equal(readDailyMaterial('x'), null)
})

test('storySegments marks the day’s words and simple inflections', () => {
  assert.deepEqual(storySegments('She was meticulously careful, not careless.', ['meticulous', 'careful', 'care']), [
    { text: 'She was ', word: false },
    { text: 'meticulously', word: true },
    { text: ' ', word: false },
    { text: 'careful', word: true },
    { text: ', not careless.', word: false },
  ])
  assert.deepEqual(storySegments('Torn between two.', ['torn between']), [
    { text: 'Torn between', word: true },
    { text: ' two.', word: false },
  ])
  assert.deepEqual(storySegments('Nothing here.', []), [{ text: 'Nothing here.', word: false }])
  assert.deepEqual(storySegments('', ['x']), [])
})
