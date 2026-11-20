import test from 'node:test'
import assert from 'node:assert/strict'
import { extractHeadTerm } from '@t-cli/core/spelling'
import { cleanMarkdown, codePointLength, parseWordHeadline, splitFirstLine } from '../miniprogram/lib/output.ts'

test('splitFirstLine takes the first non-empty line', () => {
  assert.deepEqual(splitFirstLine('\n\n**I look forward to hearing from you.**\n\n1. 分析\n2. 替换'), {
    first: 'I look forward to hearing from you.',
    rest: '1. 分析\n2. 替换',
  })
  assert.deepEqual(splitFirstLine('One line only'), { first: 'One line only', rest: '' })
  assert.deepEqual(splitFirstLine('  \n '), { first: '', rest: '' })
})

test('parseWordHeadline reads head, IPA and gloss', () => {
  assert.deepEqual(parseWordHeadline('meticulous /məˈtɪkjələs/ 一丝不苟的；极其仔细的'), {
    head: 'meticulous',
    ipa: 'məˈtɪkjələs',
    gloss: '一丝不苟的；极其仔细的',
    rest: '',
  })
  assert.deepEqual(parseWordHeadline('apple /ˈæp.əl/'), { head: 'apple', ipa: 'ˈæp.əl', gloss: '', rest: '' })
  assert.deepEqual(parseWordHeadline('look forward to /lʊk ˈfɔːr.wɚd tuː/ 期待\n\nmore'), {
    head: 'look forward to',
    ipa: 'lʊk ˈfɔːr.wɚd tuː',
    gloss: '期待',
    rest: 'more',
  })
})

test('parseWordHeadline returns null for anything else', () => {
  assert.equal(parseWordHeadline('qwzxkj — 无法识别的单词'), null)
  assert.equal(parseWordHeadline('This plan still needs some polishing.'), null)
  assert.equal(parseWordHeadline('苹果 /ˈæp.əl/'), null)
  // Mid-stream: the IPA is not closed yet.
  assert.equal(parseWordHeadline('meticulous /məˈtɪk'), null)
})

test('the head term agrees with packages/core extractHeadTerm', () => {
  const samples = [
    'meticulous /məˈtɪkjələs/ 一丝不苟的',
    'prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑',
    "don't /doʊnt/ 不要",
    'well-known /ˌwelˈnoʊn/ 著名的',
    'look forward to /lʊk ˈfɔːr.wɚd tuː/ 期待',
    '**apple** /ˈæp.əl/',
    '\n\nachieved /əˈtʃiːvd/ 实现了\n注意：拼写有误',
    'qwzxkj — 无法识别的单词',
    '这不是单词',
  ]
  for (const sample of samples) {
    assert.equal(parseWordHeadline(sample)?.head ?? null, extractHeadTerm(sample), sample)
  }
})

test('cleanMarkdown strips emphasis and headings but keeps structure', () => {
  assert.equal(
    cleanMarkdown('## 分析\n\n\n\n1. **hear** → **hearing**\n- __note__'),
    '分析\n\n1. hear → hearing\n- note',
  )
})

test('codePointLength counts astral characters once', () => {
  assert.equal(codePointLength('a中😀'), 3)
})
