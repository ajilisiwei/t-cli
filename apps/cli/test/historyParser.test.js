// Timestamps are reconstructed in the process time zone; pin it (UTC+8, no DST).
process.env.TZ = 'Asia/Shanghai';

import test from 'node:test';
import assert from 'node:assert/strict';
import { ulidTime } from '@t-cli/core/ulid';
import {
  splitBlocks,
  parseHistoryFile,
  reconstructCreatedAt,
  inferMode,
  recordToEntry,
  isBeforeLiveCutoff,
  planBackfill,
  compareWithMeta,
  detectDateBasis,
  formatHistoryHeader,
} from '../src/utils/historyParser.js';

// Mirrors saveHistory output byte for byte, with the legacy header of files
// named by UTC date (current files use formatHistoryHeader, see below).
const header = (date) => `# t-cli Learning History — ${date}\n\n---\n`;
const block = (time, type, input, response) =>
  ['', `## [${time}] ${type}`, '', `**Input:** ${input}`, '', response.trim(), '', '---', ''].join('\n');
const historyFile = (date, ...blocks) => header(date) + blocks.join('');

const DETAIL_WITH_RULE = [
  '1. Compliance',
  '   (Standard/Professional.)',
  '',
  '---',
  '**If the input is the English source:**',
  '',
  '## 核心知识点',
  '合规',
].join('\n');

function parseOne(content, fileDate = '2026-11-16') {
  const { records, failures } = parseHistoryFile(content, fileDate);
  assert.equal(failures.length, 0);
  assert.equal(records.length, 1);
  const mapped = recordToEntry(records[0]);
  assert.ok(mapped.ok, mapped.ok ? '' : mapped.error);
  return { record: records[0], entry: mapped.entry };
}

test('simple word entry maps to a translate/word/simple entry', () => {
  const { entry } = parseOne(historyFile('2026-11-16', block('09:13', 'Translation', 'meticulous', 'meticulous /məˈtɪkjələs/ 一丝不苟的')));
  assert.equal(entry.source, 'cli');
  assert.equal(entry.task, 'translate');
  assert.equal(entry.kind, 'word');
  assert.equal(entry.mode, 'simple');
  assert.equal(entry.srcLang, 'en');
  assert.equal(entry.input, 'meticulous');
  assert.equal(entry.output, 'meticulous /məˈtɪkjələs/ 一丝不苟的');
  assert.equal(entry.createdAt, '2026-11-16T09:13:00+08:00');
});

test('detail output containing --- and ## lines is not split', () => {
  const content = historyFile('2026-11-16',
    block('19:02', 'Translation', 'compliance', DETAIL_WITH_RULE),
    block('19:03', 'Translation', '合规', 'compliance'));
  const { headings, records } = parseHistoryFile(content, '2026-11-16');
  assert.equal(headings, 2);
  assert.equal(records[0].output, DETAIL_WITH_RULE);
  assert.equal(records[1].input, '合规');
  assert.equal(records[1].output, 'compliance');
  const first = recordToEntry(records[0]);
  assert.ok(first.ok);
  assert.equal(first.entry.mode, 'detail');
  const second = recordToEntry(records[1]);
  assert.ok(second.ok);
  assert.equal(second.entry.srcLang, 'zh');
});

test('only the trailing separator is stripped (input and output "---")', () => {
  const { record } = parseOne(historyFile('2026-11-16', block('17:00', 'Translation', '---', '---')));
  assert.equal(record.input, '---');
  assert.equal(record.output, '---');
});

test('Grammar Check maps to task check with srcLang en', () => {
  const { entry } = parseOne(historyFile('2026-11-16', block('10:19', 'Grammar Check', 'He go to school.', 'He goes to school.')));
  assert.equal(entry.task, 'check');
  assert.equal(entry.srcLang, 'en');
  assert.equal(entry.kind, 'sentence');
  assert.equal(entry.mode, 'simple');
});

test('multi-line input runs until the first blank line', () => {
  const { record, entry } = parseOne(historyFile('2026-11-16', block('11:00', 'Translation', '第一行\n第二行', 'Line one\nLine two')));
  assert.equal(record.input, '第一行\n第二行');
  assert.equal(record.output, 'Line one\nLine two');
  assert.equal(record.multiLineInput, true);
  // Two output lines for a two-line source is a simple-mode translation.
  assert.equal(entry.mode, 'simple');
});

