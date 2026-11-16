import test from 'node:test';
import assert from 'node:assert/strict';
import { isWordLookup, containsCJK, detectSourceLang } from '../src/utils/detect.js';

test('detectSourceLang: pure Chinese and pure English', () => {
  assert.equal(detectSourceLang('今天天气真好'), 'zh');
  assert.equal(detectSourceLang('It works on my machine.'), 'en');
});

test('detectSourceLang: mixed input with any CJK is Chinese source', () => {
  assert.equal(detectSourceLang('珠宝估值的wrapped GraphQL API已经部署到开发环境了。'), 'zh');
  assert.equal(detectSourceLang('这个 bug 很难 debug'), 'zh');
  assert.equal(detectSourceLang('deploy 到 prod'), 'zh');
});

test('detectSourceLang: empty input falls back to English', () => {
  assert.equal(detectSourceLang(''), 'en');
});

test('isWordLookup: single English words', () => {
  assert.equal(isWordLookup('apple'), true);
  assert.equal(isWordLookup('  ephemeral  '), true);
  assert.equal(isWordLookup("don't"), true);
  assert.equal(isWordLookup('well-being'), true);
});

test('isWordLookup: short Chinese terms (1-4 chars)', () => {
  assert.equal(isWordLookup('苹果'), true);
  assert.equal(isWordLookup('缘'), true);
  assert.equal(isWordLookup('画蛇添足'), true);
});

test('isWordLookup: sentences and long input are not lookups', () => {
  assert.equal(isWordLookup('hello world'), false);
  assert.equal(isWordLookup('今天天气真好'), false);
  assert.equal(isWordLookup('我们去公园。'), false);
  assert.equal(isWordLookup('It works!'), false);
});

test('isWordLookup: edge cases', () => {
  assert.equal(isWordLookup(''), false);
  assert.equal(isWordLookup('   '), false);
  assert.equal(isWordLookup('123'), false);
  assert.equal(isWordLookup('-dash'), false);
  assert.equal(isWordLookup('苹果apple'), false);
});

test('containsCJK', () => {
  assert.equal(containsCJK('hello 世界'), true);
  assert.equal(containsCJK('苹果'), true);
  assert.equal(containsCJK('hello world'), false);
  assert.equal(containsCJK(''), false);
});
