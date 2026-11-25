import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_EXPORT_OPTIONS,
  defaultPdfName,
  estimatePages,
  exportErrorText,
  exportRequest,
  fileSummary,
  initialChoice,
  pdfFileName,
  readPdfPages,
  scopeChoices,
  type ExportMaterial,
} from '../miniprogram/lib/pdf-export.ts'

const material = (date: string, kind: ExportMaterial['kind'] = 'daily', pages = 3, words = 8): ExportMaterial => ({
  kind,
  date,
  pages,
  words,
  label: `${date} ${kind}`,
})

const week = [material('2026-11-25'), material('2026-11-24'), material('2026-11-23', 'extend', 2, 10)]

test('from a material page: this one, the week, cards of the week, the checklist', () => {
  const choices = scopeChoices({ origin: 'material', selection: [material('2026-11-25')], week, initial: 'one' })
  assert.deepEqual(
    choices.map((choice) => [choice.id, choice.scope, choice.layout]),
    [
      ['one', 'material', true],
      ['week', 'material', true],
      ['cards', 'cards', false],
      ['checklist', 'checklist', false],
    ],
  )
  assert.equal(choices[1]?.hint, '3 份（含拓展）')
  assert.equal(choices[2]?.hint, '本周 26 个词 · 剪开对折')
  assert.equal(choices[3]?.hint, '到期和常忘的词 · 对折遮挡')
  assert.equal(choices[3]?.materials.length, 0)
})

test('from the home tiles: no 这份资料; without a week, only the checklist', () => {
  const home = scopeChoices({ origin: 'home', selection: [], week, initial: 'cards' })
  assert.deepEqual(
    home.map((choice) => choice.id),
    ['week', 'cards', 'checklist'],
  )
  assert.equal(initialChoice(home, 'cards')?.id, 'cards')
  const empty = scopeChoices({ origin: 'home', selection: [], week: [], initial: 'week' })
  assert.deepEqual(
    empty.map((choice) => choice.id),
    ['checklist'],
  )
  assert.equal(initialChoice(empty, 'week')?.id, 'checklist')
})

test('from a selection: merged, then cards and checklist of the selection', () => {
  const picked = [material('2026-11-20'), material('2026-11-18')]
  const choices = scopeChoices({ origin: 'selection', selection: picked, week, initial: 'selected' })
  assert.deepEqual(
    choices.map((choice) => [choice.id, choice.materials.length]),
    [
      ['selected', 2],
      ['cards', 2],
      ['checklist', 2],
    ],
  )
  assert.equal(choices[0]?.hint, '已选 2 份')
  assert.equal(choices[2]?.hint, '这些资料里 16 个词 · 对折遮挡')
  const one = scopeChoices({ origin: 'selection', selection: [material('2026-11-20')], week, initial: 'selected' })
  assert.equal(one[0]?.id, 'one')
})

test('the week is not offered twice when it is the selection itself', () => {
  const choices = scopeChoices({ origin: 'material', selection: [week[0] as ExportMaterial], week: [week[0] as ExportMaterial], initial: 'one' })
  assert.deepEqual(
    choices.map((choice) => choice.id),
    ['one', 'cards', 'checklist'],
  )
})

test('estimatePages per scope; 大字号 adds a quarter', () => {
  const [one, weekChoice, cards, checklist] = scopeChoices({ origin: 'material', selection: [material('2026-11-25')], week, initial: 'one' })
  assert.ok(one && weekChoice && cards && checklist)
  assert.equal(estimatePages(one, { large: false }), 3)
  assert.equal(estimatePages(weekChoice, { large: false }), 8)
  assert.equal(estimatePages(weekChoice, { large: true }), 10)
  assert.equal(estimatePages(cards, { large: false }), 5)
  assert.equal(estimatePages(checklist, { large: false }), 1)
})

