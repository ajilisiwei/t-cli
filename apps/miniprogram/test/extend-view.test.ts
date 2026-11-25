import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ADOPT,
  addLabel,
  adoptedText,
  allSelected,
  applyAdopt,
  chosenIndexes,
  dismissText,
  initialSelection,
  itemRows,
  selectAll,
  toggleItem,
} from '../miniprogram/lib/extend-view.ts'

const known = [false, false, true, false]

test('every unknown item starts ticked; known ones cannot be ticked', () => {
  const selected = initialSelection(known)
  assert.deepEqual(selected, [true, true, false, true])
  assert.ok(allSelected(selected, known))
  assert.deepEqual(toggleItem(selected, known, 2), selected)
  const one = toggleItem(selected, known, 1)
  assert.deepEqual(one, [true, false, false, true])
  assert.ok(!allSelected(one, known))
  assert.deepEqual(toggleItem(one, known, 9), one)
})

test('select all / none and the indexes to adopt', () => {
  assert.deepEqual(selectAll(known, false), [false, false, false, false])
  assert.deepEqual(selectAll(known, true), [true, true, false, true])
  assert.deepEqual(chosenIndexes([true, false, true, true], known), [0, 3])
  const twelve = Array.from({ length: 12 }, () => false)
  assert.equal(chosenIndexes(initialSelection(twelve), twelve).length, MAX_ADOPT)
})

test('after adopting, added and existing items are known', () => {
  assert.deepEqual(applyAdopt(known, { added: [0], known: [3] }), [true, false, true, true])
  assert.equal(adoptedText({ added: [0, 1], known: [] }), '已加入 2 条，复习卡片最晚明天出现')
  assert.equal(adoptedText({ added: [], known: [1] }), '这些已经在复习里了')
  assert.equal(addLabel(6), '加入复习（6）')
  assert.equal(addLabel(0), '加入复习')
  assert.match(dismissText('职场'), /「职场」这个主题 30 天内不再推荐/)
})

test('itemRows carry the index, the known mark and the tick', () => {
  const rows = itemRows(
    {
      items: [
        { text: 'heads-up', kind: 'phrase', gloss: '提前告知', example: { en: 'Just a heads-up.', zh: '提前说一声。' } },
        { text: 'circle back', kind: 'phrase', gloss: '回头再讨论', example: { en: "Let's circle back.", zh: '回头再说。' } },
      ],
    },
    [false, true],
    [true, true],
  )
  assert.deepEqual(
    rows.map((row) => [row.index, row.known, row.checked]),
    [
      [0, false, true],
      [1, true, false],
    ],
  )
  assert.equal(rows[0]?.aria, '把 heads-up 加入复习')
})
