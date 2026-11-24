import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ulid } from '@t-cli/core/ulid';
import { cards, items, lexicon, users } from '../src/db/schema.ts';
import { LEXICON_VERSION, type LexiconEntry } from '../src/modules/lookup/lexicon.ts';
import { TTS_VOICES } from '../src/modules/tts/routes.ts';
import { buildTestApp, fakeAudio, fakeTts, fixedClock, testConfig, type FakeTts } from './helpers/app.ts';
import { captureLogs } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import type { TestAccount } from './helpers/fixtures.ts';
import { createLearner } from './helpers/learning.ts';

const lexiconEntry = (lemma: string, gloss: string): LexiconEntry => ({
  lemma,
  ipa: { us: '/dɪˈsɪʒ.ən/', uk: '/dɪˈsɪʒ.ən/' },
  senses: [{ pos: 'n.', gloss, def: 'A choice that you make after thinking about it.' }],
  forms: [],
  collocations: [],
  examples: [
    { text: `It was a hard ${lemma}.`, gloss: `${gloss} 例句一` },
    { text: `We need a ${lemma} by Friday.`, gloss: `${gloss} 例句二` },
    { text: `Every ${lemma} has a cost.`, gloss: `${gloss} 例句三` },
  ],
  contrasts: [],
  memory: '',
});

