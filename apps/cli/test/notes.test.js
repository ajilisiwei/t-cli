// notes.js resolves its directory from XDG_CONFIG_HOME (APPDATA on Windows)
// on every call; each test uses a throwaway dir, never ~/.config/t-cli.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveGeneratedNote, readGeneratedNote, listGeneratedNotes, getNotesDir } from '../src/notes.js';

function withTempConfig(fn) {
  const previous = { xdg: process.env.XDG_CONFIG_HOME, appdata: process.env.APPDATA };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-notes-'));
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

function assertSilent(t, fn) {
  const spies = ['log', 'error', 'warn', 'info'].map((name) => t.mock.method(console, name, () => {}));
  const result = fn();
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0, 'must not print while the TUI owns the terminal');
  return result;
}

test('saveGeneratedNote: writes the note and reports success', (t) => {
  withTempConfig(() => {
    const result = assertSilent(t, () => saveGeneratedNote('2026-11-18', '# Note\n'));
    assert.deepEqual(result, { ok: true });
    assert.equal(readGeneratedNote('2026-11-18'), '# Note\n');
    assert.deepEqual(listGeneratedNotes(), [{ date: '2026-11-18' }]);
  });
});

test('saveGeneratedNote: a write failure is returned, nothing is printed', (t) => {
  withTempConfig((dir) => {
    fs.mkdirSync(path.join(dir, 't-cli'), { recursive: true });
    fs.writeFileSync(getNotesDir(), 'not a directory', 'utf8');
    const result = assertSilent(t, () => saveGeneratedNote('2026-11-18', '# Note\n'));
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
    assert.equal(readGeneratedNote('2026-11-18'), null);
  });
});
