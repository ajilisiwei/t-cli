// history.js resolves its directory from XDG_CONFIG_HOME (APPDATA on Windows)
// on every call, so each test gets a throwaway config dir and never touches
// the real ~/.config/t-cli. The time zone is pinned to UTC+8 so local and UTC
// dates differ before 08:00.
process.env.TZ = 'Asia/Shanghai';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveHistory, readHistory, listHistory, getHistoryDir } from '../src/history.js';
import { localDateString } from '../src/utils/localDate.js';
import { formatHistoryHeader, parseHistoryFile, recordToEntry } from '../src/utils/historyParser.js';

function withTempConfig(fn) {
  const previous = { xdg: process.env.XDG_CONFIG_HOME, appdata: process.env.APPDATA };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-history-'));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.APPDATA = dir;
  try {
    return fn(dir);
  } finally {
    for (const [key, value] of [['XDG_CONFIG_HOME', previous.xdg], ['APPDATA', previous.appdata]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Fail the test if anything is written through console while `fn` runs. */
function assertSilent(t, fn) {
  const spies = ['log', 'error', 'warn', 'info'].map((name) => t.mock.method(console, name, () => {}));
  const result = fn();
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0, 'must not print while the TUI owns the terminal');
  return result;
}

const historyFiles = () => fs.readdirSync(getHistoryDir()).filter((name) => name.endsWith('.md')).sort();

// Local 2026-11-18 07:30 in Beijing; the UTC date is still 2026-11-17.
const BEIJING_MORNING = new Date('2026-11-17T23:30:00.000Z');

test('saveHistory: a 07:30 Beijing entry goes to that local day, not the previous UTC day', (t) => {
  withTempConfig(() => {
    const result = assertSilent(t, () => saveHistory('Translation', 'early', '早', BEIJING_MORNING));
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(historyFiles(), ['2026-11-18.md']);
    const content = readHistory('2026-11-18');
    assert.ok(content.startsWith(formatHistoryHeader('2026-11-18')), content);
    assert.match(content, /^## \[07:30\] Translation$/m);
    assert.deepEqual(listHistory(), [{ date: '2026-11-18', count: 1 }]);
  });
});

test('saveHistory: just before and just after local midnight', () => {
  withTempConfig(() => {
    assert.equal(saveHistory('Translation', 'late', '晚', new Date('2026-11-17T15:59:00.000Z')).ok, true);
    assert.equal(saveHistory('Grammar Check', 'He go.', 'He goes.', new Date('2026-11-17T16:00:00.000Z')).ok, true);
    assert.deepEqual(historyFiles(), ['2026-11-17.md', '2026-11-18.md']);
    assert.match(readHistory('2026-11-17'), /^## \[23:59\] Translation$/m);
    assert.match(readHistory('2026-11-18'), /^## \[00:00\] Grammar Check$/m);
  });
});

test('saveHistory: the header is written once per file', () => {
  withTempConfig(() => {
    saveHistory('Translation', 'one', '一', new Date('2026-11-18T01:00:00.000Z'));
    saveHistory('Translation', 'two', '二', new Date('2026-11-18T02:00:00.000Z'));
    const content = readHistory('2026-11-18');
    assert.equal(content.split('# t-cli Learning History').length - 1, 1);
    assert.deepEqual(listHistory(), [{ date: '2026-11-18', count: 2 }]);
  });
});

test('/history today: the local date names the file saveHistory just wrote', () => {
  withTempConfig(() => {
    const now = new Date();
    saveHistory('Translation', 'now', '现在', now);
    assert.ok(readHistory(localDateString(now)));
  });
});

test('existing UTC-named files are not renamed or appended to', () => {
  withTempConfig(() => {
    const historyDir = getHistoryDir();
    fs.mkdirSync(historyDir, { recursive: true });
    const legacy = '# t-cli Learning History — 2026-11-17\n\n---\n\n## [09:00] Translation\n\n**Input:** old\n\n旧\n\n---\n';
    fs.writeFileSync(path.join(historyDir, '2026-11-17.md'), legacy, 'utf8');
    // The old UTC rule would have appended this entry to 2026-11-17.md.
    saveHistory('Translation', 'early', '早', BEIJING_MORNING);
    assert.equal(fs.readFileSync(path.join(historyDir, '2026-11-17.md'), 'utf8'), legacy);
    assert.deepEqual(historyFiles(), ['2026-11-17.md', '2026-11-18.md']);
  });
});

test('round trip: the backfill parser reconstructs the instant saveHistory wrote', () => {
  withTempConfig(() => {
    const instants = ['2026-11-17T16:00:00.000Z', BEIJING_MORNING.toISOString(), '2026-11-18T15:59:00.000Z'];
    instants.forEach((iso, i) => saveHistory('Translation', `entry ${i}`, `条目 ${i}`, new Date(iso)));
    const { records } = parseHistoryFile(readHistory('2026-11-18'), '2026-11-18');
    assert.deepEqual(records.map((r) => r.dateBasis), ['local', 'local', 'local']);
    const createdAt = records.map((r) => {
      const mapped = recordToEntry(r);
      assert.ok(mapped.ok && mapped.dateMatched);
      return mapped.entry.createdAt;
    });
    assert.deepEqual(createdAt, ['2026-11-18T00:00:00+08:00', '2026-11-18T07:30:00+08:00', '2026-11-18T23:59:00+08:00']);
  });
});

test('saveHistory: a write failure is returned, nothing is printed', (t) => {
  withTempConfig((dir) => {
    // A regular file where the history directory should be.
    fs.mkdirSync(path.join(dir, 't-cli'), { recursive: true });
    fs.writeFileSync(getHistoryDir(), 'not a directory', 'utf8');
    const result = assertSilent(t, () => saveHistory('Translation', 'x', 'y', BEIJING_MORNING));
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  });
});
