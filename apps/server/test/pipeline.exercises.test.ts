import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EXERCISE_CAPS, ExtendContentSchema, exercisesFor } from '../src/modules/pipeline/learnContent.ts';
import type { GrammarContent, PhraseContent, WordContent } from '../src/modules/pipeline/schemas.ts';
import { cannedGrammar, cannedPhrase, cannedWord } from './helpers/pipeline.ts';

const word = (headword: string, examples?: WordContent['examples']): { itemId: string } & WordContent => {
  const base = cannedWord(headword) as unknown as WordContent;
  return { itemId: `w-${headword}`, ...base, ...(examples ? { examples } : {}) };
};
const phrase = (text: string): { itemId: string } & PhraseContent => ({ itemId: `p-${text}`, ...(cannedPhrase(text) as unknown as PhraseContent) });
const grammar = (title: string): { itemId: string } & GrammarContent => ({ itemId: `g-${title}`, ...(cannedGrammar(title) as unknown as GrammarContent) });

describe('exercisesFor (pure)', () => {
  test('blanks the form the example uses, keeps the base in a sorted bank with one spare word', () => {
    const postpone = word('postpone', [
      { en: 'They postponed the launch by a week.', zh: '他们把发布推迟了一周。', fromUser: false },
      { en: 'Never postpone a hard talk.', zh: '别拖延难谈的话。', fromUser: false },
    ]);
    const go = word('go', [
      { en: 'She went home early.', zh: '她早早回家了。', fromUser: false },
      { en: 'We went there twice.', zh: '我们去过两次。', fromUser: false },
    ]);
    const result = exercisesFor({ words: [postpone, word('deadline'), go], phrases: [phrase('look forward to')], grammar: [] });

    assert.deepEqual(result.cloze[0], {
      itemId: 'w-postpone',
      before: 'They ',
      after: ' the launch by a week.',
      answer: 'postponed',
      base: 'postpone',
      zh: '他们把发布推迟了一周。',
    });
    assert.deepEqual(
      result.cloze.map((c) => [c.base, c.answer]),
      [
        ['postpone', 'postponed'],
        ['deadline', 'deadline'],
        ['go', 'went'],
        ['look forward to', 'look forward to'],
      ],
      'irregular forms are found too',
    );
    assert.deepEqual(result.bank, ['deadline', 'go', 'look forward to', 'postpone']);
  });

  test('a unit whose examples never use it is left out of the cloze and becomes the spare', () => {
    const leave = word('leave', [
      { en: 'She walked out before lunch.', zh: '她午饭前走了。', fromUser: false },
      { en: 'We walked out.', zh: '我们走了。', fromUser: false },
    ]);
    const result = exercisesFor({ words: [word('alpha'), leave], phrases: [], grammar: [] });
    assert.deepEqual(result.cloze.map((c) => c.base), ['alpha']);
    assert.deepEqual(result.bank, ['alpha', 'leave']);
  });

  test('translations prefer units the cloze did not use, shortest English first, at most 3', () => {
    const leave = word('leave', [
      { en: 'She walked out before lunch because she felt sick that afternoon.', zh: '她那天下午不舒服，午饭前就走了。', fromUser: false },
      { en: 'We walked out.', zh: '我们走了。', fromUser: false },
    ]);
    const result = exercisesFor({ words: [word('alpha'), leave, word('beta'), word('gamma')], phrases: [], grammar: [] });
    assert.equal(result.translate.length, EXERCISE_CAPS.translate);
    assert.deepEqual(result.translate[0], { itemId: 'w-leave', zh: '我们走了。', answer: 'We walked out.' });
    assert.deepEqual(result.translate[1]?.itemId, 'w-alpha', 'then the cloze units, in material order');
  });

  test('fix exercises come from grammar points, capped', () => {
    const result = exercisesFor({ words: [], phrases: [], grammar: [grammar('三单'), grammar('过去时')] });
    assert.equal(result.fix.length, EXERCISE_CAPS.fix);
    assert.deepEqual(result.fix[0], { itemId: 'g-三单', wrong: 'She like tea.', right: 'She likes tea.' });
    assert.deepEqual(result.bank, []);
    assert.deepEqual(result.cloze, []);
  });

  test('cloze is capped and the result is deterministic', () => {
    const words = Array.from({ length: 12 }, (_, i) => word(`word${String.fromCharCode(97 + i)}`));
    const first = exercisesFor({ words, phrases: [], grammar: [] });
    assert.equal(first.cloze.length, EXERCISE_CAPS.cloze);
    assert.deepEqual(exercisesFor({ words, phrases: [], grammar: [] }), first);
  });
});

describe('ExtendContentSchema (pure)', () => {
  const item = (text: string) => ({ text, kind: 'phrase', gloss: '意思', example: { en: `Use ${text} here.`, zh: '这里用它。' } });
  const valid = {
    focus: 'topic',
    topic: 'work',
    title: '职场邮件里常说的 10 个表达',
    level: 'B1',
    reasons: ['最近 7 天你查了 deadline 等 6 个职场用词'],
    evidence: ['deadline', 'circle back'],
    items: ['heads-up', 'loop in', 'touch base', 'action item', 'going forward', 'as per'].map(item),
    passage: null,
    grammar: null,
  };

  test('accepts a well-formed extension and strips unknown keys', () => {
    const parsed = ExtendContentSchema.parse({ ...valid, extra: 'dropped' });
    assert.equal('extra' in parsed, false);
  });

  test('needs 6–10 items, a known topic and level', () => {
    assert.equal(ExtendContentSchema.safeParse({ ...valid, items: valid.items.slice(0, 5) }).success, false);
    assert.equal(ExtendContentSchema.safeParse({ ...valid, topic: 'gardening' }).success, false);
    assert.equal(ExtendContentSchema.safeParse({ ...valid, level: 'C2' }).success, false);
  });
});
