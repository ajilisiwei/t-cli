import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PHRASE_WORDS,
  clipAround,
  isSelected,
  selectWord,
  selectionText,
  sentenceAround,
  splitForLookup,
  type Selection,
} from '../miniprogram/lib/tokens.ts'

const SENTENCE = 'Please keep your summary concise and focus on the key decisions.'

const wordsOf = (text: string): string[] => splitForLookup(text).words.map((word) => word.text)

test('words are letters with inner apostrophes and hyphens; the rest is text between them', () => {
  assert.deepEqual(wordsOf("Don't re-run the well-known job's 3 steps, OK?"), [
    "Don't",
    're-run',
    'the',
    'well-known',
    "job's",
    'steps',
    'OK',
  ])
  assert.deepEqual(wordsOf('rock’n’roll — naïve café, 2024'), ['rock’n’roll', 'naïve', 'café'])
  assert.deepEqual(wordsOf("students' 'quoted' -dash- trailing-"), ['students', 'quoted', 'dash', 'trailing'])
  assert.deepEqual(wordsOf('用 GraphQL 接口 and/or e.g. x'), ['GraphQL', 'and', 'or', 'e', 'g', 'x'])
  assert.deepEqual(wordsOf('  \n  '), [])
})

test('chips keep punctuation with its word and count the line breaks after them', () => {
  const { chips, words, locations } = splitForLookup('Hello, "world".\nNext line\n\nNew para')
  assert.deepEqual(
    chips.map((chip) => chip.parts.map((part) => `${part.text}${part.word >= 0 ? `#${part.word}` : ''}`).join('|')),
    ['Hello#0|,', '"|world#1|".', 'Next#2', 'line#3', 'New#4', 'para#5'],
  )
  assert.deepEqual(
    chips.map((chip) => chip.breaks),
    [0, 1, 0, 2, 0, 0],
  )
  assert.deepEqual(locations[1], { chip: 1, part: 1 })
  assert.equal(words.length, locations.length)
  // Offsets point back into the text.
  for (const word of words) assert.equal('Hello, "world".\nNext line\n\nNew para'.slice(word.start, word.end), word.text)
})

test('selectWord: a tap selects; the same word again clears; a far word starts over', () => {
  const { words } = splitForLookup(SENTENCE)
  const focus = 6
  assert.deepEqual(selectWord(null, focus, SENTENCE, words), { start: 6, end: 6 })
  assert.equal(selectWord({ start: 6, end: 6 }, 6, SENTENCE, words), null)
  assert.deepEqual(selectWord({ start: 6, end: 6 }, 2, SENTENCE, words), { start: 2, end: 2 })
  assert.deepEqual(selectWord({ start: 6, end: 6 }, 99, SENTENCE, words), { start: 6, end: 6 }, 'out of range: unchanged')
})

test('selectWord: an adjacent tap extends to a phrase on either side; a tap inside narrows', () => {
  const { words } = splitForLookup(SENTENCE)
  let selection: Selection | null = selectWord(null, 6, SENTENCE, words)
  selection = selectWord(selection, 7, SENTENCE, words)
  assert.deepEqual(selection, { start: 6, end: 7 })
  assert.equal(selectionText(SENTENCE, words, selection as Selection), 'focus on')
  selection = selectWord(selection, 5, SENTENCE, words)
  assert.equal(selectionText(SENTENCE, words, selection as Selection), 'and focus on')
  assert.deepEqual(selectWord(selection, 6, SENTENCE, words), { start: 6, end: 6 })
  assert.equal(isSelected(selection, 5), true)
  assert.equal(isSelected(selection, 8), false)
  assert.equal(isSelected(null, 0), false)
})

test('selectWord: no phrase across a sentence end or line break, or past the limits', () => {
  const text = 'It works. Then stop\nhere now'
  const { words } = splitForLookup(text)
  assert.deepEqual(selectWord({ start: 1, end: 1 }, 2, text, words), { start: 2, end: 2 }, 'across ". "')
  assert.deepEqual(selectWord({ start: 3, end: 3 }, 4, text, words), { start: 4, end: 4 }, 'across a line break')

  const many = 'one two three four five six seven'
  const manyWords = splitForLookup(many).words
  let selection: Selection | null = { start: 0, end: MAX_PHRASE_WORDS - 1 }
  selection = selectWord(selection, MAX_PHRASE_WORDS, many, manyWords)
  assert.deepEqual(selection, { start: MAX_PHRASE_WORDS, end: MAX_PHRASE_WORDS })

  const long = `${'a'.repeat(40)} ${'b'.repeat(30)}`
  const longWords = splitForLookup(long).words
  assert.deepEqual(selectWord({ start: 0, end: 0 }, 1, long, longWords), { start: 1, end: 1 }, 'over 64 code points')
})

test('selectionText keeps the text between words and collapses whitespace', () => {
  const text = 'a state-of-the-art,\n  well   known tool'
  const { words } = splitForLookup(text)
  assert.equal(selectionText(text, words, { start: 1, end: 3 }), 'state-of-the-art, well known')
  assert.equal(selectionText(text, words, { start: 3, end: 1 }), '')
})

test('sentenceAround: the sentence of the selection, by . ! ? … and line breaks', () => {
  const text = 'First one here. Please keep it short! And this?\nNew line… end'
  const { words } = splitForLookup(text)
  const index = (word: string): number => words.findIndex((candidate) => candidate.text === word)
  const at = (word: string): Selection => ({ start: index(word), end: index(word) })
  assert.equal(sentenceAround(text, words, at('keep')), 'Please keep it short!')
  assert.equal(sentenceAround(text, words, at('First')), 'First one here.')
  assert.equal(sentenceAround(text, words, at('this')), 'And this?')
  assert.equal(sentenceAround(text, words, at('New')), 'New line…')
  assert.equal(sentenceAround(text, words, at('end')), 'end')
  assert.equal(sentenceAround('我们 use GraphQL。下一句 here', splitForLookup('我们 use GraphQL。下一句 here').words, { start: 0, end: 1 }), '我们 use GraphQL。')
})

test('sentenceAround / clipAround: a long sentence is cut around the selection', () => {
  const text = `${'word '.repeat(100)}target ${'tail '.repeat(100)}`.trim()
  const { words } = splitForLookup(text)
  const target = words.findIndex((word) => word.text === 'target')
  const clipped = sentenceAround(text, words, { start: target, end: target }, 60)
  assert.ok(Array.from(clipped).length <= 60)
  assert.ok(clipped.includes('target'))
  assert.equal(clipAround('short', 0, 5, 300), 'short')
  assert.equal(clipAround('abcdefghij', 0, 2, 4), 'abcd', 'the window starts at the text start')
  assert.equal(clipAround('abcdefghij', 8, 10, 4), 'ghij', 'and ends at the text end')
  assert.equal(Array.from(clipAround('😀'.repeat(10), 8, 10, 4)).length, 4, 'counts code points')
})
