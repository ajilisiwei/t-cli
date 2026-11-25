import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { cardsDocument, checklistDocument, materialDocument, type DocumentOptions } from '../src/modules/export/assemble.ts';
import { parseMaterial, type LoadedMaterial } from '../src/modules/export/content.ts';
import type { PdfDocument } from '../src/modules/export/document.ts';
import { createTypstRenderer } from '../src/modules/export/renderer.ts';
import { MATERIAL_PARTS } from '../src/modules/export/sections.ts';
import { INJECTION_STRINGS, prototypeDaily, prototypeExtend, skipWithoutTypst, TYPST_BIN, TYPST_FONT_PATH } from './helpers/exportFixtures.ts';
import { compactPdfText } from './helpers/pdfText.ts';

/**
 * The real templates through the real Typst (TYPST_BIN, TYPST_FONT_PATH;
 * skipped without them). Checks pages and printed text, and that Typst
 * markup inside the data is printed literally, never executed.
 */

const load = (kind: 'daily' | 'extend', date: string, content: Record<string, unknown>): LoadedMaterial => {
  const material = parseMaterial(kind, date, content);
  if (!material) throw new Error('fixture did not parse');
  return material;
};
const base: DocumentOptions = { layout: 'practice', ipa: true, large: false, today: '2026-11-25' };
const parts = new Set(MATERIAL_PARTS);
const compact = (text: string): string => text.replace(/\s+/g, '');

describe('PDF rendering with Typst', { skip: skipWithoutTypst }, () => {
  const renderer = createTypstRenderer({ bin: TYPST_BIN, fontPath: TYPST_FONT_PATH });
  const daily = () => load('daily', '2026-11-24', prototypeDaily());
  const extend = () => load('extend', '2026-11-23', prototypeExtend());
  const render = async (doc: PdfDocument) => {
    const result = await renderer.render(doc);
    return { ...result, text: compactPdfText(result.pdf) };
  };

  test('material, practice layout: the prototype in 3 pages, answers after the cut line', async () => {
    const { pages, pdf, text, renderMs } = await render(materialDocument([daily()], { ...base, parts, notes: new Map() }));
    assert.equal(pages, 3);
    assert.ok(pdf.byteLength < 200_000, `${pdf.byteLength} bytes`);
    assert.ok(renderMs < 5000, `${renderMs} ms`);
    for (const expected of ['每日资料·2026年11月24日', 't-cli学习·练习版', '一重点词', 'mitigate', '/ˈmɪtɪɡeɪt/', '二情景短文', 'AQuietMondayMeeting', '三练习', 'A.选词填空', '四易错提醒', '五自测清单', '可沿此线剪下，下面是答案', '短文大意', '第1页/共3页', '第3页/共3页']) {
      assert.ok(text.includes(expected), `missing ${expected}`);
    }
    const cut = text.indexOf('可沿此线剪下');
    assert.ok(cut > text.indexOf('五自测清单') && text.indexOf('短文大意') > cut, 'answers come last, after the cut line');
  });

  test('read layout, large type, IPA off', async () => {
    const read = await render(materialDocument([daily()], { ...base, layout: 'read', parts, notes: new Map() }));
    assert.ok(read.text.includes('t-cli学习·阅读版'));
    assert.ok(!read.text.includes('可沿此线剪下'), 'no cut line in the read layout');
    assert.ok(read.text.includes('中文大意'));

    const normal = await render(materialDocument([daily()], { ...base, parts, notes: new Map() }));
    const large = await render(materialDocument([daily()], { ...base, large: true, parts, notes: new Map() }));
    assert.ok(large.pages > normal.pages, `large ${large.pages} > normal ${normal.pages}`);

    const noIpa = await render(materialDocument([daily()], { ...base, ipa: false, parts, notes: new Map() }));
    assert.ok(!noIpa.text.includes('/ˈmɪtɪɡeɪt/'));
    assert.ok(noIpa.text.includes('mitigate'));
  });

  test('cards: 6 per page; checklist: one page with the fold header', async () => {
    const cards = await render(cardsDocument([daily(), extend()], base));
    assert.equal(cards.pages, 3, '14 cards');
    assert.ok(cards.text.includes('实线剪开') && cards.text.includes('虚线向后对折'));
    assert.ok(cards.text.includes('stakeholder'));

    const checklist = await render(checklistDocument({ from: 'materials', materials: [daily(), extend()] }, base));
    assert.equal(checklist.pages, 1);
    assert.ok(checklist.text.includes('第1·2·3遍'));
    const empty = await render(checklistDocument({ from: 'units', rows: [] }, base));
    assert.equal(empty.pages, 1);
    assert.ok(empty.text.includes('今天没有到期或常忘的词'));
  });

  test('Typst markup in the data is printed as text, never executed', async () => {
    const values = Object.values(INJECTION_STRINGS);
    const [setPage, evalCall, markup, escapes, readFile] = values as [string, string, string, string, string];
    const content = prototypeDaily();
    const words = content.words as Record<string, unknown>[];
    const injected = {
      ...content,
      words: [
        {
          ...words[0],
          headword: setPage,
          ipa: '/#set text(fill: red)/',
          meanings: [{ pos: 'v.', zh: evalCall }],
          examples: [{ en: markup, zh: escapes, fromUser: false }, { en: readFile, zh: '读文件', fromUser: false }],
        },
        ...words.slice(1),
      ],
      story: { title: evalCall, text: `${setPage} then ${markup}\n${escapes}`, words: [], zh: readFile },
      mistakes: [{ itemId: 'm1', display: markup, note: setPage, example: { en: evalCall, zh: escapes } }],
    };
    const doc = materialDocument([load('daily', '2026-11-24', injected)], { ...base, layout: 'read', parts, notes: new Map() });
    const { pdf, text } = await render(doc);
    for (const value of [...values, '/#set text(fill: red)/']) {
      assert.ok(text.includes(compact(value)), `printed literally: ${value}`);
    }
    // Nothing was executed: no red anywhere in the drawing operators, no file read.
    const streams = pdf.toString('latin1');
    assert.ok(!/1 0\.2549\d* 0\.2117\d* (scn|rg|sc)/.test(inflateAll(streams)), 'no red fill (Typst red is #ff4136)');
    assert.ok(!text.includes('root:'), 'no file content');

    const cards = await render(cardsDocument([load('daily', '2026-11-24', injected)], base));
    assert.ok(cards.text.includes(compact(setPage)) && cards.text.includes(compact(evalCall)));
    const checklist = await render(checklistDocument({ from: 'units', rows: [{ term: setPage, ipa: '', gloss: evalCall }] }, base));
    assert.ok(checklist.text.includes(compact(setPage)) && checklist.text.includes(compact(evalCall)));
  });
});

/** Every Flate stream of a PDF, inflated and concatenated (for operator checks). */
function inflateAll(pdf: string): string {
  const out: string[] = [];
  const re = /\/Length\s+(\d+)[^]*?>>\s*stream\r?\n/g;
  for (let match = re.exec(pdf); match; match = re.exec(pdf)) {
    const start = match.index + match[0].length;
    const raw = Buffer.from(pdf.slice(start, start + Number(match[1])), 'latin1');
    try {
      out.push(inflateSync(raw).toString('latin1'));
    } catch {
      // Not a Flate stream.
    }
    re.lastIndex = start + Number(match[1]);
  }
  return out.join('\n');
}
