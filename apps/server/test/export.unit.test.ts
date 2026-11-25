import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cardsDocument, checklistDocument, materialDocument, type DocumentOptions } from '../src/modules/export/assemble.ts';
import { parseMaterial, type LoadedMaterial } from '../src/modules/export/content.ts';
import type { Block, PdfDocument } from '../src/modules/export/document.ts';
import { contentDisposition, exportFileName } from '../src/modules/export/filename.ts';
import { cnNumeral, dateRangeLabel, isoWeek } from '../src/modules/export/format.ts';
import { countPdfPages } from '../src/modules/export/pdfPages.ts';
import { PdfExportBody } from '../src/modules/export/request.ts';
import { MATERIAL_PARTS, noteFor, type MaterialPart, type WordNote } from '../src/modules/export/sections.ts';
import { storySegments } from '../src/modules/export/story.ts';
import { prototypeDaily, prototypeDigest, prototypeExtend } from './helpers/exportFixtures.ts';

const load = (kind: 'daily' | 'digest' | 'extend', date: string, content: Record<string, unknown>): LoadedMaterial => {
  const material = parseMaterial(kind, date, content);
  if (!material) throw new Error('fixture did not parse');
  return material;
};
const daily = () => load('daily', '2026-11-24', prototypeDaily());
const digest = () => load('digest', '2026-11-24', prototypeDigest());
const extend = () => load('extend', '2026-11-23', prototypeExtend());

const base: DocumentOptions = { layout: 'practice', ipa: true, large: false, today: '2026-11-25' };
const allParts: ReadonlySet<MaterialPart> = new Set(MATERIAL_PARTS);
const material = (materials: LoadedMaterial[], options: Partial<DocumentOptions> & { parts?: ReadonlySet<MaterialPart>; notes?: Map<string, WordNote> } = {}): PdfDocument =>
  materialDocument(materials, { ...base, parts: allParts, notes: new Map(), ...options });
const blocksOf = (doc: PdfDocument, index = 0): Block[] => doc.sections[index]?.blocks ?? [];
const block = <K extends Block['kind']>(doc: PdfDocument, kind: K, index = 0): Extract<Block, { kind: K }> | undefined =>
  blocksOf(doc, index).find((b): b is Extract<Block, { kind: K }> => b.kind === kind);

describe('export request validation', () => {
  test('defaults: practice layout, IPA on, normal size, offset 480', () => {
    const body = PdfExportBody.parse({ scope: 'material', materials: [{ kind: 'daily', date: '2026-11-24' }] });
    assert.deepEqual(body, { scope: 'material', materials: [{ kind: 'daily', date: '2026-11-24' }], layout: 'practice', ipa: true, large: false, utcOffsetMinutes: 480 });
    assert.equal(PdfExportBody.parse({ scope: 'checklist' }).materials, undefined, 'checklist needs no materials');
  });

  test('refuses what the contract does not allow', () => {
    const ref = { kind: 'daily', date: '2026-11-24' };
    const bad: unknown[] = [
      {},
      { scope: 'notebook', materials: [ref] },
      { scope: 'material' },
      { scope: 'cards' },
      { scope: 'material', materials: [] },
      { scope: 'material', materials: Array.from({ length: 9 }, (_, i) => ({ kind: 'daily', date: `2026-11-${10 + i}` })) },
      { scope: 'material', materials: [{ kind: 'weekly', date: '2026-11-23' }] },
      { scope: 'material', materials: [{ kind: 'daily', date: '2026-02-30' }] },
      { scope: 'material', materials: [ref, ref] },
      { scope: 'material', materials: [ref], layout: 'print' },
      { scope: 'material', materials: [ref], ipa: 'yes' },
      { scope: 'material', materials: [ref], large: 1 },
      { scope: 'checklist', utcOffsetMinutes: 900 },
    ];
    for (const body of bad) assert.equal(PdfExportBody.safeParse(body).success, false, JSON.stringify(body));
  });
});

describe('export file names', () => {
  test('one material, a collection, cards and checklists', () => {
    assert.equal(exportFileName('material', ['2026-11-24'], '2026-11-25'), '学习资料_1124.pdf');
    assert.equal(exportFileName('material', ['2026-11-24', '2026-11-18', '2026-11-23'], '2026-11-25'), '学习资料合集_1118-1124.pdf');
    assert.equal(exportFileName('material', ['2026-11-24', '2026-11-24'], '2026-11-25'), '学习资料合集_1124-1124.pdf', 'a collection always names its range');
    assert.equal(exportFileName('cards', ['2026-11-24'], '2026-11-25'), '单词卡_1124.pdf');
    assert.equal(exportFileName('cards', ['2026-11-24', '2026-11-23'], '2026-11-25'), '单词卡_1123-1124.pdf');
    assert.equal(exportFileName('checklist', [], '2026-11-25'), '自测清单_1125.pdf', 'no materials: today');
    assert.equal(exportFileName('checklist', ['2026-01-05'], '2026-11-25'), '自测清单_0105.pdf');
  });

  test('Content-Disposition carries the UTF-8 name, percent-encoded (RFC 5987)', () => {
    assert.equal(contentDisposition('学习资料_1124.pdf'), "attachment; filename*=UTF-8''%E5%AD%A6%E4%B9%A0%E8%B5%84%E6%96%99_1124.pdf");
    assert.equal(decodeURIComponent(contentDisposition('单词卡_1123-1124.pdf').split("''")[1] ?? ''), '单词卡_1123-1124.pdf');
    assert.match(contentDisposition("a'(b)*.pdf"), /a%27%28b%29%2A\.pdf$/);
  });
});

