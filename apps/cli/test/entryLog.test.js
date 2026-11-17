import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendEntries,
  getLiveSince,
  getOutboxPath,
  readOutbox,
  recordLiveEntry,
  updateSyncState,
} from '../src/entryLog.js';

// entryLog resolves paths from XDG_CONFIG_HOME on every call, so each test
// gets an isolated config dir and never touches the real ~/.config/t-cli.
function withTempConfig(fn) {
  const previous = process.env.XDG_CONFIG_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-entrylog-'));
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LIVE = { task: 'translate', input: 'meticulous', output: 'adj. 一丝不苟的', mode: 'simple', srcLang: 'en' };

test('readOutbox: missing file is an empty outbox', () => {
  withTempConfig(() => {
    assert.deepEqual(readOutbox(), { entries: [], invalidLines: 0, error: null });
    assert.equal(getLiveSince(), null);
  });
});

test('recordLiveEntry: appends a valid entry and sets liveSince once', () => {
  withTempConfig(() => {
    const first = recordLiveEntry({ ...LIVE, createdAt: new Date('2026-11-17T10:00:05+08:00') });
    assert.deepEqual(first, { ok: true });
    const since = getLiveSince();
    assert.equal(Date.parse(since), Date.parse('2026-11-17T10:00:05+08:00'));

    recordLiveEntry({ ...LIVE, task: 'check', input: 'She don\'t like it.', createdAt: new Date('2026-11-17T11:00:00+08:00') });
    assert.equal(getLiveSince(), since, 'liveSince must not move forward');

    const { entries, invalidLines } = readOutbox();
    assert.equal(invalidLines, 0);
    assert.deepEqual(entries.map((e) => [e.source, e.task, e.kind]), [
      ['cli', 'translate', 'word'],
      ['cli', 'check', 'sentence'],
    ]);
  });
});

test('recordLiveEntry: invalid fields return an error instead of throwing', () => {
  withTempConfig(() => {
    const result = recordLiveEntry({ ...LIVE, input: '   ' });
    assert.equal(result.ok, false);
    assert.match(result.error, /input/);
    assert.equal(fs.existsSync(getOutboxPath()), false);
  });
});

test('readOutbox: corrupt lines are counted and skipped', () => {
  withTempConfig(() => {
    recordLiveEntry(LIVE);
    fs.appendFileSync(getOutboxPath(), '{not json\n{"v":1}\n', 'utf8');
    const { entries, invalidLines } = readOutbox();
    assert.equal(entries.length, 1);
    assert.equal(invalidLines, 2);
  });
});

test('readOutbox: an unreadable outbox reports an error instead of looking empty', () => {
  withTempConfig(() => {
    fs.mkdirSync(getOutboxPath(), { recursive: true }); // a directory: EISDIR on read
    const result = readOutbox();
    assert.equal(result.entries.length, 0);
    assert.ok(result.error, 'expected a read error');
  });
});

test('appendEntries: empty batch is a no-op', () => {
  withTempConfig(() => {
    assert.deepEqual(appendEntries([]), { ok: true });
    assert.equal(fs.existsSync(getOutboxPath()), false);
  });
});

test('updateSyncState: merges instead of replacing', () => {
  withTempConfig(() => {
    updateSyncState({ liveSince: '2026-11-17T10:00:00+08:00' });
    updateSyncState({ pushCursor: 'x' });
    assert.equal(getLiveSince(), '2026-11-17T10:00:00+08:00');
  });
});

test('getLiveSince: unparseable values are ignored', () => {
  withTempConfig(() => {
    updateSyncState({ liveSince: 'yesterday' });
    assert.equal(getLiveSince(), null);
  });
});
