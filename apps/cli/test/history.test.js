// history.js resolves its directory from XDG_CONFIG_HOME (APPDATA on Windows)
// on every call, so each test gets a throwaway config dir and never touches
// the real ~/.config/t-cli.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveHistory, listHistory, getHistoryDir } from '../src/history.js';

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

test('saveHistory: success is reported, nothing is printed', (t) => {
  withTempConfig(() => {
    const result = assertSilent(t, () => saveHistory('Translation', 'early', '早'));
    assert.deepEqual(result, { ok: true });
    assert.equal(listHistory().length, 1);
  });
});

test('saveHistory: a write failure is returned, nothing is printed', (t) => {
  withTempConfig((dir) => {
    // A regular file where the history directory should be.
    fs.mkdirSync(path.join(dir, 't-cli'), { recursive: true });
    fs.writeFileSync(getHistoryDir(), 'not a directory', 'utf8');
    const result = assertSilent(t, () => saveHistory('Translation', 'x', 'y'));
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  });
});