test('pasted input with embedded CR stays on one line and is flagged', () => {
  const { record } = parseOne(historyFile('2026-11-16', block('11:05', 'Translation', 'Important update\rCode Quality ships', '重要更新\r代码质量上线')));
  assert.equal(record.input, 'Important update\rCode Quality ships');
  assert.equal(record.multiLineInput, true);
});

test('single-line input is not flagged as multi-line', () => {
  const { record } = parseOne(historyFile('2026-11-16', block('11:06', 'Translation', 'hello world', '你好，世界')));
  assert.equal(record.multiLineInput, false);
});

test('UTC/local shift: [07:30] in 2026-11-16.md is local 2026-11-17 07:30', () => {
  const { entry } = parseOne(historyFile('2026-11-16', block('07:30', 'Translation', 'early', '早')));
  assert.equal(entry.createdAt, '2026-11-17T07:30:00+08:00');
  assert.equal(new Date(entry.createdAt).toISOString().slice(0, 10), '2026-11-16');
});

test('reconstructCreatedAt: boundaries around local 08:00 in UTC+8', () => {
  const iso = (date, time) => reconstructCreatedAt(date, time).createdAt.toISOString();
  assert.equal(iso('2026-11-16', '00:00'), '2026-11-16T16:00:00.000Z'); // local 11-17 00:00
  assert.equal(iso('2026-11-16', '07:59'), '2026-11-16T23:59:00.000Z'); // local 11-17 07:59
  assert.equal(iso('2026-11-16', '08:00'), '2026-11-16T00:00:00.000Z'); // local 11-16 08:00
  assert.equal(iso('2026-11-16', '23:59'), '2026-11-16T15:59:00.000Z'); // local 11-16 23:59
  assert.equal(reconstructCreatedAt('2026-11-16', '07:30').dateMatched, true);
});

test('reconstructCreatedAt: negative offsets use the previous local day', () => {
  const original = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    // Local 2026-11-15 20:00 EST is 2026-11-16 01:00 UTC.
    assert.equal(reconstructCreatedAt('2026-11-16', '20:00').createdAt.toISOString(), '2026-11-16T01:00:00.000Z');
  } finally {
    process.env.TZ = original;
  }
});

test('reconstructCreatedAt rejects impossible dates and times', () => {
  assert.throws(() => reconstructCreatedAt('2026-02-31', '10:00'), TypeError);
  assert.throws(() => reconstructCreatedAt('2026-11-16', '24:00'), TypeError);
  assert.throws(() => reconstructCreatedAt('2026-11-16', '9:00'), TypeError);
  assert.throws(() => reconstructCreatedAt('2026-11-16', '10:00', 'gmt'), TypeError);
});

// Golden values produced by the parser before files were named by local date.
// Existing (UTC-named) files must keep yielding exactly these IDs and instants,
// or a backfill re-run would import them a second time.
test('legacy UTC-named file: IDs and timestamps are unchanged', () => {
  const content = historyFile('2026-11-16',
    block('09:13', 'Translation', 'meticulous', 'meticulous /məˈtɪkjələs/ 一丝不苟的'),
    block('23:59', 'Grammar Check', 'He go home.', 'He goes home.'),
    block('00:00', 'Translation', '早上好', 'Good morning'),
    block('07:59', 'Translation', 'later', 'later'),
    block('07:59', 'Translation', 'later', 'later'));
  const { records } = parseHistoryFile(content, '2026-11-16');
  assert.ok(records.every((r) => r.dateBasis === 'utc'));
  const entries = records.map((r) => {
    const mapped = recordToEntry(r);
    assert.ok(mapped.ok);
    return [mapped.entry.id, mapped.entry.createdAt];
  });
  assert.deepEqual(entries, [
    ['01M7GYM8B0XDP2SBGQEMKPHGEA', '2026-11-16T09:13:00+08:00'],
    ['01M7JHAJD09HPXDDJCBWDS1G3F', '2026-11-16T23:59:00+08:00'],
    ['01M7JHCD004KNTNC0HJACZGH61', '2026-11-17T00:00:00+08:00'],
    ['01M7KCSFD03VM0F7RPJ6GHWB35', '2026-11-17T07:59:00+08:00'],
    ['01M7KCSFD04GXB2VEKEGDGYB58', '2026-11-17T07:59:00+08:00'],
  ]);
});

const localHistoryFile = (date, ...blocks) => formatHistoryHeader(date) + blocks.join('');

