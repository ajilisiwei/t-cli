import test from 'node:test'
import assert from 'node:assert/strict'
import { COUNTER_FROM, clipInput, inputCounter, paragraphCount } from '../miniprogram/lib/composer.ts'

test('the counter shows past 1800 code points, grouped', () => {
  assert.equal(inputCounter('a'.repeat(COUNTER_FROM)), '')
  assert.equal(inputCounter('a'.repeat(COUNTER_FROM + 1)), '1,801 / 2000')
  assert.equal(inputCounter('😀'.repeat(1000)), '', 'counts code points, not UTF-16 units')
  assert.equal(inputCounter('字'.repeat(2000)), '2,000 / 2000')
})

test('pasted text is cut to the limit without splitting a character', () => {
  assert.deepEqual(clipInput('short'), { text: 'short', clipped: false })
  const clipped = clipInput(`${'😀'.repeat(3)}abc`, 4)
  assert.deepEqual(clipped, { text: '😀😀😀a', clipped: true })
})

test('paragraphCount counts non-empty lines', () => {
  assert.equal(paragraphCount('一段。\n\n二段。\r\n三段。\n  \n'), 3)
  assert.equal(paragraphCount(''), 0)
})