test('exportRequest: materials only when chosen, layout only for material', () => {
  const [one, , cards, checklist] = scopeChoices({ origin: 'material', selection: [material('2026-11-25')], week, initial: 'one' })
  assert.ok(one && cards && checklist)
  assert.deepEqual(exportRequest(one, { layout: 'read', ipa: false, large: true }), {
    scope: 'material',
    materials: [{ kind: 'daily', date: '2026-11-25' }],
    layout: 'read',
    ipa: false,
    large: true,
  })
  assert.deepEqual(exportRequest(cards, DEFAULT_EXPORT_OPTIONS), {
    scope: 'cards',
    materials: week.map((m) => ({ kind: m.kind, date: m.date })),
    ipa: true,
    large: false,
  })
  assert.deepEqual(exportRequest(checklist, DEFAULT_EXPORT_OPTIONS), { scope: 'checklist', ipa: true, large: false })
})

test('defaultPdfName follows the server naming', () => {
  const one = [{ kind: 'daily' as const, date: '2026-11-25' }]
  const two = [
    { kind: 'daily' as const, date: '2026-11-25' },
    { kind: 'extend' as const, date: '2026-11-23' },
  ]
  const opts = { ipa: true, large: false }
  assert.equal(defaultPdfName({ scope: 'material', materials: one, ...opts }, '2026-11-26'), '学习资料_1125.pdf')
  assert.equal(defaultPdfName({ scope: 'material', materials: two, ...opts }, '2026-11-26'), '学习资料合集_1123-1125.pdf')
  assert.equal(defaultPdfName({ scope: 'cards', materials: two, ...opts }, '2026-11-26'), '单词卡_1125.pdf')
  assert.equal(defaultPdfName({ scope: 'checklist', ...opts }, '2026-11-26'), '自测清单_1126.pdf')
})

test('pdfFileName: UTF-8 extended names, plain names, unsafe ones fall back', () => {
  const fallback = '学习资料_1125.pdf'
  const encoded = `attachment; filename*=UTF-8''${encodeURIComponent('学习资料合集_1123-1125.pdf')}`
  assert.equal(pdfFileName(encoded, fallback), '学习资料合集_1123-1125.pdf')
  assert.equal(pdfFileName('attachment; filename="cards.pdf"', fallback), 'cards.pdf')
  assert.equal(pdfFileName(`attachment; filename*=UTF-8''${encodeURIComponent('../x.pdf')}`, fallback), fallback)
  assert.equal(pdfFileName('attachment; filename="notes.md"', fallback), fallback)
  assert.equal(pdfFileName("attachment; filename*=UTF-8''%E0%A4%A.pdf", fallback), fallback)
  assert.equal(pdfFileName(null, fallback), fallback)
})

test('readPdfPages and fileSummary', () => {
  assert.equal(readPdfPages('4'), 4)
  assert.equal(readPdfPages(' 12 '), 12)
  assert.equal(readPdfPages('0'), null)
  assert.equal(readPdfPages('four'), null)
  assert.equal(readPdfPages(null), null)
  assert.equal(fileSummary(3, '386 KB'), 'A4 · 3 页 · 386 KB · 保留 7 天')
  assert.equal(fileSummary(null, '1.0 MB'), 'A4 · 1.0 MB · 保留 7 天')
})

test('exportErrorText maps the contract codes; others are left to the general wording', () => {
  assert.equal(exportErrorText('RATE_LIMITED', { retryAfterSeconds: 1500 }), '每小时最多导出 10 次，请 25 分钟后再试')
  assert.equal(exportErrorText('RATE_LIMITED', null), '每小时最多导出 10 次，请稍后再试')
  assert.equal(exportErrorText('TOO_MANY_PAGES', { pages: 52 }), '超过 40 页（这次约 52 页）。少选几份，或关掉大字号再试。')
  assert.equal(exportErrorText('EXPORT_FAILED', undefined), '排版没有成功，请重试')
  assert.equal(exportErrorText('EXPORT_UNAVAILABLE', undefined), '服务器暂时不能生成 PDF')
  assert.equal(exportErrorText('NETWORK', undefined), null)
})