describe('export text helpers', () => {
  test('ISO weeks, Chinese numerals, date ranges', () => {
    assert.equal(isoWeek('2026-11-24'), 48);
    assert.equal(isoWeek('2026-01-01'), 1);
    assert.equal(isoWeek('2027-01-01'), 53, '2026 has 53 ISO weeks');
    assert.deepEqual([1, 5, 10, 12, 20, 25].map(cnNumeral), ['一', '五', '十', '十二', '二十', '二十五']);
    assert.equal(dateRangeLabel(['2026-11-24']), '11月24日');
    assert.equal(dateRangeLabel(['2026-11-24', '2026-11-18', '2026-11-24']), '11月18日–11月24日');
  });

  test('story runs: the first occurrence of each word (any inflection) is bold, the text is unchanged', () => {
    const paragraphs = storySegments('They postponed it.\n\nThe deadline moved, and the deadline hurt.', ['postpone', 'deadline', 'absent']);
    assert.deepEqual(paragraphs, [
      [{ t: 'They ', b: false }, { t: 'postponed', b: true }, { t: ' it.', b: false }],
      [{ t: 'The ', b: false }, { t: 'deadline', b: true }, { t: ' moved, and the deadline hurt.', b: false }],
    ]);
  });

  test('word notes: forgotten, then stars, then lookups', () => {
    assert.equal(noteFor({ stars: 3, lookupCount: 4, lapses: 2 }), '复习时忘了 2 次');
    assert.equal(noteFor({ stars: 3, lookupCount: 4, lapses: 0 }), '笔记本 · 3 星');
    assert.equal(noteFor({ stars: 0, lookupCount: 4, lapses: 0 }), '查过 4 次');
    assert.equal(noteFor({ stars: 0, lookupCount: 0, lapses: 0 }), '');
    assert.equal(noteFor(undefined), '');
  });

  test('PDF page count', () => {
    const pdf = (body: string) => Buffer.from(`%PDF-1.7\n${body}`, 'latin1');
    assert.equal(countPdfPages(pdf('1 0 obj << /Type /Pages /Count 2 >> 2 0 obj << /Type /Page >> 3 0 obj <</Type/Page/Parent 1 0 R>>')), 2);
    assert.equal(countPdfPages(pdf('<< /Type /Pages /Count 0 >>')), null);
    assert.equal(countPdfPages(Buffer.from('<html>')), null);
  });
});

