import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHeadTerm, detectSpellingCorrection } from '../src/spelling.js';

test('extractHeadTerm: word before the IPA on the first line', () => {
  assert.equal(extractHeadTerm('prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑'), 'prioritize');
  assert.equal(extractHeadTerm('\n**trade-off** /ˈtreɪd.ɔːf/\n权衡'), 'trade-off');
  assert.equal(extractHeadTerm('look forward to /lʊk ˈfɔːr.wɚd tə/ 期待'), 'look forward to');
});

test('extractHeadTerm: null when the first line has no "term /ipa/" shape', () => {
  assert.equal(extractHeadTerm('优先考虑'), null);
  assert.equal(extractHeadTerm(''), null);
  assert.equal(extractHeadTerm('/praɪˈɔːr.ə.taɪz/ only ipa'), null);
});

const LOOKUP = { srcLang: 'en', kind: 'word' };

test('detectSpellingCorrection: misspelled input yields the head term', () => {
  assert.equal(
    detectSpellingCorrection({ ...LOOKUP, input: 'prioritiz', output: 'prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑' }),
    'prioritize',
  );
});

test('detectSpellingCorrection: same word (any case) is not a correction', () => {
  assert.equal(detectSpellingCorrection({ ...LOOKUP, input: 'Prioritize', output: 'prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑' }), null);
});

test('detectSpellingCorrection: echoed misspelling cannot be detected here', () => {
  // The old prompt echoed the source word; only the audit can catch these.
  assert.equal(detectSpellingCorrection({ ...LOOKUP, input: 'prioritiz', output: 'prioritiz /praɪˈɔːrətaɪz/ 优先处理' }), null);
});

test('detectSpellingCorrection: only English word lookups qualify', () => {
  const output = 'checkpoint /ˈtʃek.pɔɪnt/';
  assert.equal(detectSpellingCorrection({ input: '把关', output, srcLang: 'zh', kind: 'word' }), null);
  assert.equal(detectSpellingCorrection({ input: 'prioritiz this', output, srcLang: 'en', kind: 'sentence' }), null);
  assert.equal(detectSpellingCorrection({ input: 'checkpoin', output, srcLang: 'other', kind: 'word' }), null);
  assert.equal(detectSpellingCorrection({ input: 'checkpoin', output, srcLang: null, kind: 'word' }), null);
});
