import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IDLE_RESULT,
  WAITING_RESULT,
  applyStreamEvent,
  directionLabel,
  failResult,
  finishResult,
  flipDirection,
  isBusy,
  outputIsEnglish,
  speechKey,
  stopResult,
  type ResultState,
} from '../miniprogram/lib/result.ts'
import type { StreamEvent } from '../miniprogram/lib/types.ts'

const fold = (events: readonly StreamEvent[], start: ResultState = WAITING_RESULT): ResultState =>
  events.reduce(applyStreamEvent, start)

test('a full stream ends in done with the entry id', () => {
  const state = fold([
    { type: 'meta', srcLang: 'zh', kind: 'sentence' },
    { type: 'delta', text: 'This plan ' },
    { type: 'delta', text: 'still needs some polishing.' },
    { type: 'done', entry: { id: 'E1', seq: 7, kind: 'sentence', correctedInput: null } },
  ])
  assert.deepEqual(state, {
    status: 'done',
    srcLang: 'zh',
    kind: 'sentence',
    text: 'This plan still needs some polishing.',
    entryId: 'E1',
    errorCode: null,
  })
  assert.equal(isBusy(state), false)
})

test('an error line keeps the partial text and fails', () => {
  const state = fold([
    { type: 'meta', srcLang: 'en', kind: 'sentence' },
    { type: 'delta', text: '部分' },
    { type: 'error', code: 'AI_UPSTREAM', message: 'x' },
  ])
  assert.equal(state.status, 'failed')
  assert.equal(state.errorCode, 'AI_UPSTREAM')
  assert.equal(state.text, '部分')
})

test('lines after done are ignored', () => {
  const done = fold([{ type: 'done', entry: { id: 'E1', seq: 1, kind: null, correctedInput: null } }])
  assert.equal(applyStreamEvent(done, { type: 'delta', text: 'late' }), done)
})

test('a body that ends without done or error was cut off', () => {
  const state = finishResult(fold([{ type: 'delta', text: 'half' }]))
  assert.equal(state.status, 'failed')
  assert.equal(state.errorCode, 'STREAM_INCOMPLETE')
  const done = fold([{ type: 'done', entry: { id: 'E1', seq: 1, kind: null, correctedInput: null } }])
  assert.equal(finishResult(done), done)
})

test('stop and fail only affect running results', () => {
  assert.equal(stopResult(WAITING_RESULT).status, 'stopped')
  assert.equal(stopResult(IDLE_RESULT), IDLE_RESULT)
  const done = fold([{ type: 'done', entry: { id: 'E1', seq: 1, kind: null, correctedInput: null } }])
  assert.equal(failResult(done, 'NETWORK'), done)
  assert.equal(failResult(WAITING_RESULT, 'NETWORK').errorCode, 'NETWORK')
  assert.equal(isBusy(WAITING_RESULT), true)
})

test('direction label and flip follow the meta srcLang', () => {
  assert.equal(directionLabel('zh'), '中文 → 英文')
  assert.equal(directionLabel('en'), '英文 → 中文')
  assert.equal(directionLabel('other'), '外语 → 中文')
  assert.equal(directionLabel(null), '')
  assert.equal(flipDirection('zh'), 'toZh')
  assert.equal(flipDirection('en'), 'toEn')
  assert.equal(flipDirection('other'), 'toEn')
  assert.equal(outputIsEnglish('zh'), true)
  assert.equal(outputIsEnglish('other'), false)
})

test('speechKey: the entry id once the result is done, else empty', () => {
  const done = { ...IDLE_RESULT, status: 'done' as const, entryId: 'E1' }
  assert.equal(speechKey(done), 'E1')
  assert.equal(speechKey({ ...done, entryId: null }), '')
  assert.equal(speechKey({ ...done, status: 'streaming' }), '')
  assert.equal(speechKey(IDLE_RESULT), '')
})
