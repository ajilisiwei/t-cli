import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VISIBLE_EXPLANATIONS,
  explanationItems,
  explanationRows,
  numberChanges,
  visibleRows,
  type ExplanationRow,
} from '../miniprogram/lib/check-changes.ts'
import { diffWords, displaySegments } from '../miniprogram/lib/word-diff.ts'

const numbered = (before: string, after: string) => numberChanges(displaySegments(diffWords(before, after)))

/** The marked text: deletions in [-…], insertions in [+…], change numbers as ^n. */
const render = (before: string, after: string): string =>
  numbered(before, after)
    .segments.map((segment) => {
      const text = segment.op === 'delete' ? `[-${segment.text}]` : segment.op === 'insert' ? `[+${segment.text}]` : segment.text
      return segment.mark > 0 ? `${text}^${segment.mark}` : text
    })
    .join('')

test('each change gets one number, after its last edited word', () => {
  assert.equal(
    render('I has finished the report yesterday and send it.', 'I finished the report yesterday and sent it.'),
    'I [-has]^1 finished the report yesterday and [-send] [+sent]^2 it.',
  )
  const { changes } = numbered('I has finished the report and send it.', 'I finished the report and sent it.')
  assert.deepEqual(changes, [
    { no: 1, before: 'has', after: '' },
    { no: 2, before: 'send', after: 'sent' },
  ])
})

test('an insertion and a replacement are changes too; no changes, no numbers', () => {
  const { changes } = numbered('the lack of resource, he said', 'a lack of resources, and he said')
  assert.deepEqual(
    changes.map((change) => `${change.before}→${change.after}`),
    ['the→a', 'resource→resources', '→and'],
  )
  const same = numbered('All good.', 'All good.')
  assert.deepEqual(same.changes, [])
  assert.ok(same.segments.every((segment) => segment.mark === 0))
})

test('explanationItems: list entries and paragraphs; titles are headings', () => {
  const text = [
    '1. 错误分析：',
    '   - "has finished" 应改为 "finished"：句中有 yesterday，',
    '     用一般过去时。',
    '   - send → sent：和前面的 finished 并列，时态要一致。',
    '',
    '2. 更地道的表达：',
    '   - I wrapped up the report yesterday.',
    '',
    'A closing paragraph.',
  ].join('\n')
  assert.deepEqual(explanationItems(text), [
    { text: '错误分析：', heading: true },
    { text: '"has finished" 应改为 "finished"：句中有 yesterday， 用一般过去时。', heading: false },
    { text: 'send → sent：和前面的 finished 并列，时态要一致。', heading: false },
    { text: '更地道的表达：', heading: true },
    { text: 'I wrapped up the report yesterday.', heading: false },
    { text: 'A closing paragraph.', heading: false },
  ])
  assert.deepEqual(explanationItems('  \n\n'), [])
})

test('explanationRows: an item quoting both sides of a change becomes its reason; the rest follow', () => {
  const { changes } = numbered('I has finished it and send it.', 'I had finished it and sent it.')
  const items = explanationItems(
    ['错误分析：', '- "has" 应改为 "had"：过去完成时。', '- "send" → "sent"：时态一致。', '', '更地道的表达：', '- I wrapped it up and sent it.'].join('\n'),
  )
  const rows = explanationRows(changes, items)
  assert.deepEqual(
    rows.map((row) => [row.no, row.before, row.after, row.why, row.heading]),
    [
      [1, 'has', 'had', '"has" 应改为 "had"：过去完成时。', false],
      [2, 'send', 'sent', '"send" → "sent"：时态一致。', false],
      [0, '', '', '更地道的表达：', true],
      [0, '', '', 'I wrapped it up and sent it.', false],
    ],
    'the 错误分析 title lost its items and is dropped',
  )
})

test('explanationRows: whole-word matching; an unmatched change keeps an empty reason', () => {
  const { changes } = numbered('He go there.', 'He goes there.')
  const rows = explanationRows(changes, explanationItems('- "going" is not "goes" here.\n- Use goes, not go.'))
  assert.equal(rows[0]?.why, 'Use goes, not go.', '"go" inside "going" does not count')
  const none = explanationRows(changes, explanationItems('句子语法正确。'))
  assert.deepEqual(
    none.map((row) => [row.no, row.why]),
    [
      [1, ''],
      [0, '句子语法正确。'],
    ],
  )
})

test('visibleRows: three rows, then 「展开其余 N 条解释」', () => {
  const rows: ExplanationRow[] = Array.from({ length: 7 }, (_, i) => ({ no: i + 1, before: 'a', after: 'b', why: '', heading: false }))
  const collapsed = visibleRows(rows, false)
  assert.equal(collapsed.rows.length, VISIBLE_EXPLANATIONS)
  assert.equal(collapsed.hidden, 4)
  assert.equal(collapsed.collapsible, true)
  const expanded = visibleRows(rows, true)
  assert.equal(expanded.rows.length, 7)
  assert.equal(expanded.hidden, 0)
  assert.equal(expanded.collapsible, true)
  const few = visibleRows(rows.slice(0, 3), false)
  assert.deepEqual([few.rows.length, few.hidden, few.collapsible], [3, 0, false])
})
