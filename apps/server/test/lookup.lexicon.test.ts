import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { WordContentSchema } from '../src/modules/pipeline/schemas.ts';
import {
  LEXICON_VERSION,
  LexiconEntrySchema,
  lexiconKey,
  LookupBody,
  LookupContextSchema,
  type LexiconEntry,
} from '../src/modules/lookup/lexicon.ts';

const entry = (): LexiconEntry => ({
  lemma: 'decision',
  ipa: { us: '/dɪˈsɪʒ.ən/', uk: '/dɪˈsɪʒ.ən/' },
  senses: [{ pos: 'n.', gloss: '决定', def: 'A choice that you make after thinking about it.' }],
  forms: [{ label: '复数', form: 'decisions' }],
  collocations: [{ text: 'make a decision', gloss: '做决定' }],
  examples: [
    { text: 'It was a hard decision.', gloss: '这是个艰难的决定。' },
    { text: 'We need a decision by Friday.', gloss: '我们周五前需要一个决定。' },
  ],
  contrasts: [{ word: 'choice', note: 'choice 强调可选项，decision 强调下定决心' }],
  memory: 'de- + cis（切）→ 切断犹豫',
});

describe('LexiconEntry (pure)', () => {
  test('a complete entry passes; extra keys are stripped', () => {
    const parsed = LexiconEntrySchema.parse({ ...entry(), examTags: ['CET4'], frequency: 5 });
    assert.deepEqual(parsed, entry());
    assert.equal(LEXICON_VERSION, 1);
  });

  test('limits: senses 1–6, examples 2–4, slash-wrapped IPA, bounded strings', () => {
    const bad: Partial<Record<keyof LexiconEntry, unknown>>[] = [
      { senses: [] },
      { senses: Array.from({ length: 7 }, () => entry().senses[0]) },
      { examples: entry().examples.slice(0, 1) },
      { ipa: { us: 'dɪˈsɪʒ.ən', uk: '/dɪˈsɪʒ.ən/' } },
      { ipa: { us: '/dɪˈsɪʒ.ən/' } },
      { lemma: 'x'.repeat(61) },
      { lemma: '' },
      { forms: Array.from({ length: 9 }, () => ({ label: 'l', form: 'f' })) },
      { contrasts: Array.from({ length: 5 }, () => ({ word: 'w', note: 'n' })) },
      { memory: 'm'.repeat(301) },
    ];
    for (const patch of bad) {
      assert.equal(LexiconEntrySchema.safeParse({ ...entry(), ...patch }).success, false, JSON.stringify(patch));
    }
    assert.equal(LexiconEntrySchema.safeParse({ ...entry(), memory: '' }).success, true, 'memory may be empty');
    assert.equal(LexiconEntrySchema.safeParse({ ...entry(), memory: '记'.repeat(300) }).success, true, 'code points, not bytes');
  });

  test('an entry maps onto a word item content (WordContent) without clipping', () => {
    const e = entry();
    const content = {
      headword: e.lemma,
      ipa: e.ipa.us,
      meanings: e.senses.map(({ pos, gloss }) => ({ pos, zh: gloss })),
      examples: e.examples.slice(0, 2).map(({ text, gloss }) => ({ en: text, zh: gloss, fromUser: false })),
      collocations: e.collocations.map(({ text }) => text),
      synonyms: e.contrasts.map(({ word, note }) => ({ word, note })),
      family: e.forms.map(({ form }) => form),
    };
    assert.equal(WordContentSchema.safeParse(content).success, true);
  });

  test('context: meaning and an optional phrase', () => {
    assert.equal(LookupContextSchema.safeParse({ meaning: '决定', phrase: null }).success, true);
    assert.equal(LookupContextSchema.safeParse({ meaning: '决定', phrase: { text: 'make a decision', gloss: '做决定' } }).success, true);
    assert.equal(LookupContextSchema.safeParse({ meaning: '', phrase: null }).success, false);
    assert.equal(LookupContextSchema.safeParse({ meaning: '决定' }).success, false);
  });
});

describe('POST /v1/lookup body (pure)', () => {
  test('word: trimmed, whitespace collapsed, curly quotes straightened; empty sentence is absent', () => {
    const blank = LookupBody.parse({ word: '  look   forward ', sentence: '  ' });
    assert.equal(blank.word, 'look forward');
    assert.equal(blank.sentence, undefined);
    assert.equal(LookupBody.parse({ word: 'don’t' }).word, "don't");
    assert.deepEqual(
      LookupBody.parse({ word: 'decisions', sentence: 'Big decisions take time.', entryId: '01JD0000000000000000000000' }),
      { word: 'decisions', sentence: 'Big decisions take time.', entryId: '01JD0000000000000000000000' },
    );
  });

  test('rejects empty, too long, letterless, unknown keys and bad entry ids', () => {
    const bad: unknown[] = [
      {},
      { word: '' },
      { word: '   ' },
      { word: 'a'.repeat(65) },
      { word: '1234' },
      { word: '决定' },
      { word: 'ok', sentence: 'x'.repeat(2001) },
      { word: 'ok', entryId: 'not-a-ulid' },
      { word: 'ok', lang: 'en' },
    ];
    for (const body of bad) assert.equal(LookupBody.safeParse(body).success, false, JSON.stringify(body));
    assert.equal(LookupBody.safeParse({ word: 'a'.repeat(64) }).success, true);
    assert.equal(LookupBody.safeParse({ word: 'café' }).success, true);
  });

  test('lexiconKey: the word item normKey (lowercase, collapsed, straight quotes)', () => {
    assert.equal(lexiconKey('  Look  Forward To '), 'look forward to');
    assert.equal(lexiconKey('Don’t'), "don't");
  });
});
