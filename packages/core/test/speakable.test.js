import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSpeakable, speakableForEntry } from '../src/speakable.js';

test('simple mode: whole response is speakable', () => {
  assert.equal(
    extractSpeakable('The weather is lovely today.\n', true),
    'The weather is lovely today.'
  );
});

test('detail mode: only the first non-empty line is speakable', () => {
  const raw = '\nOne more big task for you.\n\n1. Standard version: ...\n2. Casual version: ...';
  assert.equal(extractSpeakable(raw, false), 'One more big task for you.');
});

test('IPA transcriptions are stripped', () => {
  assert.equal(extractSpeakable('apple /ˈæp.əl/', true), 'apple');
  assert.equal(extractSpeakable('ephemeral /ɪˈfem.ər.əl/ 短暂的', true), 'ephemeral 短暂的');
});

test('markdown bold markers are stripped', () => {
  assert.equal(extractSpeakable('**apple** is a fruit', true), 'apple is a fruit');
});

test('plain slashes in normal text survive', () => {
  assert.equal(extractSpeakable('use and/or here', true), 'use and/or here');
});

test('URLs and file paths are not mistaken for IPA', () => {
  const url = 'Please read the docs at https://example.com/api/v2/users and call getUserById() before you deploy.';
  assert.equal(extractSpeakable(`${url}\n\nAnalysis: ...`, false), url);
  assert.equal(extractSpeakable('Edit /etc/hosts and restart.', true), 'Edit /etc/hosts and restart.');
});

test('IPA followed by punctuation is still stripped', () => {
  assert.equal(extractSpeakable('apple /ˈæp.əl/, 苹果', true), 'apple , 苹果');
  assert.doesNotMatch(extractSpeakable('apple (/ˈæp.əl/) 苹果', true), /ˈ/);
});

test('detail-mode check output: corrected sentence on the first line is speakable', () => {
  const raw = "She doesn't like apples.\n\nAnalysis: subject-verb agreement...\n\n1. She isn't a fan of apples.";
  assert.equal(extractSpeakable(raw, false), "She doesn't like apples.");
});

test('detail mode: a lone IPA first line falls through to the next line', () => {
  const raw = '/ɪˈfem.ər.əl/\n\nephemeral means short-lived.';
  assert.equal(extractSpeakable(raw, false), 'ephemeral means short-lived.');
});

test('empty input yields empty string', () => {
  assert.equal(extractSpeakable('', true), '');
  assert.equal(extractSpeakable('   \n  ', false), '');
});

const entryOf = (fields) => ({ task: 'translate', mode: 'simple', srcLang: 'en', correctedInput: null, ...fields });

test('speakableForEntry: check reads the corrected text', () => {
  assert.equal(speakableForEntry(entryOf({ task: 'check', input: 'He go home.', output: 'He goes home.' })), 'He goes home.');
  const detail = "She doesn't like apples.\n\nAnalysis: subject-verb agreement...";
  assert.equal(speakableForEntry(entryOf({ task: 'check', mode: 'detail', input: "She don't like apples.", output: detail })), "She doesn't like apples.");
});

test('speakableForEntry: a Chinese source reads the English output like /say', () => {
  assert.equal(speakableForEntry(entryOf({ srcLang: 'zh', input: '苹果', output: 'apple /ˈæp.əl/' })), 'apple');
  const detail = 'It works on my machine.\n\n1. Standard: ...\n2. Casual: ...';
  assert.equal(speakableForEntry(entryOf({ srcLang: 'zh', mode: 'detail', input: '在我电脑上能跑', output: detail })), 'It works on my machine.');
});

test('speakableForEntry: an English source reads the source, corrected spelling first', () => {
  assert.equal(speakableForEntry(entryOf({ input: 'prioritiz', output: 'prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑', correctedInput: 'prioritize' })), 'prioritize');
  assert.equal(speakableForEntry(entryOf({ input: 'ephemeral', output: 'ephemeral /ɪˈfem.ər.əl/ 短暂的' })), 'ephemeral');
  assert.equal(speakableForEntry(entryOf({ input: ' Good morning. ', output: '早上好。', correctedInput: undefined })), 'Good morning.');
});

test('speakableForEntry: an other source reads the Chinese output', () => {
  assert.equal(speakableForEntry(entryOf({ srcLang: 'other', input: 'ありがとう', output: '谢谢' })), '谢谢');
  const detail = '我预约了会议室。\n\n1. 我订了会议室。';
  assert.equal(speakableForEntry(entryOf({ srcLang: 'other', mode: 'detail', input: '会議室を予約しました', output: detail })), '我预约了会议室。');
});

test('speakableForEntry: entries without srcLang are classified from their input', () => {
  assert.equal(speakableForEntry(entryOf({ srcLang: null, input: 'hello', output: '你好' })), 'hello');
  assert.equal(speakableForEntry(entryOf({ srcLang: null, input: '你好', output: 'hello' })), 'hello');
  assert.equal(speakableForEntry(entryOf({ srcLang: null, input: 'привет', output: '你好' })), '你好');
});

test('speakableForEntry: nothing to read yields an empty string', () => {
  assert.equal(speakableForEntry(entryOf({ srcLang: 'zh', input: '苹果', output: '' })), '');
  assert.equal(speakableForEntry(entryOf({ srcLang: 'zh', input: '苹果', output: '/ˈæp.əl/' })), '');
});