describe('material document (practice)', () => {
  const doc = material([daily()], { notes: new Map([['w1', { stars: 0, lookupCount: 1, lapses: 2 }], ['w2', { stars: 3, lookupCount: 1, lapses: 0 }]]) });

  test('head, stats and the prototype order of sections, numbered 一 … 五', () => {
    const section = doc.sections[0]!;
    assert.equal(section.kicker, '每日资料 · 第 48 周');
    assert.equal(section.title, '8 个词和一篇短文');
    assert.equal(section.subtitle, '根据 11月24日 的记录整理 · 已连续学习 5 天');
    assert.deepEqual(section.stats, [
      { value: 6, label: '新词' },
      { value: 2, label: '词组' },
      { value: 2, label: '易错' },
      { value: 15, label: '练习题' },
    ]);
    assert.deepEqual(
      section.blocks.map((b) => [b.num, b.kind, b.title]),
      [
        ['一', 'words', '重点词'],
        ['二', 'story', '情景短文'],
        ['三', 'exercises', '练习'],
        ['四', 'mistakes', '易错提醒'],
        ['五', 'checklist', '自测清单'],
      ],
    );
    assert.deepEqual(doc.header, { left: '每日资料 · 2026年11月24日', right: 't-cli 学习 · 练习版' });
    assert.equal(doc.title, '8 个词和一篇短文');
  });

  test('word rows: IPA, why, gloss, and an example the exercises do not use', () => {
    const words = block(doc, 'words')!;
    const mitigate = words.rows[0]!;
    assert.deepEqual(mitigate, {
      term: 'mitigate',
      ipa: '/ˈmɪtɪɡeɪt/',
      note: '复习时忘了 2 次',
      gloss: 'v. 减轻；缓和',
      example: 'Wearing a helmet can mitigate the damage in an accident.',
      exampleZh: '',
    });
    assert.equal(words.rows[1]!.note, '笔记本 · 3 星');
    assert.equal(words.rows[6]!.term, 'circle back');
    assert.equal(words.rows[6]!.ipa, '', 'phrases have no IPA');
    const cloze = block(doc, 'exercises')!.groups[0]!;
    assert.ok(cloze.kind === 'cloze' && cloze.items[0]!.before === 'We added a backup server to ', 'the cloze took the first example');
  });

  test('story: key words and phrases bold, the translation only in the answers', () => {
    const story = block(doc, 'story')!;
    assert.equal(story.zh, null);
    const bold = story.paragraphs.flat().filter((run) => run.b).map((run) => run.t);
    assert.deepEqual(bold, ['deadline', 'concise', 'meticulous', 'mitigate', 'solve', 'postpone', 'circle back', 'follow up on']);
    assert.equal(story.paragraphs.length, 3);
  });

  test('exercises leave the answers out; the answers come last, lettered', () => {
    const groups = block(doc, 'exercises')!.groups;
    assert.deepEqual(groups.map((g) => g.label), ['A. 选词填空', 'B. 中译英', 'C. 改错']);
    for (const group of groups) {
      for (const item of group.items) assert.equal(item.answer, null);
    }
    assert.equal(doc.answers.length, 1);
    assert.equal(doc.answers[0]!.heading, null, 'one material: no heading');
    assert.deepEqual(doc.answers[0]!.lines.map((line) => line.label), ['A.', 'B.', 'C.', '短文大意']);
    assert.match(doc.answers[0]!.lines[0]!.text, /^1 mitigate　2 concise/);
    assert.match(doc.answers[0]!.lines[1]!.text, /^1\. /);
  });

  test('mistakes: grammar points from corrections and units often forgotten; checklist of words and phrases', () => {
    const mistakes = block(doc, 'mistakes')!;
    assert.equal(mistakes.aside, '来自你的纠错');
    assert.deepEqual(mistakes.pairs[0], { title: '一般过去时', wrong: 'I have sent it yesterday.', right: 'I sent it yesterday.', note: '有 yesterday 这类明确的过去时间，用一般过去时。' });
    assert.deepEqual(mistakes.recaps.map((r) => r.term), ['allocate']);
    const checklist = block(doc, 'checklist')!;
    assert.equal(checklist.rows.length, 8);
    assert.deepEqual(checklist.rows[0], { term: 'mitigate', ipa: '/ˈmɪtɪɡeɪt/', gloss: 'v. 减轻；缓和' });
  });
});

