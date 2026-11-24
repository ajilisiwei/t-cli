import { after, before, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Entry } from '@t-cli/core/entry';
import { SPEECH_PART_MAX_CHARS, splitSpeechParts } from '@t-cli/core/speechParts';
import { insertEntries } from '../src/db/entriesRepo.ts';
import { TTS_VOICES } from '../src/modules/tts/routes.ts';
import { captureLogs } from './helpers/auth.ts';
import { buildTestApp, fakeAudio, fakeTts, fixedClock, testConfig, type FakeTts } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount, makeEntry, type TestAccount } from './helpers/fixtures.ts';
import { dailyMaterial, seedMaterial } from './helpers/learning.ts';

/** About 2 500 code points of English in distinct sentences: three different parts. */
const LONG_ENGLISH = Array.from({ length: 36 }, (_, i) => `Sentence ${i + 1} sends the quick brown fox over the lazy dog by the river.`).join(' ');

describe('speech in parts: POST /v1/tts with part', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  async function setup(ctx: TestContext, { tts = fakeTts(), config = {} }: { tts?: FakeTts; config?: Record<string, string> } = {}) {
    const clock = fixedClock();
    const app = await buildTestApp(t.db, { tts, clock, config: testConfig({ TTS_REQUESTS_PER_MINUTE: '1000', ...config }) });
    ctx.after(() => app.close());
    const account = await createAccount(t.db, { kind: 'mp', now: clock() });
    return { app, account, tts };
  }

  const speak = (app: FastifyInstance, account: TestAccount, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/tts', headers: account.headers, payload });

  async function store(account: TestAccount, input: string): Promise<Entry> {
    const entry = makeEntry({ input, output: '译文', srcLang: 'en' });
    await insertEntries(t.db, account.userId, [entry]);
    return entry;
  }

  test('a long text is read part by part; every 200 names the part and the count', async (ctx) => {
    const { app, account, tts } = await setup(ctx);
    const entry = await store(account, LONG_ENGLISH);
    const expected = splitSpeechParts(LONG_ENGLISH);
    assert.equal(expected.length, 3);

    const first = await speak(app, account, { entryId: entry.id });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['x-speech-part'], '0', 'no part → part 0');
    assert.equal(first.headers['x-speech-parts'], '3');
    assert.deepEqual(first.rawPayload, fakeAudio(expected[0]!, TTS_VOICES.en));

    for (const [part, text] of expected.entries()) {
      const res = await speak(app, account, { entryId: entry.id, part });
      assert.equal(res.statusCode, 200, `part ${part}`);
      assert.equal(res.headers['content-type'], 'audio/mpeg');
      assert.equal(res.headers['x-speech-part'], String(part));
      assert.equal(res.headers['x-speech-parts'], '3');
      assert.deepEqual(res.rawPayload, fakeAudio(text, TTS_VOICES.en));
      assert.ok([...text].length <= SPEECH_PART_MAX_CHARS);
    }
    assert.deepEqual(
      tts.calls.map((call) => call.text),
      expected,
      'each part is synthesized once (part 0 came from the cache the second time)',
    );
  });

  test('part ≥ the count → 422 PART_OUT_OF_RANGE with details.parts, without calling out', async (ctx) => {
    const { app, account, tts } = await setup(ctx);
    const long = await store(account, LONG_ENGLISH);
    const short = await store(account, 'Good morning.');
    for (const [entry, part, parts] of [[long, 3, 3], [long, 99, 3], [short, 1, 1]] as const) {
      const res = await speak(app, account, { entryId: entry.id, part });
      assert.equal(res.statusCode, 422, `part ${part}`);
      assert.match(String(res.headers['content-type']), /^application\/json/);
      assert.equal(res.json().error.code, 'PART_OUT_OF_RANGE');
      assert.deepEqual(res.json().error.details, { parts });
      assert.equal(res.headers['x-speech-parts'], undefined);
    }
    assert.equal(tts.calls.length, 0);
  });

  test('texts over 1000 code points no longer fail with TEXT_TOO_LONG', async (ctx) => {
    const { app, account } = await setup(ctx);
    const overLimit = 'é'.repeat(SPEECH_PART_MAX_CHARS + 1);
    const res = await speak(app, account, { entryId: (await store(account, overLimit)).id });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-speech-parts'], '2');
    assert.deepEqual(res.rawPayload, fakeAudio('é'.repeat(SPEECH_PART_MAX_CHARS), TTS_VOICES.en));
    const atLimit = 'é'.repeat(SPEECH_PART_MAX_CHARS);
    const whole = await speak(app, account, { entryId: (await store(account, atLimit)).id });
    assert.equal(whole.headers['x-speech-parts'], '1', 'up to 1000 code points: the whole text, as before');
  });

  test('the voice is chosen once for the whole text', async (ctx) => {
    const { app, account } = await setup(ctx);
    // Part 0 is plain English, but the text has CJK further on: every part gets the Chinese voice.
    const text = `${LONG_ENGLISH}\n最后一句是中文。`;
    const entry = await store(account, text);
    const parts = splitSpeechParts(text);
    assert.ok(!/[一-鿿]/u.test(parts[0]!));
    for (const [part, partText] of parts.entries()) {
      const res = await speak(app, account, { entryId: entry.id, part });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.rawPayload, fakeAudio(partText, TTS_VOICES.zh), `part ${part}`);
    }
  });

  test('audio is cached per voice and part text, across targets', async (ctx) => {
    const { app, account, tts } = await setup(ctx);
    const one = await store(account, LONG_ENGLISH);
    const two = await store(account, LONG_ENGLISH);
    assert.equal((await speak(app, account, { entryId: one.id, part: 1 })).statusCode, 200);
    assert.equal((await speak(app, account, { entryId: one.id, part: 1 })).statusCode, 200);
    assert.equal((await speak(app, account, { entryId: two.id, part: 1 })).statusCode, 200);
    assert.equal(tts.calls.length, 1);
    assert.equal(tts.calls[0]?.text, splitSpeechParts(LONG_ENGLISH)[1]);
  });

  test('every part counts against the per-minute limit', async (ctx) => {
    const { app, account } = await setup(ctx, { config: { TTS_REQUESTS_PER_MINUTE: '2' } });
    const entry = await store(account, LONG_ENGLISH);
    assert.equal((await speak(app, account, { entryId: entry.id, part: 0 })).statusCode, 200);
    assert.equal((await speak(app, account, { entryId: entry.id, part: 1 })).statusCode, 200);
    const limited = await speak(app, account, { entryId: entry.id, part: 2 });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
  });

  test('checks run in order: unknown target 404 and nothing to speak 422 before the part', async (ctx) => {
    const { app, account } = await setup(ctx);
    const unknown = await speak(app, account, { entryId: '01JUNKNOWNUNKNOWNUNKNOWN00', part: 5 });
    assert.equal(unknown.statusCode, 404);
    const empty = makeEntry({ input: '苹果', output: '/ˈæp.əl/', srcLang: 'zh' });
    await insertEntries(t.db, account.userId, [empty]);
    const nothing = await speak(app, account, { entryId: empty.id, part: 5 });
    assert.equal(nothing.statusCode, 422);
    assert.equal(nothing.json().error.code, 'NOTHING_TO_SPEAK');
  });

  test('part must be an integer ≥ 0', async (ctx) => {
    const { app, account, tts } = await setup(ctx);
    const entry = await store(account, 'Good morning.');
    for (const part of [-1, 1.5, '1', null, true]) {
      const res = await speak(app, account, { entryId: entry.id, part });
      assert.equal(res.statusCode, 400, JSON.stringify(part));
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
    const alone = await speak(app, account, { part: 0 });
    assert.equal(alone.statusCode, 400, 'part is not a target');
    assert.equal(tts.calls.length, 0);
  });

  test('parts work on every target: a long daily story', async (ctx) => {
    const { app, account } = await setup(ctx);
    await seedMaterial(t.db, account.userId, { date: '2026-11-16', content: dailyMaterial('2026-11-16', LONG_ENGLISH) });
    const res = await speak(app, account, { material: { kind: 'daily', date: '2026-11-16', section: 'story' }, part: 2 });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-speech-part'], '2');
    assert.equal(res.headers['x-speech-parts'], '3');
    assert.deepEqual(res.rawPayload, fakeAudio(splitSpeechParts(LONG_ENGLISH)[2]!, TTS_VOICES.en));
  });

  test('logs carry the part, the count and sizes, never the text', async (ctx) => {
    const { app, account } = await setup(ctx, { config: { LOG_LEVEL: 'trace' } });
    const logs = captureLogs(app);
    const secret = `${LONG_ENGLISH} My secret closing sentence.`;
    const entry = await store(account, secret);
    assert.equal((await speak(app, account, { entryId: entry.id, part: 1 })).statusCode, 200);
    assert.equal((await speak(app, account, { entryId: entry.id, part: 7 })).statusCode, 422);
    const text = logs.text();
    assert.ok(!text.includes('My secret closing sentence'));
    assert.ok(!text.includes('quick brown fox'));
    const lines = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === 'tts request');
    assert.deepEqual(
      lines.map((line) => [line.outcome, line.part, line.parts]),
      [['ok', 1, 3], ['part_out_of_range', 7, 3]],
    );
    assert.equal(lines[0]?.textChars, [...secret].length);
    assert.equal(lines[0]?.partChars, [...splitSpeechParts(secret)[1]!].length);
  });
});
