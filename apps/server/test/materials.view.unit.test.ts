import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { estimatePages, PAGE_LINES } from '../src/modules/library/materialPages.ts';
import { reasonRangeOf, reasonUnitIds } from '../src/modules/library/materialReasons.ts';
import { countsOf, exercisesOf, extendItemsOf, practicableOf, subtitleOf, titleOf, toListItem } from '../src/modules/library/materialView.ts';
import type { MaterialKind, MaterialRow } from '../src/modules/library/materials.ts';
import { cannedGrammar, cannedPhrase, cannedWord } from './helpers/pipeline.ts';
import { extendMaterial } from './helpers/learning.ts';

const row = (kind: MaterialKind, content: Record<string, unknown>): MaterialRow => ({
  kind,
  date: '2026-11-23',
  content,
  createdAt: new Date('2026-11-23T22:00:00Z'),
  readAt: null,
});

const words = (n: number) => Array.from({ length: n }, (_, i) => ({ itemId: `w${i}`, ...cannedWord(`word${i}`) }));
const story = { title: 'T', text: 'A story about word0.', words: ['word0'], zh: '故事。' };

describe('material views (pure)', () => {
  test('daily titles: the main count, a story, or the mistakes; zh and en', () => {
    const title = (content: Record<string, unknown>, lang: 'zh' | 'en') => {
      const r = row('daily', content);
      return titleOf(r, countsOf(r, exercisesOf(r)), lang);
    };
    assert.equal(title({ words: words(9), story }, 'zh'), '9 个词和一篇短文');
    assert.equal(title({ words: words(1), story }, 'en'), '1 word and a short story');
    assert.equal(title({ words: [], phrases: [{ itemId: 'p', ...cannedPhrase('look after') }], story: null }, 'zh'), '1 个词组');
    assert.equal(title({ grammar: [{ itemId: 'g', ...cannedGrammar('冠词') }, { itemId: 'h', ...cannedGrammar('时态') }] }, 'en'), '2 grammar points');
    assert.equal(title({ story }, 'zh'), '一篇短文');
    assert.equal(title({ mistakes: [{}, {}] }, 'zh'), '2 个易错点');
    assert.equal(title({}, 'zh'), '今日回顾');
    assert.equal(title({}, 'en'), 'Daily review');
  });

  test('digest, weekly and extend titles', () => {
    const digest = (content: Record<string, unknown>, lang: 'zh' | 'en') => {
      const r = row('digest', content);
      return titleOf(r, countsOf(r, exercisesOf(r)), lang);
    };
    assert.equal(digest({ words: words(18), story }, 'zh'), '7 天合集：18 个词');
    assert.equal(digest({ words: words(2) }, 'en'), '7-day digest: 2 words');
    assert.equal(digest({ review: [{}, {}, {}] }, 'zh'), '7 天合集：回顾 3 个忘过的');
    assert.equal(digest({ review: [{}] }, 'en'), '7-day digest: 1 item to revisit');
    assert.equal(digest({}, 'zh'), '7 天合集');

    const weekly = (content: Record<string, unknown>, lang: 'zh' | 'en') => titleOf(row('weekly', content), countsOf(row('weekly', content), null), lang);
    assert.equal(weekly({ totals: { entries: 3, reviews: 126 }, retention: { thisWeek: 0.824 } }, 'zh'), '复习 126 次，记住 82%');
    assert.equal(weekly({ totals: { entries: 3, reviews: 1 }, retention: { thisWeek: null } }, 'en'), '1 review');
    assert.equal(weekly({ totals: { entries: 5, reviews: 0 }, retention: { thisWeek: null } }, 'zh'), '本周 5 条记录');
    assert.equal(weekly({}, 'en'), '0 records this week');

    const extend = row('extend', extendMaterial());
    assert.equal(titleOf(extend, countsOf(extend, null), 'en'), '出差旅行常用表达');
    assert.equal(titleOf(row('extend', {}), countsOf(row('extend', {}), null), 'zh'), '拓展资料');
  });

  test('stored content is read defensively: malformed entries never reach exercisesFor', () => {
    const content = {
      words: [...words(2), { itemId: 'bad', headword: 'bad' }, 'junk', null],
      phrases: { not: 'an array' },
      grammar: [{ itemId: 'g', ...cannedGrammar('冠词') }, { itemId: 'g2', exercises: [{ wrong: 1 }] }],
    };
    const practicable = practicableOf(content);
    assert.deepEqual(practicable.words.map((word) => word.itemId), ['w0', 'w1']);
    assert.deepEqual(practicable.phrases, []);
    assert.deepEqual(practicable.grammar.map((point) => point.itemId), ['g']);
    const item = toListItem(row('daily', content), 'zh');
    assert.equal(item.counts.words, 5, 'counts are the stored lengths');
    assert.ok(item.counts.exercises > 0);
    assert.deepEqual(toListItem(row('daily', { words: 'x' }), 'en').counts, { words: 0, phrases: 0, grammar: 0, exercises: 0, items: 0 });
  });

  test('extension items as (type, text); unusable entries are null', () => {
    assert.deepEqual(extendItemsOf({ items: [{ kind: 'word', text: 'layover' }, { kind: 'idiom', text: 'x' }, { kind: 'phrase', text: ' ' }, 3] }), [
      { type: 'word', text: 'layover' },
      null,
      null,
      null,
    ]);
    assert.deepEqual(extendItemsOf({}), []);
  });

  test('pages: at least 1, grow with the content, 0 for weekly', () => {
    assert.equal(estimatePages('weekly', { totals: {} }, null), 0);
    assert.equal(estimatePages('daily', {}, null), 1);
    const small = row('daily', { words: words(2) });
    const large = row('digest', { words: words(20), story: { ...story, text: 'word '.repeat(300) } });
    const smallPages = estimatePages('daily', small.content, exercisesOf(small));
    const largePages = estimatePages('digest', large.content, exercisesOf(large));
    assert.equal(smallPages, 1);
    assert.ok(largePages > smallPages, `${largePages} > ${smallPages}`);
    assert.ok(largePages >= Math.ceil((20 * 6) / PAGE_LINES));
    assert.ok(estimatePages('extend', extendMaterial(), null) >= 1);
  });

  test("subtitle: an extension's first non-empty reason, else null; null for the other kinds", () => {
    assert.equal(subtitleOf(row('extend', extendMaterial())), '最近 14 天你查了 airport、flight 等 3 个旅行用词');
    assert.equal(subtitleOf(row('extend', { reasons: ['  ', 3, ' 第二条 '] })), '第二条');
    assert.equal(subtitleOf(row('extend', { reasons: 'x' })), null);
    assert.equal(subtitleOf(row('extend', {})), null);
    assert.equal(subtitleOf(row('daily', { reasons: ['not for a daily'] })), null);
    assert.equal(toListItem(row('extend', extendMaterial()), 'en').subtitle, '最近 14 天你查了 airport、flight 等 3 个旅行用词');
    assert.equal(toListItem(row('weekly', {}), 'zh').subtitle, null);
  });

  test("reason ranges: a daily material's local day; a digest's stored range, else the 7 days ending on its date", () => {
    const iso = (range: { start: Date; end: Date }) => [range.start.toISOString(), range.end.toISOString()];
    assert.deepEqual(iso(reasonRangeOf(row('daily', {}), 480)), ['2026-11-22T16:00:00.000Z', '2026-11-23T16:00:00.000Z']);
    assert.deepEqual(iso(reasonRangeOf(row('daily', {}), -300)), ['2026-11-23T05:00:00.000Z', '2026-11-24T05:00:00.000Z']);
    const digest = (range: unknown) => row('digest', { range });
    assert.deepEqual(iso(reasonRangeOf(digest({ start: '2026-11-17', end: '2026-11-23' }), 480)), ['2026-11-16T16:00:00.000Z', '2026-11-23T16:00:00.000Z']);
    assert.deepEqual(iso(reasonRangeOf(digest({ start: '2026-11-20', end: '2026-11-23' }), 0)), ['2026-11-20T00:00:00.000Z', '2026-11-24T00:00:00.000Z']);
    for (const bad of [null, {}, { start: '2026-11-23', end: '2026-11-17' }, { start: '2025-01-01', end: '2026-11-23' }, { start: 'x', end: '2026-11-23' }]) {
      assert.deepEqual(iso(reasonRangeOf(digest(bad), 480)), ['2026-11-16T16:00:00.000Z', '2026-11-23T16:00:00.000Z'], JSON.stringify(bad));
    }
  });

  test('reason units: the item ids of words and phrases, each once; malformed entries skipped', () => {
    assert.deepEqual(
      reasonUnitIds({
        words: [{ itemId: 'w1' }, { itemId: 'w2' }, { itemId: '' }, { itemId: 3 }, 'junk', null, { itemId: 'w1' }],
        phrases: [{ itemId: 'p1' }, { itemId: 'w2' }],
        grammar: [{ itemId: 'g1' }],
      }),
      ['w1', 'w2', 'p1'],
    );
    assert.deepEqual(reasonUnitIds({ words: 'x', phrases: { a: 1 } }), []);
  });
});
