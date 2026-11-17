import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyKind,
  createEntry,
  validateEntry,
  serializeEntry,
  parseEntryLine,
  toLocalIsoString,
  SENTENCE_MAX_CHARS,
} from '../src/entry.js';
import { ulidTime } from '../src/ulid.js';

const BASE = {
  source: 'cli',
  task: 'translate',
  input: '  meticulous  ',
  output: 'meticulous /məˈtɪkjələs/ 一丝不苟的\n',
  mode: 'simple',
  srcLang: 'en',
  createdAt: new Date('2026-11-16T09:12:03.456+08:00'),
};

test('classifyKind: word / sentence / paragraph', () => {
  assert.equal(classifyKind('meticulous'), 'word');
  assert.equal(classifyKind('trade-off'), 'word');
  assert.equal(classifyKind('把关'), 'word');
  assert.equal(classifyKind('look forward to'), 'sentence');
  assert.equal(classifyKind('这个情况确实有点不一样，让我想想解决办法'), 'sentence');
  assert.equal(classifyKind('a'.repeat(SENTENCE_MAX_CHARS + 1).replace(/a/g, 'a ')), 'paragraph');
});

test('classifyKind: counts code points, not UTF-16 units', () => {
  const emoji = '😀'.repeat(SENTENCE_MAX_CHARS);
  assert.equal(classifyKind(emoji), 'sentence');
});

test('createEntry: trims text, derives kind, truncates time to seconds', () => {
  const entry = createEntry(BASE);
  assert.equal(entry.v, 1);
  assert.equal(entry.input, 'meticulous');
  assert.equal(entry.output, 'meticulous /məˈtɪkjələs/ 一丝不苟的');
  assert.equal(entry.kind, 'word');
  assert.equal(ulidTime(entry.id), Date.parse('2026-11-16T09:12:03+08:00'));
  assert.equal(Date.parse(entry.createdAt), Date.parse('2026-11-16T09:12:03+08:00'));
  assert.ok(Object.isFrozen(entry));
});

test('createEntry: CR / CRLF line breaks from raw-mode pastes become LF', () => {
  const entry = createEntry({ ...BASE, input: 'line one\rline two\r\nline three', output: 'a\r\nb' });
  assert.equal(entry.input, 'line one\nline two\nline three');
  assert.equal(entry.output, 'a\nb');
});

test('createEntry: derives correctedInput for a misspelled English word lookup', () => {
  const entry = createEntry({ ...BASE, input: 'prioritiz', output: 'prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑' });
  assert.equal(entry.correctedInput, 'prioritize');
  assert.equal(createEntry(BASE).correctedInput, null);
});

test('createEntry: an explicit correctedInput wins over detection', () => {
  const entry = createEntry({ ...BASE, input: 'prioritiz', output: 'prioritiz /x/ 优先处理', correctedInput: 'prioritize' });
  assert.equal(entry.correctedInput, 'prioritize');
});

test('validateEntry: lines written before correctedInput existed still parse', () => {
  const { correctedInput, ...legacy } = createEntry(BASE);
  const result = validateEntry(legacy);
  assert.equal(result.ok, true);
  assert.equal(result.entry.correctedInput, null);
  assert.equal(validateEntry({ ...legacy, correctedInput: '' }).ok, false);
});

test('createEntry: fixed entropy gives a deterministic id', () => {
  const entropy = new Uint8Array(10).fill(42);
  assert.equal(createEntry({ ...BASE, entropy }).id, createEntry({ ...BASE, entropy }).id);
});

test('createEntry: rejects invalid fields', () => {
  assert.throws(() => createEntry({ ...BASE, task: 'quiz' }), /task must be/);
  assert.throws(() => createEntry({ ...BASE, input: '   ' }), /input must be/);
  assert.throws(() => createEntry({ ...BASE, createdAt: new Date('nope') }), TypeError);
});

test('toLocalIsoString: includes an explicit offset', () => {
  assert.match(toLocalIsoString(new Date()), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('serialize + parse round-trip', () => {
  const entry = createEntry(BASE);
  const parsed = parseEntryLine(serializeEntry(entry));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entry, entry);
});

test('parseEntryLine: invalid JSON and schema errors are reported, not thrown', () => {
  assert.equal(parseEntryLine('{oops').ok, false);
  const bad = parseEntryLine(JSON.stringify({ v: 1, id: 'x' }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 1);
});

test('validateEntry: strips unknown fields', () => {
  const entry = createEntry(BASE);
  const result = validateEntry({ ...entry, extra: 'drop me' });
  assert.equal(result.ok, true);
  assert.equal('extra' in result.entry, false);
});
