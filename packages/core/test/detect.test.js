import test from 'node:test';
import assert from 'node:assert/strict';
import { isWordLookup, containsCJK, detectSourceLang } from '../src/detect.js';

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

const SOURCE_LANG_TABLE = [
  // [input, expected, why]
  ['今天天气真好', 'zh', 'Chinese'],
  ['這個問題很簡單', 'zh', 'traditional Chinese'],
  ['日本語', 'zh', 'pure-Han Japanese is indistinguishable from Chinese'],
  ['会議室を予約しました', 'other', 'Japanese with kana'],
  ['ありがとう', 'other', 'hiragana only'],
  ['ラーメン', 'other', 'katakana only'],
  ['ｶﾀｶﾅ', 'other', 'halfwidth katakana'],
  ['안녕하세요', 'other', 'Korean'],
  ['한국語', 'other', 'Korean with hanja: kana/Hangul wins over Han'],
  ['привет', 'other', 'Russian'],
  ['Καλημέρα', 'other', 'Greek'],
  ['สวัสดี', 'other', 'Thai'],
  ['مرحبا', 'other', 'Arabic'],
  ['Hello, мир', 'other', 'English mixed with Cyrillic'],
  ['café crème à la mode', 'en', 'French with accents is Latin script'],
  ['Straße', 'en', 'German'],
  ['Tiếng Việt', 'en', 'Vietnamese is Latin script'],
  ['这个 bug 很难 debug', 'zh', 'mixed Chinese/English'],
  ['deploy 到 prod', 'zh', 'mixed English/Chinese'],
  ['约翰・史密斯', 'zh', 'the katakana middle dot is Script=Common'],
  ['我在学 привет 这个词', 'zh', 'Han wins over Cyrillic'],
  ['12345 !?', 'en', 'digits and punctuation only'],
  ['5µm', 'en', 'the micro sign is a Common-script letter'],
  ['😀👍', 'en', 'emoji only'],
  ['   ', 'en', 'whitespace only'],
];

test('detectSourceLang: script table (docs/api-v1.md, srcLang)', () => {
  for (const [input, expected, why] of SOURCE_LANG_TABLE) {
    assert.equal(detectSourceLang(input), expected, `${JSON.stringify(input)}: ${why}`);
  }
});

test('detectSourceLang: null and undefined fall back to English', () => {
  assert.equal(detectSourceLang(null), 'en');
  assert.equal(detectSourceLang(undefined), 'en');
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