describe('material document (read layout, options, parts)', () => {
  test('read: answers in place, translations shown, no checklist and no answers section', () => {
    const doc = material([daily()], { layout: 'read' });
    assert.equal(doc.header.right, 't-cli 学习 · 阅读版');
    assert.deepEqual(blocksOf(doc).map((b) => b.kind), ['words', 'story', 'exercises', 'mistakes']);
    assert.equal(doc.answers.length, 0);
    assert.ok(block(doc, 'story')!.zh?.startsWith('团队的截止日期很紧'));
    assert.equal(block(doc, 'words')!.rows[0]!.exampleZh, '戴头盔可以减轻事故中的伤害。');
    const cloze = block(doc, 'exercises')!.groups[0]!;
    assert.equal(cloze.kind === 'cloze' ? cloze.items[0]!.answer : null, 'mitigate');
  });

  test('ipa off removes every IPA', () => {
    const doc = material([daily()], { ipa: false });
    assert.ok(block(doc, 'words')!.rows.every((row) => row.ipa === ''));
    assert.ok(block(doc, 'checklist')!.rows.every((row) => row.ipa === ''));
    assert.equal(doc.options.ipa, false);
  });

  test('materialParts: only the listed parts are shown, numbering stays continuous', () => {
    const doc = material([daily()], { parts: new Set<MaterialPart>(['phrases', 'grammar']) });
    assert.deepEqual(blocksOf(doc).map((b) => [b.num, b.kind]), [
      ['一', 'words'],
      ['二', 'mistakes'],
      ['三', 'checklist'],
    ]);
    assert.deepEqual(block(doc, 'words')!.rows.map((row) => row.term), ['circle back', 'follow up on']);
    assert.deepEqual(doc.sections[0]!.stats.map((stat) => stat.label), ['词组', '易错']);
    assert.deepEqual(doc.answers, [], 'no exercises and no story: nothing to answer');
    assert.equal(doc.sections[0]!.title, '2 个词');
  });

  test('a collection: one section per material in order, answers grouped with headings', () => {
    const doc = material([daily(), extend()]);
    assert.equal(doc.sections.length, 2);
    assert.equal(doc.header.left, '学习资料合集 · 11月23日–11月24日');
    assert.equal(doc.title, '学习资料合集');
    assert.deepEqual(doc.answers.map((group) => group.heading), ['11月24日 每日资料 · 8 个词和一篇短文', '11月23日 拓展资料 · 开会和跟进的常用说法']);
  });

  test('digest: range kicker and the units forgotten that week', () => {
    const doc = material([digest()]);
    const section = doc.sections[0]!;
    assert.equal(section.kicker, '7 天合集 · 11月18日–11月24日');
    assert.equal(section.title, '7 天合集：8 个词');
    const mistakes = block(doc, 'mistakes')!;
    assert.equal(mistakes.recapTitle, '复习时忘过的');
    assert.deepEqual(mistakes.recaps.map((r) => [r.term, r.note]).slice(1), [
      ['reluctant', '这 7 天忘了 3 次 · adj. 不情愿的'],
      ['feasible', '这 7 天忘了 2 次 · adj. 可行的'],
    ]);
  });

  test('extend: reasons, vocabulary, passage, grammar as a fix exercise in practice', () => {
    const doc = material([extend()]);
    const section = doc.sections[0]!;
    assert.equal(section.kicker, '拓展资料 · 职场 · B1');
    assert.equal(section.reasons.length, 2);
    assert.deepEqual(section.blocks.map((b) => b.kind), ['words', 'story', 'grammar', 'exercises', 'checklist']);
    assert.deepEqual(block(doc, 'grammar')!.pairs, [], 'practice: the right forms are answers');
    assert.deepEqual(doc.answers[0]!.lines.map((line) => line.label), ['A.', '短文大意']);
    const read = material([extend()], { layout: 'read' });
    assert.equal(block(read, 'grammar')!.pairs.length, 2);
    assert.deepEqual(blocksOf(read).map((b) => b.kind), ['words', 'story', 'grammar']);
  });

  test('broken stored elements are dropped, not fatal', () => {
    const content = { ...prototypeDaily(), words: [{ itemId: 'x', headword: 'broken' }, ...(prototypeDaily().words as unknown[]).slice(0, 1)], story: 'not an object', grammar: 'nope' };
    const doc = material([load('daily', '2026-11-24', content)]);
    assert.deepEqual(block(doc, 'words')!.rows.map((row) => row.term), ['mitigate', 'circle back', 'follow up on']);
    assert.equal(block(doc, 'story'), undefined);
    assert.equal(parseMaterial('daily', '2026-11-24', null), null);
    assert.equal(parseMaterial('daily', '2026-11-24', [1, 2]), null);
  });
});

describe('cards and checklist documents', () => {
  test('cards: words, phrases and extension items, each term once', () => {
    const doc = cardsDocument([daily(), digest(), extend()], base);
    assert.equal(doc.cards.length, 14, '8 + 6; the digest repeats the daily words');
    assert.deepEqual(doc.cards[0], {
      term: 'mitigate',
      ipa: '/ˈmɪtɪɡeɪt/',
      gloss: 'v. 减轻；缓和',
      example: 'We added a backup server to mitigate the risk.',
      zh: '我们加了一台备用服务器来降低风险。',
    });
    assert.equal(doc.header.left, '单词卡 · 11月23日–11月24日');
    assert.equal(doc.empty, '');
    assert.ok(cardsDocument([daily()], { ...base, ipa: false }).cards.every((card) => card.ipa === ''));
    const empty = cardsDocument([load('daily', '2026-11-24', { ...prototypeDaily(), words: [], phrases: [] })], base);
    assert.equal(empty.cards.length, 0);
    assert.notEqual(empty.empty, '');
  });

  test('checklist from materials or from units', () => {
    const fromMaterials = checklistDocument({ from: 'materials', materials: [daily(), extend()] }, base);
    assert.equal(fromMaterials.checklist.rows.length, 14);
    assert.equal(fromMaterials.checklist.subtitle, '11月23日–11月24日 资料里的 14 个词和词组');
    const fromUnits = checklistDocument({ from: 'units', rows: [{ term: 'feasible', ipa: '/ˈfiːzəbl/', gloss: 'adj. 可行的' }] }, { ...base, ipa: false });
    assert.deepEqual(fromUnits.checklist.rows, [{ term: 'feasible', ipa: '', gloss: 'adj. 可行的' }]);
    assert.equal(fromUnits.header.left, '自测清单 · 11月25日');
    const none = checklistDocument({ from: 'units', rows: [] }, base);
    assert.equal(none.checklist.rows.length, 0);
    assert.match(none.empty, /没有到期/);
  });
});
