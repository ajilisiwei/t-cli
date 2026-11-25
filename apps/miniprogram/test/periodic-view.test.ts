import test from 'node:test'
import assert from 'node:assert/strict'
import type { DailyMaterial } from '../miniprogram/lib/review-types.ts'
import {
  cardWords,
  countCells,
  estimateMaterialPages,
  lapsesLabel,
  periodicTitle,
  phraseRows,
  showsPart,
  wordRows,
} from '../miniprogram/lib/periodic-view.ts'

const content: DailyMaterial = {
  date: '2026-11-24',
  overview: { newWords: 2, newPhrases: 1, corrections: 1, streakDays: 3 },
  words: [
    {
      itemId: 'w1',
      headword: 'mitigate',
      ipa: 'ˈmɪtɪɡeɪt',
      meanings: [
        { pos: 'v.', zh: '减轻' },
        { pos: '', zh: '缓和' },
        { pos: 'v.', zh: '第三个' },
      ],
      examples: [{ en: 'Mitigate the risk.', zh: '降低风险。', fromUser: false }],
      collocations: [],
      synonyms: [],
      family: [],
    },
    {
      itemId: 'w2',
      headword: 'concise',
      ipa: '',
      meanings: [{ pos: 'adj.', zh: '简洁的' }],
      examples: [],
      collocations: [],
      synonyms: [],
      family: [],
    },
  ],
  phrases: [
    { itemId: 'p1', phrase: 'circle back', zh: '回头再讨论', register: 'casual', alternatives: [], examples: [] },
  ],
  grammar: [{ itemId: 'g1', title: '过去时', rule: 'r', wrong: 'w', right: 'r', exercises: [] }],
  story: { title: 'A Quiet Monday', text: 'The team…', words: ['mitigate'], zh: '团队…' },
  mistakes: [],
}

const empty: DailyMaterial = { ...content, words: [], phrases: [], grammar: [], story: null, mistakes: [] }

test('periodicTitle: units and story, a digest recap, or nothing new', () => {
  assert.equal(periodicTitle({ kind: 'daily', content, review: [] }), '3 个词和一篇短文')
  assert.equal(periodicTitle({ kind: 'daily', content: { ...content, story: null }, review: [] }), '3 个词')
  const recap = [{ itemId: 'r', display: 'x', gloss: 'y', lapses: 2 }]
  assert.equal(periodicTitle({ kind: 'digest', content: empty, review: recap }), '本周复习时忘过的 1 个')
  assert.equal(periodicTitle({ kind: 'digest', content: empty, review: [] }), '这周没有新内容')
  assert.equal(periodicTitle({ kind: 'daily', content: empty, review: [] }), '这天没有新内容')
})

test('countCells follow materialParts', () => {
  const all = countCells({ content }, 8, ['words', 'phrases', 'grammar', 'story', 'exercises'])
  assert.deepEqual(all, [
    { label: '新词', value: 2 },
    { label: '词组', value: 1 },
    { label: '易错', value: 1 },
    { label: '练习', value: 8 },
  ])
  assert.deepEqual(
    countCells({ content }, 8, ['words', 'story']).map((cell) => cell.label),
    ['新词'],
  )
  assert.ok(showsPart(['story'], 'story'))
  assert.ok(!showsPart(['story'], 'words'))
})

test('word and phrase rows: two meanings, the first example, a speech key', () => {
  const keyOf = (itemId: string, text: string): string => `${itemId}/${text}`
  const [first, second] = wordRows(content.words, keyOf)
  assert.equal(first?.gloss, 'v. 减轻 · 缓和')
  assert.equal(first?.exampleEn, 'Mitigate the risk.')
  assert.equal(first?.key, 'w1/mitigate')
  assert.equal(second?.exampleEn, '')
  assert.deepEqual(phraseRows(content.phrases, keyOf)[0], {
    itemId: 'p1',
    key: 'p1/circle back',
    text: 'circle back',
    ipa: '',
    gloss: '回头再讨论',
    exampleEn: '',
    exampleZh: '',
  })
})

test('card words, page estimate and lapses label', () => {
  assert.equal(cardWords({ content }), 3)
  assert.equal(estimateMaterialPages({ content: empty }, 0), 1)
  assert.equal(estimateMaterialPages({ content }, 8), 2)
  assert.equal(lapsesLabel(2), '忘了 2 次')
  assert.equal(lapsesLabel(0), '')
})
