// /note: how the last result becomes a note (pure).
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTHING_YET, bestTranslation, draftNote, glossOf } from '../src/utils/noteDraft.js';

/** A last result with defaults (simple mode, English source). */
const result = (fields) => ({
  task: 'translate', input: '', output: '', srcLang: 'en', simple: true,
  entryId: null, noteId: null, stars: null, ...fields,
});

const note = (kind, text, translation) => ({ ok: true, note: { kind, text, translation } });

test('draftNote: nothing to save before the first result', () => {
  assert.deepEqual(draftNote(null), { ok: false, reason: NOTHING_YET });
});

test('draftNote: English word lookup → word note with the head term and the gloss', () => {
  assert.deepEqual(
    draftNote(result({ input: 'eliminate', output: 'eliminate /ɪˈlɪm.ə.neɪt/ 消除' })),
    note('word', 'eliminate', '消除'),
  );
  assert.deepEqual(
    draftNote(result({ input: 'nice-to-haves', output: 'nice-to-haves /ˌnaɪs.təˈhævz/ 加分项；锦上添花的东西\n' })),
    note('word', 'nice-to-haves', '加分项；锦上添花的东西'),
  );
  // A second IPA inside the gloss is kept as part of it.
  assert.deepEqual(
    draftNote(result({ input: 'advocate', output: 'advocate /ˈæv.ə.kət/ 拥护者（动词读作 /ˈæv.ə.keɪt/）' })),
    note('word', 'advocate', '拥护者（动词读作 /ˈæv.ə.keɪt/）'),
  );
});

test('draftNote: a misspelled English word is saved with its corrected spelling', () => {
  assert.deepEqual(
    draftNote(result({ input: 'acheived', output: 'achieved /əˈtʃiːvd/ 实现了；达到了' })),
    note('word', 'achieved', '实现了；达到了'),
  );
});

test('draftNote: detail-mode English word takes the first Chinese body line, skipping headings and notes', () => {
  const output = [
    '**eliminate /ɪˈlɪm.ə.neɪt/**',
    '',
    '注意："eliminte" 拼写有误，正确拼写为 "eliminate"。',
    '**中文翻译：**',
    '1. **消除；排除** —— 去掉不需要的东西',
    '2. 淘汰',
  ].join('\n');
  assert.deepEqual(
    draftNote(result({ input: 'eliminte', output, simple: false })),
    note('word', 'eliminate', '消除；排除 —— 去掉不需要的东西'),
  );
  // No Chinese line at all → no translation, the word is still saved.
  assert.deepEqual(
    draftNote(result({ input: 'eliminate', output: 'eliminate /ɪˈlɪm.ə.neɪt/\n\nTo remove completely.', simple: false })),
    note('word', 'eliminate', null),
  );
});

test('draftNote: Chinese word lookup → the English head term, translated by what the user typed', () => {
  assert.deepEqual(
    draftNote(result({ input: '苹果', output: 'apple /ˈæp.əl/', srcLang: 'zh' })),
    note('word', 'apple', '苹果'),
  );
  // Several English words are a phrase note.
  assert.deepEqual(
    draftNote(result({ input: ' 期待 ', output: 'look forward to /lʊk ˈfɔːr.wɚd tuː/\n\n1. look forward to — 最常用', srcLang: 'zh', simple: false })),
    note('phrase', 'look forward to', '期待'),
  );
  // Without the "term /ipa/" shape the first line, cleaned, is the English side.
  assert.deepEqual(
    draftNote(result({ input: '苹果', output: 'Apple', srcLang: 'zh' })),
    note('word', 'Apple', '苹果'),
  );
});

test('draftNote: English word without a parsable head falls back to the input', () => {
  assert.deepEqual(
    draftNote(result({ input: 'serendipity', output: '意外发现珍奇事物的本领' })),
    note('word', 'serendipity', '意外发现珍奇事物的本领'),
  );
});

test('draftNote: an unrecognized word or a Chinese lookup without English is not saved', () => {
  const unknown = draftNote(result({ input: 'qwzxkj', output: 'qwzxkj — 无法识别的单词' }));
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /not recognized/);
  const noEnglish = draftNote(result({ input: '苹果', output: '苹果', srcLang: 'zh' }));
  assert.equal(noEnglish.ok, false);
  assert.match(noEnglish.reason, /English word/);
});

test('draftNote: English sentence → sentence note, the translation is the best line', () => {
  assert.deepEqual(
    draftNote(result({ input: 'She doesn\'t like it.', output: '她不喜欢它。' })),
    note('sentence', 'She doesn\'t like it.', '她不喜欢它。'),
  );
  assert.deepEqual(
    draftNote(result({ input: 'She doesn\'t like it.', output: '她不喜欢它。\n\n1. 她不喜欢这个。\n解释……', simple: false })),
    note('sentence', 'She doesn\'t like it.', '她不喜欢它。'),
  );
  // Pasted CRLF input is normalized like the stored record.
  assert.deepEqual(
    draftNote(result({ input: 'Line one.\r\nLine two.  ', output: '第一行。\n第二行。' })),
    note('sentence', 'Line one.\nLine two.', '第一行。\n第二行。'),
  );
});

test('draftNote: Chinese sentence → the English translation is the text, the source the translation', () => {
  assert.deepEqual(
    draftNote(result({ input: '我们明天再讨论吧。', output: 'Let\'s discuss it tomorrow.\n\n1. Standard ...', srcLang: 'zh', simple: false })),
    note('sentence', 'Let\'s discuss it tomorrow.', '我们明天再讨论吧。'),
  );
  // srcLang missing (older shape): detected from the input.
  assert.deepEqual(
    draftNote(result({ input: '我们明天再讨论吧。', output: 'Let\'s discuss it tomorrow.', srcLang: null })),
    note('sentence', 'Let\'s discuss it tomorrow.', '我们明天再讨论吧。'),
  );
});

test('draftNote: a result without an English side cannot be saved', () => {
  const other = draftNote(result({ input: 'ありがとうございます', output: '非常感谢', srcLang: 'other' }));
  assert.equal(other.ok, false);
  assert.match(other.reason, /Only English/);
});

test('draftNote: grammar check → sentence note with the corrected text, no translation', () => {
  const check = { task: 'check', input: 'She don\'t like it.', srcLang: 'en' };
  assert.deepEqual(
    draftNote(result({ ...check, output: 'She doesn\'t like it.' })),
    note('sentence', 'She doesn\'t like it.', null),
  );
  assert.deepEqual(
    draftNote(result({ ...check, output: 'She doesn\'t like it.\n\n1. 主谓不一致……', simple: false })),
    note('sentence', 'She doesn\'t like it.', null),
  );
});

test('draftNote: over the server limits is refused with a clear reason', () => {
  const long = `${'word '.repeat(450)}end.`; // > 2000 code points
  const tooLong = draftNote(result({ input: long, output: '很长。' }));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.reason, /Too long/);
});

test('bestTranslation / glossOf: markdown bold is dropped', () => {
  assert.equal(bestTranslation('**Hello there.**\n\nmore', false), 'Hello there.');
  assert.equal(bestTranslation('  **Hello**\nthere  ', true), 'Hello\nthere');
  assert.equal(glossOf('word /wɜːd/ — 单词'), '单词');
  assert.equal(glossOf(''), null);
});
