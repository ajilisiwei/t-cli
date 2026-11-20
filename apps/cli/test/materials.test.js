// Terminal text for cloud materials (utils/materials.js) and the merged
// /history view with phone records (utils/historyMerge.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDailyMaterial, formatWeeklyReport, percent, weekStartOf } from '../src/utils/materials.js';
import { mergeDayHistory, phoneEntries } from '../src/utils/historyMerge.js';
import { formatHistoryHeader } from '../src/utils/historyParser.js';

const DAILY = {
  date: '2026-11-19',
  overview: { newWords: 2, newPhrases: 1, corrections: 1, streakDays: 3 },
  words: [{
    itemId: 'i1', headword: 'meticulous', ipa: 'məˈtɪkjələs',
    meanings: [{ pos: 'adj.', zh: '一丝不苟的' }, { pos: 'adj.', zh: '细致的' }],
    examples: [{ en: 'She is meticulous.', zh: '她一丝不苟。', fromUser: true }, { en: 'A meticulous plan.', zh: '周密的计划。', fromUser: false }],
    collocations: ['meticulous care'], synonyms: [{ word: 'thorough', note: 'more general' }], family: ['meticulously'],
  }],
  phrases: [{
    itemId: 'p1', phrase: 'take into account', zh: '考虑到', register: 'neutral',
    alternatives: [{ en: 'factor in', note: 'casual' }], examples: [{ en: 'Take cost into account.', zh: '考虑成本。', fromUser: false }],
  }],
  grammar: [{
    itemId: 'g1', title: 'Subject–verb agreement', rule: 'Third person singular takes -s.',
    wrong: 'He go home.', right: 'He goes home.', exercises: [{ wrong: 'She like tea.', right: 'She likes tea.' }],
  }],
  story: { title: 'A careful day', text: 'Tom was meticulous.', words: ['meticulous'], zh: '汤姆一丝不苟。' },
  mistakes: [{ itemId: 'g1', display: 'he go', note: 'use goes', example: { en: 'He goes.', zh: '他去。' } }],
};

test('formatDailyMaterial: title, overview and every section', () => {
  const blocks = formatDailyMaterial({ date: '2026-11-19', content: DAILY });
  assert.deepEqual(blocks.filter((b) => b.bold).map((b) => b.text), [
    'Daily material · 2026-11-19', 'Words (1)', 'Phrases (1)', 'Grammar (1)', 'Story · A careful day', 'Mistakes to watch (1)',
  ]);
  assert.equal(blocks[1].text, 'New words 2 · new phrases 1 · corrections 1 · streak 3 days');
  const text = blocks.map((b) => b.text).join('\n');
  assert.ok(text.includes('• meticulous  /məˈtɪkjələs/\n  adj. 一丝不苟的；adj. 细致的\n  e.g. She is meticulous.  (from your records)\n       她一丝不苟。'));
  assert.ok(text.includes('  Collocations: meticulous care\n  Synonyms: thorough — more general\n  Word family: meticulously'));
  assert.ok(text.includes('• take into account  [neutral]\n  考虑到\n  Alternatives: factor in — casual'));
  assert.ok(text.includes('  ✗ He go home.\n  ✓ He goes home.\n  Practice:\n    1. She like tea.  →  She likes tea.'));
  assert.ok(text.includes('  Tom was meticulous.\n\n  汤姆一丝不苟。\n\n  Words: meticulous'));
  assert.ok(text.includes('• he go — use goes\n  e.g. He goes.\n       他去。'));
});

test('formatDailyMaterial: tolerates missing and mistyped fields', () => {
  const blocks = formatDailyMaterial({ date: '2026-11-19', content: { words: [{ headword: 'x' }, { nope: 1 }, 'bad'], story: null, overview: { newWords: 'two' } } });
  assert.deepEqual(blocks.map((b) => b.text), ['Daily material · 2026-11-19', 'Words (1)', '• x']);
  const empty = formatDailyMaterial({ date: '2026-11-19', content: {} });
  assert.deepEqual(empty.map((b) => b.text), ['Daily material · 2026-11-19', 'This material has no items.']);
  assert.doesNotThrow(() => formatDailyMaterial({ date: 'd', content: null }));
});

