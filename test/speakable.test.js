import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSpeakable } from '../src/utils/speakable.js';

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

test('detail mode: a lone IPA first line falls through to the next line', () => {
  const raw = '/ɪˈfem.ər.əl/\n\nephemeral means short-lived.';
  assert.equal(extractSpeakable(raw, false), 'ephemeral means short-lived.');
});

test('empty input yields empty string', () => {
  assert.equal(extractSpeakable('', true), '');
  assert.equal(extractSpeakable('   \n  ', false), '');
});
