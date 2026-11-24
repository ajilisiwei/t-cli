// Default settings: the explanation language defaults to zh (as on the server
// and in the mini-program); a saved config keeps its own value and is never
// rewritten by loading. config.js resolves its path when imported, so each
// case imports a fresh instance under its own temp XDG_CONFIG_HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let instance = 0;

async function loadFresh(t) {
  const previous = process.env.XDG_CONFIG_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-config-'));
  process.env.XDG_CONFIG_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  instance += 1;
  const config = await import(`../src/config.js?instance=${instance}`);
  return { config, file: path.join(dir, 't-cli', 'config.json') };
}

test('loadConfig: without a config file the explanation language is zh', { skip: process.platform === 'win32' }, async (t) => {
  const { config, file } = await loadFresh(t);
  assert.deepEqual(config.loadConfig(), { lang: 'zh', isSimpleMode: false });
  assert.equal(fs.existsSync(file), false, 'loading writes nothing');
});

test('loadConfig: a saved lang is kept and the file is left untouched', { skip: process.platform === 'win32' }, async (t) => {
  const { config, file } = await loadFresh(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const saved = JSON.stringify({ lang: 'en', isSimpleMode: true, serverUrl: 'https://example.test' });
  fs.writeFileSync(file, saved);
  assert.deepEqual(config.loadConfig(), { lang: 'en', isSimpleMode: true, serverUrl: 'https://example.test' });
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
});

test('saveConfig: merges updates into the saved file', { skip: process.platform === 'win32' }, async (t) => {
  const { config, file } = await loadFresh(t);
  config.saveConfig({ isSimpleMode: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { lang: 'zh', isSimpleMode: true });
  config.saveConfig({ lang: 'en' });
  assert.deepEqual(config.loadConfig(), { lang: 'en', isSimpleMode: true });
});