test('detectDateBasis: the "(local date)" header marks a local-date file', () => {
  assert.equal(detectDateBasis(historyFile('2026-11-18', block('07:30', 'Translation', 'a', 'b'))), 'utc');
  assert.equal(detectDateBasis(localHistoryFile('2026-11-18', block('07:30', 'Translation', 'a', 'b'))), 'local');
  assert.equal(detectDateBasis(formatHistoryHeader('2026-11-18')), 'local', 'header only, no entries yet');
  assert.equal(detectDateBasis(localHistoryFile('2026-11-18').replace(/\n/g, '\r\n')), 'local', 'CRLF');
  assert.equal(detectDateBasis(''), 'utc');
});

test('detectDateBasis: a marker-like line inside an entry does not count', () => {
  const content = historyFile('2026-11-18',
    block('07:30', 'Translation', 'quote', '# t-cli Learning History — 2026-11-18 (local date)'));
  assert.equal(detectDateBasis(content), 'utc');
});

test('local-date file: [07:30] in 2026-11-18.md is local 2026-11-18 07:30', () => {
  const content = localHistoryFile('2026-11-18', block('07:30', 'Translation', 'early', '早'));
  const { record, entry } = parseOne(content, '2026-11-18');
  assert.equal(record.dateBasis, 'local');
  assert.equal(entry.createdAt, '2026-11-18T07:30:00+08:00');
  // Read as a legacy UTC-named file, the same text would land a day later.
  const legacy = recordToEntry({ ...record, dateBasis: 'utc' });
  assert.ok(legacy.ok);
  assert.equal(legacy.entry.createdAt, '2026-11-19T07:30:00+08:00');
});

test('reconstructCreatedAt (local): just after and just before local midnight', () => {
  const iso = (time) => reconstructCreatedAt('2026-11-18', time, 'local').createdAt.toISOString();
  assert.equal(iso('00:00'), '2026-11-17T16:00:00.000Z'); // local 11-18 00:00
  assert.equal(iso('00:01'), '2026-11-17T16:01:00.000Z');
  assert.equal(iso('23:59'), '2026-11-18T15:59:00.000Z'); // local 11-18 23:59
  assert.equal(reconstructCreatedAt('2026-11-18', '07:30', 'local').dateMatched, true);
});

test('reconstructCreatedAt (local): negative offsets keep the file date', () => {
  const original = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    // Local 2026-11-17 23:59 EST is 2026-11-18 04:59 UTC.
    assert.equal(reconstructCreatedAt('2026-11-17', '23:59', 'local').createdAt.toISOString(), '2026-11-18T04:59:00.000Z');
    assert.equal(reconstructCreatedAt('2026-11-17', '00:00', 'local').createdAt.toISOString(), '2026-11-17T05:00:00.000Z');
    // 02:30 on 2026-03-08 does not exist (DST jump): flagged as a fallback.
    assert.equal(reconstructCreatedAt('2026-03-08', '02:30', 'local').dateMatched, false);
  } finally {
    process.env.TZ = original;
  }
});

test('deterministic IDs: re-parsing yields identical IDs, ULID time = createdAt', () => {
  const content = historyFile('2026-11-16',
    block('09:00', 'Translation', 'hello', '你好'),
    block('09:00', 'Translation', 'hello', '你好'),
    block('09:01', 'Grammar Check', 'I has it.', 'I have it.'));
  const ids = () => parseHistoryFile(content, '2026-11-16').records.map((r) => {
    const mapped = recordToEntry(r);
    assert.ok(mapped.ok);
    return mapped.entry;
  });
  const first = ids();
  assert.deepEqual(first.map((e) => e.id), ids().map((e) => e.id));
  assert.equal(new Set(first.map((e) => e.id)).size, 3, 'identical repeats get distinct IDs');
  for (const entry of first) {
    assert.equal(ulidTime(entry.id), Date.parse(entry.createdAt));
  }
});

test('deterministic IDs survive removal of an unrelated earlier entry', () => {
  const keep = block('09:05', 'Translation', 'keep me', '保留');
  const idOf = (content) => {
    const { records } = parseHistoryFile(content, '2026-11-16');
    const mapped = recordToEntry(records[records.length - 1]);
    assert.ok(mapped.ok);
    return mapped.entry.id;
  };
  const withExtra = historyFile('2026-11-16', block('09:00', 'Translation', 'deleted later', '稍后删除'), keep);
  assert.equal(idOf(withExtra), idOf(historyFile('2026-11-16', keep)));
});

test('a block without an **Input:** line is a counted failure, not a throw', () => {
  const content = `${header('2026-11-16')}\n## [09:00] Translation\n\nno input marker\n\n---\n${block('09:01', 'Translation', 'ok', '好')}`;
  const { headings, records, failures } = parseHistoryFile(content, '2026-11-16');
  assert.equal(headings, 2);
  assert.equal(records.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].index, 0);
});

