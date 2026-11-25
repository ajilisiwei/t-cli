import test from 'node:test'
import assert from 'node:assert/strict'
import type { Exercises } from '../miniprogram/lib/learn-types.ts'
import {
  MAX_CLOZE_OPTIONS,
  answerCloze,
  clozeOptions,
  clozeScore,
  clozeViews,
  exerciseCount,
  fixViews,
  isRightChoice,
  translateViews,
} from '../miniprogram/lib/exercises.ts'

const exercises: Exercises = {
  bank: ['circle back', 'concise', 'mitigate', 'postpone'],
  cloze: [
    { itemId: 'a', before: 'We need to ', after: ' the risk.', answer: 'mitigate', base: 'mitigate', zh: '我们需要降低风险。' },
    { itemId: 'b', before: 'They ', after: ' the launch.', answer: 'postponed', base: 'postpone', zh: '他们推迟了发布。' },
  ],
  translate: [{ itemId: 'c', zh: '保持简洁。', answer: 'Keep it concise.' }],
  fix: [{ itemId: 'd', wrong: 'I have sent it yesterday.', right: 'I sent it yesterday.' }],
}

test('isRightChoice ignores case and spacing', () => {
  assert.ok(isRightChoice('Circle  Back', 'circle back'))
  assert.ok(!isRightChoice('postpone', 'postponed'))
  assert.ok(!isRightChoice(' ', ''))
})

test('clozeOptions: the whole bank when small; else the base and three others, stable per question', () => {
  assert.deepEqual(clozeOptions(['b', 'a'], 'a', 0), ['a', 'b'])
  assert.deepEqual(clozeOptions([], 'x', 0), ['x'])
  const bank = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf']
  const first = clozeOptions(bank, 'delta', 0)
  assert.equal(first.length, MAX_CLOZE_OPTIONS)
  assert.ok(first.includes('delta'))
  assert.deepEqual(clozeOptions(bank, 'delta', 0), first)
  assert.notDeepEqual(clozeOptions(bank, 'delta', 1), first)
  assert.deepEqual([...first].sort((a, b) => a.localeCompare(b)), first)
})

test('clozeViews: blank, right (the sentence form) and wrong', () => {
  const idle = clozeViews(exercises, {})
  assert.equal(idle[0]?.state, 'idle')
  assert.equal(idle[0]?.fill, '')
  assert.equal(idle[0]?.zh, '')
  assert.equal(clozeScore(idle), '共 2 题')

  const answered = clozeViews(exercises, { c0: 'concise', c1: 'postpone' })
  assert.equal(answered[0]?.state, 'wrong')
  assert.equal(answered[0]?.fill, 'concise')
  assert.deepEqual(
    answered[0]?.choices.filter((choice) => choice.state !== 'idle'),
    [{ text: 'concise', state: 'wrong' }],
  )
  assert.equal(answered[1]?.state, 'right')
  assert.equal(answered[1]?.fill, 'postponed')
  assert.equal(answered[1]?.zh, '他们推迟了发布。')
  assert.equal(clozeScore(answered), '答对 1 / 2')
})

test('answerCloze: a wrong answer can be changed, a right one is final', () => {
  const wrong = answerCloze({}, exercises, 'c0', 'concise')
  assert.deepEqual(wrong, { c0: 'concise' })
  const right = answerCloze(wrong, exercises, 'c0', 'mitigate')
  assert.deepEqual(right, { c0: 'mitigate' })
  assert.equal(answerCloze(right, exercises, 'c0', 'concise'), right)
  assert.equal(answerCloze(right, exercises, 'c9', 'concise'), right)
  assert.equal(answerCloze(right, exercises, 'c1', ''), right)
})

test('translate and fix are revealed by key; counts add up', () => {
  assert.deepEqual(translateViews(exercises), [{ key: 't0', n: 1, prompt: '保持简洁。', answer: 'Keep it concise.' }])
  assert.deepEqual(fixViews(exercises), [{ key: 'f0', n: 1, prompt: 'I have sent it yesterday.', answer: 'I sent it yesterday.' }])
  assert.equal(exerciseCount(exercises), 4)
})
