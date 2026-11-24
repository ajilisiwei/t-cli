import test from 'node:test'
import assert from 'node:assert/strict'
import { copyText } from '../miniprogram/lib/copy.ts'

test('a sentence or paragraph translation copies the translation only', () => {
  assert.equal(
    copyText({ task: 'translate', kind: 'sentence', output: '  请让你的总结简明扼要。\n' }),
    '请让你的总结简明扼要。',
  )
  assert.equal(
    copyText({ task: 'translate', kind: 'paragraph', output: '第一段。\r\n\r\n第二段。' }),
    '第一段。\n\n第二段。',
  )
  assert.equal(copyText({ task: 'translate', kind: null, output: 'Plain.' }), 'Plain.')
})

test('a word lookup copies the gloss line only: no head word, IPA or explanation', () => {
  assert.equal(
    copyText({ task: 'translate', kind: 'word', output: 'concise /kənˈsaɪs/ adj. 简洁的；简明的\n更多解释' }),
    'adj. 简洁的；简明的',
  )
  assert.equal(copyText({ task: 'translate', kind: 'word', output: '**meticulous** /məˈtɪkjələs/ 一丝不苟的' }), '一丝不苟的')
  assert.equal(
    copyText({ task: 'translate', kind: 'word', output: 'deadline /ˈdɛdˌlaɪn/' }),
    'deadline',
    'a Chinese source: the English word is the translation',
  )
  assert.equal(copyText({ task: 'translate', kind: 'word', output: 'look forward to /lʊk ˈfɔrwərd tu/ 期待' }), '期待')
  assert.equal(
    copyText({ task: 'translate', kind: 'word', output: 'qwzxkj — 无法识别的单词' }),
    'qwzxkj — 无法识别的单词',
    'no IPA: the line as it is',
  )
})

test('a check copies the corrected text only', () => {
  assert.equal(
    copyText({ task: 'check', kind: 'sentence', output: '\nI finished the report yesterday.\n\n1. 错误分析：has finished → finished' }),
    'I finished the report yesterday.',
  )
  assert.equal(copyText({ task: 'check', kind: 'sentence', output: '**Fixed text.**' }), 'Fixed text.')
})

test('nothing to copy', () => {
  assert.equal(copyText({ task: 'translate', kind: 'sentence', output: '  ' }), '')
  assert.equal(copyText({ task: 'check', kind: null, output: '' }), '')
})
