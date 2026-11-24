import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ulid } from '@t-cli/core/ulid';
import { cardsFor, parseSentenceContent } from '../src/modules/pipeline/cards.ts';
import { sentenceKey, wordContentFromLexicon } from '../src/modules/notes/content.ts';
import { PutNoteBody } from '../src/modules/notes/schemas.ts';
import { lexiconEntry } from './helpers/notes.ts';

const base = { kind: 'word', text: 'decision', lang: 'en', stars: 1 } as const;
const issuesOf = (body: unknown): string[] => {
  const parsed = PutNoteBody.safeParse(body);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));
};

describe('notes: request body', () => {
  test('words and phrases are normalised: whitespace collapsed, curly quotes straightened', () => {
    const parsed = PutNoteBody.parse({ ...base, kind: 'phrase', text: '  can’t   help \n it ', lemma: ' can’t  help ' });
    assert.equal(parsed.text, "can't help it");
    assert.equal(parsed.lemma, "can't help");
  });

  test('sentences are only trimmed, and ignore the lemma', () => {
    const parsed = PutNoteBody.parse({ ...base, kind: 'sentence', text: '  It’s  a  deal.  ', lemma: 'deal' });
    assert.equal(parsed.text, 'It’s  a  deal.');
    assert.equal(parsed.lemma, undefined);
  });

  test('an empty translation counts as absent; a translation is trimmed', () => {
    assert.equal(PutNoteBody.parse({ ...base, translation: '   ' }).translation, undefined);
    assert.equal(PutNoteBody.parse({ ...base, translation: ' 决定 ' }).translation, '决定');
  });

  test('limits per kind, in code points', () => {
    assert.deepEqual(issuesOf({ ...base, text: 'a'.repeat(64) }), []);
    assert.deepEqual(issuesOf({ ...base, text: 'a'.repeat(65) }), ['text']);
    assert.deepEqual(issuesOf({ ...base, kind: 'sentence', text: '😀'.repeat(2000) }), []);
    assert.deepEqual(issuesOf({ ...base, kind: 'sentence', text: 'a'.repeat(2001) }), ['text']);
    assert.deepEqual(issuesOf({ ...base, translation: '字'.repeat(2000) }), []);
    assert.deepEqual(issuesOf({ ...base, translation: '字'.repeat(2001) }), ['translation']);
    assert.deepEqual(issuesOf({ ...base, lemma: 'a'.repeat(60) }), []);
    assert.deepEqual(issuesOf({ ...base, lemma: 'a'.repeat(61) }), ['lemma']);
    assert.deepEqual(issuesOf({ ...base, lemma: '  ' }), ['lemma']);
  });

  test('a word or phrase needs a Latin letter; a sentence does not', () => {
    assert.deepEqual(issuesOf({ ...base, text: '决定' }), ['text']);
    assert.deepEqual(issuesOf({ ...base, text: '   ' }), ['text']);
    assert.deepEqual(issuesOf({ ...base, kind: 'sentence', text: '这是一句话。' }), []);
    assert.deepEqual(issuesOf({ ...base, kind: 'sentence', text: '  ' }), ['text']);
  });

  test('strict: unknown keys, other languages, stars outside 1–4 and non-ULID entry ids are rejected', () => {
    assert.ok(issuesOf({ ...base, extra: 1 }).length > 0);
    assert.deepEqual(issuesOf({ ...base, lang: 'fr' }), ['lang']);
    for (const stars of [0, 5, 1.5, '2']) assert.deepEqual(issuesOf({ ...base, stars }), ['stars'], String(stars));
    assert.deepEqual(issuesOf({ ...base, kind: 'idiom' }), ['kind']);
    assert.deepEqual(issuesOf({ ...base, entryId: 'not-a-ulid' }), ['entryId']);
    assert.deepEqual(issuesOf({ ...base, entryId: ulid() }), []);
  });
});

describe('notes: word content from the lexicon', () => {
  test('maps the entry onto the word content shape (first two examples, glosses as zh)', () => {
    assert.deepEqual(wordContentFromLexicon(lexiconEntry('decision')), {
      headword: 'decision',
      ipa: '/dɪˈsɪʒən/',
      meanings: [
        { pos: 'n.', zh: '决定' },
        { pos: 'n.', zh: '果断' },
      ],
      examples: [
        { en: 'It was a hard decision to make.', zh: '这是个艰难的决定。', fromUser: false },
        { en: 'We reached the decision together.', zh: '我们一起做出了决定。', fromUser: false },
      ],
      collocations: ['make a decision', 'a final decision'],
      synonyms: [{ word: 'choice', note: 'choice 强调在选项中挑选' }],
      family: ['decisions', 'decide'],
    });
  });

  test('the content makes the three word cards', () => {
    const content = wordContentFromLexicon(lexiconEntry('decision'));
    assert.ok(content);
    assert.deepEqual(cardsFor({ type: 'word', content }).map((card) => card.cardType), ['recognize', 'produce', 'cloze']);
  });

  test('null when the entry is invalid or no example has the headword (no cloze card possible)', () => {
    assert.equal(wordContentFromLexicon({ lemma: 'decision' }), null);
    assert.equal(wordContentFromLexicon(null), null);
    const noTarget = lexiconEntry('decision', {
      examples: [
        { text: 'Nothing to see here.', gloss: '没有。' },
        { text: 'Still nothing.', gloss: '还是没有。' },
        { text: 'Only the third has the decision.', gloss: '只有第三个有。' },
      ],
    });
    assert.equal(wordContentFromLexicon(noTarget), null, 'only the first two examples are used');
  });
});

describe('notes: sentence items', () => {
  test('the key is the SHA-256 of the lowercased, whitespace-collapsed text', () => {
    const expected = createHash('sha256').update('it is a deal.').digest('hex');
    assert.equal(sentenceKey('  It   is a\nDEAL. '), expected);
    assert.match(sentenceKey('x'.repeat(2000)), /^[0-9a-f]{64}$/);
  });

  test('one recall card: the translation in front, the sentence on the back; none without a translation', () => {
    assert.deepEqual(cardsFor({ type: 'sentence', content: { text: 'It is a deal.', translation: '一言为定。' } }), [
      { cardType: 'recall', front: { text: '一言为定。' }, back: { text: 'It is a deal.' } },
    ]);
    assert.deepEqual(cardsFor({ type: 'sentence', content: { text: 'It is a deal.', translation: null } }), []);
  });

  test('stored sentence content is re-validated on read', () => {
    assert.deepEqual(parseSentenceContent({ text: 'Hi.', translation: '嗨。' }), { text: 'Hi.', translation: '嗨。' });
    assert.deepEqual(parseSentenceContent({ text: 'Hi.', translation: null }), { text: 'Hi.', translation: null });
    assert.equal(parseSentenceContent({ text: '', translation: null }), null);
    assert.equal(parseSentenceContent({ text: 'Hi.', translation: 3 }), null);
    assert.equal(parseSentenceContent(null), null);
  });
});