test('formatWeeklyReport: totals, retention, top lists, summary', () => {
  const blocks = formatWeeklyReport({
    date: '2026-11-09',
    content: {
      weekStart: '2026-11-09', weekEnd: '2026-11-15',
      totals: { entries: 120, newItems: 34, reviews: 210 },
      topErrors: [{ title: 'Articles', count: 4 }, { title: 'Tenses', count: 2 }],
      topLookups: [{ display: 'meticulous', count: 5 }, { display: 'prioritize', count: 3 }],
      retention: { thisWeek: 0.857, lastWeek: null },
      summary: 'Steady progress.',
    },
  });
  assert.deepEqual(blocks.map((b) => b.text), [
    'Weekly report · 2026-11-09 – 2026-11-15',
    'Records 120 · new items 34 · reviews 210',
    'Retention (remembered share of reviews): this week 86% · last week —',
    'Most frequent mistakes',
    '  1. Articles ×4\n  2. Tenses ×2',
    'Most looked up',
    '  meticulous ×5 · prioritize ×3',
    'Summary',
    '  Steady progress.',
  ]);
  const sparse = formatWeeklyReport({ date: '2026-11-09', content: {} });
  assert.equal(sparse[0].text, 'Weekly report · week of 2026-11-09');
});

test('percent and weekStartOf', () => {
  assert.equal(percent(0.5), '50%');
  assert.equal(percent(1), '100%');
  assert.equal(percent(null), '—');
  assert.equal(weekStartOf('2026-11-15'), '2026-11-09'); // Sunday → Monday before
  assert.equal(weekStartOf('2026-11-09'), '2026-11-09'); // Monday
  assert.equal(weekStartOf('2026-11-12'), '2026-11-09');
  assert.equal(weekStartOf('2026-01-01'), '2025-12-29'); // across a year
  assert.equal(weekStartOf('2026-02-31'), null);
  assert.equal(weekStartOf('soon'), null);
});

// ---------------------------------------------------------------- history merge

const LOCAL = [
  formatHistoryHeader('2026-11-19'),
  '## [07:30] Translation',
  '',
  '**Input:** hello',
  '',
  '你好',
  '',
  '---',
  '',
  '## [09:05] Grammar Check',
  '',
  '**Input:** He go.',
  '',
  'He goes.',
  '---',
  '- detail with a separator inside',
  '',
  '---',
  '',
].join('\n');

const at = (hh, mm, ss = 0) => {
  const d = new Date(2026, 10, 19, hh, mm, ss);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  return `2026-11-19T${p(hh)}:${p(mm)}:${p(ss)}${sign}${p(Math.trunc(offset / 60))}:${p(offset % 60)}`;
};

const MP = (id, hh, mm, ss, overrides = {}) => ({ id, source: 'mp', task: 'translate', input: `phone ${id}`, output: `手机 ${id}`, createdAt: at(hh, mm, ss), ...overrides });

test('mergeDayHistory: local and phone records interleaved by time, phone marked', () => {
  const remote = [MP('a', 8, 0, 10), MP('b', 9, 5, 30, { task: 'check' }), MP('c', 6, 59, 59), { ...MP('d', 8, 1, 0), source: 'cli' }];
  const { text, local, phone } = mergeDayHistory({ date: '2026-11-19', localContent: LOCAL, remoteEntries: remote });
  assert.equal(local, 2);
  assert.equal(phone, 3, 'the CLI\'s own records are not repeated');
  const headings = text.split('\n').filter((line) => line.startsWith('#'));
  assert.deepEqual(headings, [
    '# t-cli Learning History — 2026-11-19 (2 from this computer, 3 from phone)',
    '## [06:59] Translation (phone)',
    '## [07:30] Translation',
    '## [08:00] Translation (phone)',
    '## [09:05] Grammar Check',
    '## [09:05] Grammar Check (phone)',
  ]);
  assert.ok(text.includes('## [08:00] Translation (phone)\n\n**Input:** phone a\n\n手机 a'));
  assert.ok(text.includes('He goes.\n---\n- detail with a separator inside\n\n---\n\n## [09:05] Grammar Check (phone)'), 'local block kept verbatim');
});

test('mergeDayHistory: phone records only (no local file)', () => {
  const { text, local, phone } = mergeDayHistory({ date: '2026-11-19', localContent: null, remoteEntries: [MP('a', 8, 0, 0)] });
  assert.equal(local, 0);
  assert.equal(phone, 1);
  assert.equal(text, '# t-cli Learning History — 2026-11-19 (0 from this computer, 1 from phone)\n\n---\n\n## [08:00] Translation (phone)\n\n**Input:** phone a\n\n手机 a');
});

test('phoneEntries keeps mini-program records only', () => {
  assert.deepEqual(phoneEntries([MP('a', 1, 0, 0), { ...MP('b', 1, 0, 0), source: 'cli' }]).map((e) => e.id), ['a']);
});