describe('speech (v2): sentence items and lexicon entries', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let tts: FakeTts;
  const clock = fixedClock();
  before(async () => {
    t = await createTestDatabase();
    tts = fakeTts();
    app = await buildTestApp(t.db, { tts, clock, config: testConfig({ TTS_REQUESTS_PER_MINUTE: '1000' }) });
    // The shared lexicon: one entry per explanation language and version.
    await t.db.insert(lexicon).values([
      { lang: 'en', explainLang: 'zh', lemma: 'decision', version: LEXICON_VERSION, content: lexiconEntry('decision', '决定') },
      { lang: 'en', explainLang: 'en', lemma: 'decision', version: LEXICON_VERSION, content: lexiconEntry('Decision', 'a choice') },
      { lang: 'en', explainLang: 'zh', lemma: 'look forward to', version: LEXICON_VERSION, content: lexiconEntry('look forward to', '期待') },
      { lang: 'en', explainLang: 'zh', lemma: 'obsolete', version: LEXICON_VERSION + 1, content: lexiconEntry('obsolete', '过时的') },
      { lang: 'en', explainLang: 'zh', lemma: 'stale', version: LEXICON_VERSION - 1, content: lexiconEntry('stale', '陈旧的') },
      { lang: 'fr', explainLang: 'zh', lemma: 'bonjour', version: LEXICON_VERSION, content: lexiconEntry('bonjour', '你好') },
      { lang: 'en', explainLang: 'en', lemma: 'onlyenglish', version: LEXICON_VERSION, content: lexiconEntry('onlyenglish', 'gloss') },
    ]);
  });
  after(async () => {
    await app?.close();
    await t?.drop();
  });

  const speak = (account: TestAccount, payload: unknown) =>
    app.inject({ method: 'POST', url: '/v1/tts', headers: account.headers, payload: payload as Record<string, unknown> });

  async function expectSpoken(account: TestAccount, payload: unknown, text: string, voice: string = TTS_VOICES.en): Promise<void> {
    const res = await speak(account, payload);
    assert.equal(res.statusCode, 200, `${JSON.stringify(payload)}: ${res.body}`);
    assert.equal(res.headers['content-type'], 'audio/mpeg');
    assert.equal(res.headers['x-speech-parts'], '1');
    assert.deepEqual(res.rawPayload, fakeAudio(text, voice));
  }

  async function expectNotFound(account: TestAccount, payload: unknown): Promise<void> {
    const res = await speak(account, payload);
    assert.equal(res.statusCode, 404, JSON.stringify(payload));
    assert.equal(res.json().error.code, 'NOT_FOUND');
  }

  async function seedSentence(userId: string, text: string, { content = { text, translation: '译文' } }: { content?: Record<string, unknown> | null } = {}) {
    const itemId = ulid();
    const now = clock();
    await t.db.insert(items).values({
      userId,
      id: itemId,
      type: 'sentence',
      normKey: ulid(),
      display: text,
      content,
      status: 'ready',
      firstSeenAt: now,
      lastSeenAt: now,
    });
    return itemId;
  }

  test('a sentence item reads its text', async () => {
    const account = await createLearner(t.db, { now: clock() });
    const itemId = await seedSentence(account.userId, 'I will look into it tomorrow.');
    await expectSpoken(account, { itemId }, 'I will look into it tomorrow.');
    // Without content the display (the sentence) is read.
    const bare = await seedSentence(account.userId, 'Display only sentence.', { content: null });
    await expectSpoken(account, { itemId: bare }, 'Display only sentence.');
  });

  test("a recall card reads its sentence (the back), another account's sentence is 404", async () => {
    const account = await createLearner(t.db, { now: clock() });
    const itemId = await seedSentence(account.userId, 'Could you send me the file?');
    const cardId = ulid();
    await t.db.insert(cards).values({
      userId: account.userId,
      id: cardId,
      itemId,
      cardType: 'recall',
      front: { text: '你能把文件发给我吗？' },
      back: { text: 'Could you send me the file?' },
      due: clock(),
    });
    await expectSpoken(account, { cardId }, 'Could you send me the file?');

    const other = await createLearner(t.db, { now: clock() });
    await expectNotFound(other, { itemId });
    await expectNotFound(other, { cardId });
  });

  test('a long sentence item is read in parts', async () => {
    const account = await createLearner(t.db, { now: clock() });
    const sentence = `${'word '.repeat(300)}end`; // 1503 code points, one sentence
    const itemId = await seedSentence(account.userId, sentence);
    const first = await speak(account, { itemId });
    assert.equal(first.headers['x-speech-parts'], '2');
    const second = await speak(account, { itemId, part: 1 });
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers['x-speech-part'], '1');
  });

  test("a lexicon entry reads its lemma or one of its examples, in the caller's explanation language", async () => {
    const account = await createLearner(t.db, { now: clock() });
    await expectSpoken(account, { lexicon: { lemma: 'decision' } }, 'decision');
    await expectSpoken(account, { lexicon: { lemma: 'decision', example: 0 } }, 'It was a hard decision.');
    await expectSpoken(account, { lexicon: { lemma: 'decision', example: 2 } }, 'Every decision has a cost.');
    // The lemma is keyed like lexicon.lemma: case, curly quotes and whitespace do not matter.
    await expectSpoken(account, { lexicon: { lemma: '  Decision ' } }, 'decision');
    await expectSpoken(account, { lexicon: { lemma: 'Look   forward\tto', example: 1 } }, 'We need a look forward to by Friday.');

    // explanationLang en → the en row (its own lemma display form and examples).
    await t.db.update(users).set({ settings: { explanationLang: 'en' } }).where(eq(users.id, account.userId));
    await expectSpoken(account, { lexicon: { lemma: 'decision' } }, 'Decision');
    await expectSpoken(account, { lexicon: { lemma: 'onlyenglish', example: 1 } }, 'We need a onlyenglish by Friday.');
    await expectNotFound(account, { lexicon: { lemma: 'look forward to' } });
  });

  test('an entry that is not cached for this language and version, or a missing example, is 404', async () => {
    const account = await createLearner(t.db, { now: clock() });
    const calls = tts.calls.length;
    for (const payload of [
      { lexicon: { lemma: 'serendipity' } },
      { lexicon: { lemma: 'obsolete' } },
      { lexicon: { lemma: 'stale' } },
      { lexicon: { lemma: 'bonjour' } },
      { lexicon: { lemma: 'onlyenglish' } },
      { lexicon: { lemma: 'decision', example: 3 } },
      { lexicon: { lemma: 'decision', example: 1000 } },
    ]) {
      await expectNotFound(account, payload);
    }
    assert.equal(tts.calls.length, calls);
  });

  test('reading a lexicon entry aloud does not count a lookup hit', async () => {
    const account = await createLearner(t.db, { now: clock() });
    await expectSpoken(account, { lexicon: { lemma: 'decision', example: 1 } }, 'We need a decision by Friday.');
    const rows = await t.db.select({ hits: lexicon.hits }).from(lexicon).where(eq(lexicon.lemma, 'decision'));
    assert.deepEqual(rows.map((row) => row.hits), [0, 0]);
  });

  test('the lexicon target is validated strictly', async () => {
    const account = await createLearner(t.db, { now: clock() });
    for (const payload of [
      { lexicon: {} },
      { lexicon: { lemma: '' } },
      { lexicon: { lemma: '   ' } },
      { lexicon: { lemma: 'x'.repeat(61) } },
      { lexicon: { lemma: 42 } },
      { lexicon: { lemma: 'decision', example: -1 } },
      { lexicon: { lemma: 'decision', example: 0.5 } },
      { lexicon: { lemma: 'decision', example: '0' } },
      { lexicon: { lemma: 'decision', accent: 'uk' } },
      { lexicon: { lemma: 'decision' }, itemId: ulid() },
      { lexicon: 'decision' },
    ]) {
      const res = await speak(account, payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
  });

  test('logs name the lexicon target and example, never the lemma', async (ctx) => {
    const traced = await buildTestApp(t.db, { tts: fakeTts(), clock, config: testConfig({ LOG_LEVEL: 'trace' }) });
    ctx.after(() => traced.close());
    const logs = captureLogs(traced);
    const account = await createLearner(t.db, { now: clock() });
    const res = await traced.inject({ method: 'POST', url: '/v1/tts', headers: account.headers, payload: { lexicon: { lemma: 'decision', example: 1 } } });
    assert.equal(res.statusCode, 200);
    const missing = await traced.inject({ method: 'POST', url: '/v1/tts', headers: account.headers, payload: { lexicon: { lemma: 'confidentiallemma' } } });
    assert.equal(missing.statusCode, 404);
    const text = logs.text();
    assert.ok(!text.includes('decision'));
    assert.ok(!text.includes('confidentiallemma'));
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'tts request');
    assert.deepEqual(
      lines.map((l) => ({ target: l.target, targetId: l.targetId, example: l.example, outcome: l.outcome })),
      [
        { target: 'lexicon', targetId: undefined, example: 1, outcome: 'ok' },
        { target: 'lexicon', targetId: undefined, example: null, outcome: 'not_found' },
      ],
    );
  });
});