test('CRLF files parse the same as LF files', () => {
  const lf = historyFile('2026-11-16', block('09:00', 'Translation', 'hello', '你好'));
  const { entry } = parseOne(lf.replace(/\n/g, '\r\n'));
  assert.equal(entry.input, 'hello');
  assert.equal(entry.output, '你好');
});

test('splitBlocks ignores the file header and non-entry headings', () => {
  const blocks = splitBlocks(historyFile('2026-11-16', block('09:00', 'Translation', 'x', '## 技能树\ny')));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].time, '09:00');
  assert.equal(blocks[0].type, 'Translation');
});

test('inferMode: line-count heuristic', () => {
  assert.equal(inferMode('apple /ˈæp.əl/ 苹果', 'apple'), 'simple');
  assert.equal(inferMode('1. 清楚\n2. 清晰', 'clear'), 'detail');
  assert.equal(inferMode('A\n\nB', 'a\rb'), 'simple');
  assert.equal(inferMode('A\nB\nC\nD', 'a\rb'), 'detail');
  assert.equal(inferMode('single line'), 'simple');
});

test('isBeforeLiveCutoff compares whole minutes, strictly before', () => {
  const liveSince = '2026-11-16T09:13:42+08:00';
  const at = (createdAt) => isBeforeLiveCutoff({ createdAt }, liveSince);
  assert.equal(at('2026-11-16T09:12:00+08:00'), true);
  assert.equal(at('2026-11-16T09:13:00+08:00'), false);
  assert.equal(at('2026-11-16T09:14:00+08:00'), false);
  assert.equal(isBeforeLiveCutoff({ createdAt: '2030-01-01T00:00:00+08:00' }, null), true);
  assert.throws(() => isBeforeLiveCutoff({ createdAt: '2026-11-16T09:12:00+08:00' }, 'not a date'), TypeError);
});

function entriesFor(...blocks) {
  return parseHistoryFile(historyFile('2026-11-16', ...blocks), '2026-11-16').records.map((r) => {
    const mapped = recordToEntry(r);
    assert.ok(mapped.ok);
    return mapped.entry;
  });
}

test('planBackfill: cutoff by liveSince', () => {
  const entries = entriesFor(
    block('09:12', 'Translation', 'before', '之前'),
    block('09:13', 'Translation', 'same minute', '同一分钟'),
    block('09:20', 'Translation', 'after', '之后'));
  const plan = planBackfill({ entries, liveSince: '2026-11-16T09:13:05+08:00', existingIds: [] });
  assert.deepEqual(plan.toWrite.map((e) => e.input), ['before']);
  assert.equal(plan.skippedByCutoff, 2);
  assert.equal(plan.duplicates, 0);
  const noCutoff = planBackfill({ entries, liveSince: null, existingIds: [] });
  assert.equal(noCutoff.toWrite.length, 3);
});

test('planBackfill: a second run with the first run\'s IDs writes nothing', () => {
  const entries = entriesFor(block('09:00', 'Translation', 'a', '甲'), block('09:01', 'Translation', 'b', '乙'));
  const first = planBackfill({ entries, liveSince: null, existingIds: [] });
  assert.equal(first.toWrite.length, 2);
  const existingIds = first.toWrite.map((e) => e.id);
  const second = planBackfill({ entries, liveSince: null, existingIds });
  assert.equal(second.toWrite.length, 0);
  assert.equal(second.duplicates, 2);
  assert.deepEqual(existingIds, first.toWrite.map((e) => e.id), 'existingIds not mutated');
});

test('compareWithMeta reports mismatches and invalid keys for covered dates only', () => {
  const parsed = { '2026-04-02': 14, '2026-04-03': 5, '2026-04-13': 12 };
  const meta = { '2026-04-02': 7, '2026-04-13': 12, '2026-04-20': 1, bogus: 3, '2026-04-21': 'x' };
  const result = compareWithMeta(parsed, meta);
  assert.equal(result.covered, 3);
  assert.deepEqual(result.mismatches, [
    { date: '2026-04-02', meta: 7, parsed: 14 },
    { date: '2026-04-20', meta: 1, parsed: 0 },
  ]);
  assert.deepEqual(result.invalidKeys, ['2026-04-21', 'bogus']);
  assert.deepEqual(compareWithMeta(parsed, null), { covered: 0, mismatches: [], invalidKeys: [] });
});
