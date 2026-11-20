// End-to-end runs of scripts/backfill-entries.js against a throwaway config
// dir. XDG_CONFIG_HOME (and APPDATA on Windows) point at a temp dir, so the
// user's real ~/.config/t-cli is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/backfill-entries.js', import.meta.url));

const header = (date) => `# t-cli Learning History — ${date}\n\n---\n`;
const block = (time, type, input, response) =>
  ['', `## [${time}] ${type}`, '', `**Input:** ${input}`, '', response, '', '---', ''].join('\n');

const FIXTURES = {
  '2026-11-15.md': header('2026-11-15')
    + block('21:00', 'Translation', 'meticulous', 'meticulous /məˈtɪkjələs/ 一丝不苟的')
    + block('21:05', 'Grammar Check', 'He go home.', 'He goes home.'),
  '2026-11-16.md': header('2026-11-16')
    + block('09:13', 'Translation', 'later', '1. 稍后\n\n---\n\n2. 以后')
    // Local 07:30 on Nov 17 is still UTC Nov 16, so it lands in this file.
    + block('07:30', 'Translation', '早上好', 'Good morning'),
};

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-backfill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 't-cli');
  const historyDir = path.join(configDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  for (const [name, content] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(historyDir, name), content, 'utf8');
  }
  fs.writeFileSync(path.join(historyDir, 'meta.json'), JSON.stringify({ '2026-11-15': 2, '2026-11-16': 1 }), 'utf8');
  return { root, configDir, historyDir, outbox: path.join(configDir, 'outbox.jsonl') };
}

function run(env, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: env.root, APPDATA: env.root, TZ: 'Asia/Shanghai' },
  });
  return { ...result, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const readOutboxLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const summaryValue = (stdout, label) => {
  const match = new RegExp(`^\\s+${label}:\\s+(\\d+)`, 'm').exec(stdout);
  assert.ok(match, `missing "${label}" in output:\n${stdout}`);
  return Number(match[1]);
};

test('--dry-run reports counts and writes nothing', (t) => {
  const env = setup(t);
  const result = run(env, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryValue(result.stdout, 'headings found'), 4);
  assert.equal(summaryValue(result.stdout, 'entries parsed'), 4);
  assert.equal(summaryValue(result.stdout, 'would write'), 4);
  assert.match(result.stdout, /2026-11-16 {2}meta=1 {2}parsed=2/);
  assert.equal(fs.existsSync(env.outbox), false);
});

test('import is idempotent: a second run writes 0 entries', (t) => {
  const env = setup(t);
  const first = run(env);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(summaryValue(first.stdout, 'written'), 4);
  const written = readOutboxLines(env.outbox);
  assert.deepEqual(written.map((e) => e.createdAt), [
    '2026-11-15T21:00:00+08:00',
    '2026-11-15T21:05:00+08:00',
    '2026-11-16T09:13:00+08:00',
    '2026-11-17T07:30:00+08:00',
  ]);
  assert.deepEqual(written.map((e) => e.task), ['translate', 'check', 'translate', 'translate']);
  assert.equal(written[2].output, '1. 稍后\n\n---\n\n2. 以后');

  const second = run(env, ['--history-dir', env.historyDir]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(summaryValue(second.stdout, 'written'), 0);
  assert.equal(summaryValue(second.stdout, 'duplicates skipped'), 4);
  assert.deepEqual(readOutboxLines(env.outbox).map((e) => e.id), written.map((e) => e.id));
});

test('local-date files sit next to legacy UTC-named ones; legacy records are unchanged', (t) => {
  const env = setup(t);
  // Written by the current saveHistory: named by local date, marked header.
  fs.writeFileSync(path.join(env.historyDir, '2026-11-18.md'),
    `# t-cli Learning History — 2026-11-18 (local date)\n\n---\n${block('07:30', 'Translation', 'dawn', '黎明')}`, 'utf8');
  const result = run(env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryValue(result.stdout, 'timestamp fallbacks'), 0);
  assert.match(result.stdout, /file date basis:\s+utc 4, local 1/);
  assert.deepEqual(readOutboxLines(env.outbox).map((e) => [e.input, e.createdAt]), [
    ['meticulous', '2026-11-15T21:00:00+08:00'],
    ['He go home.', '2026-11-15T21:05:00+08:00'],
    ['later', '2026-11-16T09:13:00+08:00'],
    ['早上好', '2026-11-17T07:30:00+08:00'],
    ['dawn', '2026-11-18T07:30:00+08:00'],
  ]);
});

test('entries from the liveSince minute onwards are skipped', (t) => {
  const env = setup(t);
  fs.writeFileSync(path.join(env.configDir, 'sync-state.json'), JSON.stringify({ liveSince: '2026-11-15T21:05:30+08:00' }), 'utf8');
  const result = run(env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(summaryValue(result.stdout, 'skipped by cutoff'), 3);
  assert.deepEqual(readOutboxLines(env.outbox).map((e) => e.input), ['meticulous']);
});

test('unknown flags exit with code 2 and print usage', (t) => {
  const env = setup(t);
  const result = run(env, ['--bogus']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});
