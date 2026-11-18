import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_DIFF_CELLS,
  diffWords,
  displaySegments,
  hasChanges,
  tokenize,
  type DiffSegment,
} from '../miniprogram/lib/word-diff.ts'

const side = (segments: readonly DiffSegment[], keep: 'delete' | 'insert'): string =>
  segments.filter((segment) => segment.op === 'equal' || segment.op === keep).map((segment) => segment.text).join('')

const normalize = (text: string): string => text.replace(/\s+/g, ' ')

test('tokenize splits words, whitespace and punctuation', () => {
  assert.deepEqual(tokenize("I don't know, ok?"), ['I', ' ', "don't", ' ', 'know', ',', ' ', 'ok', '?'])
  assert.deepEqual(tokenize('well-known café'), ['well', '-', 'known', ' ', 'café'])
})

test('the mockup sentence: one word replaced', () => {
  const segments = diffWords('I look forward to hear from you soon.', 'I look forward to hearing from you soon.')
  assert.deepEqual(segments, [
    { op: 'equal', text: 'I look forward to ' },
    { op: 'delete', text: 'hear' },
    { op: 'insert', text: 'hearing' },
    { op: 'equal', text: ' from you soon.' },
  ])
  assert.deepEqual(displaySegments(segments), [
    { op: 'equal', text: 'I look forward to ' },
    { op: 'delete', text: 'hear' },
    { op: 'equal', text: ' ' },
    { op: 'insert', text: 'hearing' },
    { op: 'equal', text: ' from you soon.' },
  ])
})

test('punctuation and capitalisation are separate edits', () => {
  const segments = diffWords('i like it', 'I like it.')
  assert.deepEqual(segments, [
    { op: 'delete', text: 'i' },
    { op: 'insert', text: 'I' },
    { op: 'equal', text: ' like it' },
    { op: 'insert', text: '.' },
  ])
})

test('several edits in one sentence', () => {
  const segments = diffWords('She have went to the school yesterday', 'She went to school yesterday.')
  assert.equal(side(segments, 'delete'), normalize('She have went to the school yesterday'))
  assert.equal(side(segments, 'insert'), 'She went to school yesterday.')
  assert.deepEqual(
    segments.filter((segment) => segment.op === 'delete').map((segment) => segment.text.trim()),
    ['have', 'the'],
  )
})

test('both sides are reconstructed for arbitrary inputs', () => {
  const pairs: Array<[string, string]> = [
    ['', 'Hello.'],
    ['Hello.', ''],
    ['a b c d e', 'e d c b a'],
    ['The quick brown fox', 'A quick red fox jumps'],
    ['alot of people', 'a lot of people'],
    ['Same text.', 'Same text.'],
  ]
  for (const [before, after] of pairs) {
    const segments = diffWords(before, after)
    assert.equal(side(segments, 'insert'), after, `insert side of ${before} → ${after}`)
    assert.equal(normalize(side(segments, 'delete')), normalize(before), `delete side of ${before} → ${after}`)
  }
})

test('whitespace differences are not edits', () => {
  const segments = diffWords('Line one.\nLine  two.', 'Line one. Line two.')
  assert.deepEqual(segments, [{ op: 'equal', text: 'Line one. Line two.' }])
  assert.equal(hasChanges(segments), false)
  assert.equal(hasChanges(diffWords('a', 'b')), true)
})

test('display drops whitespace-only deletions and shows inserted spaces plainly', () => {
  assert.deepEqual(
    displaySegments([
      { op: 'equal', text: 'a' },
      { op: 'delete', text: ' ' },
      { op: 'insert', text: ' ' },
      { op: 'equal', text: 'b' },
    ]),
    [{ op: 'equal', text: 'a b' }],
  )
})

test('no separator is added when the deletion already ends with a space', () => {
  assert.deepEqual(
    displaySegments([
      { op: 'delete', text: 'very ' },
      { op: 'insert', text: 'really' },
    ]),
    [
      { op: 'delete', text: 'very ' },
      { op: 'insert', text: 'really' },
    ],
  )
})

test('inputs beyond the size bound replace the differing middle wholesale', () => {
  const words = (prefix: string, count: number): string =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ')
  const before = `Start ${words('a', 400)} end.`
  const after = `Start ${words('b', 400)} end.`
  assert.ok(tokenize(before).length * tokenize(after).length > MAX_DIFF_CELLS)
  const segments = diffWords(before, after)
  assert.deepEqual(segments.map((segment) => segment.op), ['equal', 'delete', 'insert', 'equal'])
  assert.equal(side(segments, 'insert'), after)
  assert.equal(side(segments, 'delete'), before)
})
