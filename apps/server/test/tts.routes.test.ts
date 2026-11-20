import { after, before, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Entry } from '@t-cli/core/entry';
import { ulid } from '@t-cli/core/ulid';
import { insertEntries } from '../src/db/entriesRepo.ts';
import { TTS_TEXT_MAX_CHARS, TTS_VOICES } from '../src/modules/tts/routes.ts';
import { captureLogs } from './helpers/auth.ts';
import { buildTestApp, fakeAudio, fakeTts, fixedClock, testConfig, type FakeTts, type TestClock } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount, makeEntry, type TestAccount } from './helpers/fixtures.ts';

describe('speech: POST /v1/tts', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  interface Setup {
    app: FastifyInstance;
    account: TestAccount;
    tts: FakeTts;
    clock: TestClock;
  }

  async function setup(
    ctx: TestContext,
    { tts = fakeTts(), config = {}, clock = fixedClock() }: { tts?: FakeTts; config?: Record<string, string>; clock?: TestClock } = {},
  ): Promise<Setup> {
    const app = await buildTestApp(t.db, { tts, clock, config: testConfig(config) });
    ctx.after(() => app.close());
    const account = await createAccount(t.db, { kind: 'mp', now: clock() });
    return { app, account, tts, clock };
  }

  const speak = (app: FastifyInstance, account: TestAccount | null, payload?: unknown) =>
    app.inject({
      method: 'POST',
      url: '/v1/tts',
      headers: account?.headers ?? {},
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  async function store(account: TestAccount, overrides: Parameters<typeof makeEntry>[0] = {}): Promise<Entry> {
    const entry = makeEntry(overrides);
    await insertEntries(t.db, account.userId, [entry]);
    return entry;
  }

  test('reads the text speakableForEntry picks, with the matching voice', async (ctx) => {
    const { app, account, tts } = await setup(ctx);
    const cases: { entry: Parameters<typeof makeEntry>[0]; text: string; voice: string }[] = [
      { entry: { task: 'check', input: 'He go home.', output: 'He goes home.', srcLang: 'en' }, text: 'He goes home.', voice: TTS_VOICES.en },
      {
        entry: { task: 'check', mode: 'detail', input: 'He go home.', output: 'He goes home.\n\n分析：主谓一致', srcLang: 'en' },
        text: 'He goes home.',
        voice: TTS_VOICES.en,
      },
      { entry: { input: '苹果', output: 'apple /ˈæp.əl/', srcLang: 'zh' }, text: 'apple', voice: TTS_VOICES.en },
      { entry: { input: 'prioritiz', output: 'prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑', srcLang: 'en' }, text: 'prioritize', voice: TTS_VOICES.en },
      { entry: { input: 'Good morning.', output: '早上好。', srcLang: 'en' }, text: 'Good morning.', voice: TTS_VOICES.en },
      { entry: { input: '会議室を予約しました', output: '我预约了会议室。', srcLang: 'other' }, text: '我预约了会议室。', voice: TTS_VOICES.zh },
      { entry: { input: 'привет', output: '你好', srcLang: null }, text: '你好', voice: TTS_VOICES.zh },
    ];
    for (const { entry: fields, text, voice } of cases) {
      const entry = await store(account, fields);
      const res = await speak(app, account, { entryId: entry.id });
      assert.equal(res.statusCode, 200, text);
      assert.equal(res.headers['content-type'], 'audio/mpeg');
      assert.equal(res.headers['cache-control'], 'private, max-age=86400');
      assert.deepEqual(res.rawPayload, fakeAudio(text, voice), text);
      assert.deepEqual({ text: tts.calls.at(-1)?.text, voice: tts.calls.at(-1)?.voice }, { text, voice });
    }
  });

  test('requires a valid access token', async (ctx) => {
    const { app, account, tts } = await setup(ctx);
    const entry = await store(account);
    assert.equal((await speak(app, null, { entryId: entry.id })).statusCode, 401);
    const bad = await app.inject({ method: 'POST', url: '/v1/tts', headers: { authorization: 'Bearer nope' }, payload: { entryId: entry.id } });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().error.code, 'UNAUTHORIZED');
    assert.equal(tts.calls.length, 0);
  });

  test('validates the body', async (ctx) => {
    const { app, account, tts } = await setup(ctx);
    for (const payload of [undefined, {}, { entryId: '' }, { entryId: '   ' }, { entryId: 42 }, { entryId: 'x'.repeat(65) }, { text: 'read me' }]) {
      const res = await speak(app, account, payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload) ?? 'undefined');
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
    assert.equal(tts.calls.length, 0);
  });

  test("an unknown entry or another account's entry is 404 NOT_FOUND, indistinguishably", async (ctx) => {
    const { app, account, tts } = await setup(ctx);
    const other = await createAccount(t.db);
    const theirs = await store(other, { input: 'their private text' });
    const unknown = await speak(app, account, { entryId: ulid() });
    const foreign = await speak(app, account, { entryId: theirs.id });
    for (const res of [unknown, foreign]) {
      assert.equal(res.statusCode, 404);
      assert.match(String(res.headers['content-type']), /^application\/json/);
    }
    assert.deepEqual(foreign.json(), unknown.json());
    assert.ok(!foreign.body.includes('their private text'));
    assert.equal(tts.calls.length, 0);
    assert.equal((await speak(app, other, { entryId: theirs.id })).statusCode, 200, 'the owner can read it');
  });

  test('nothing to read → 422 NOTHING_TO_SPEAK; over the length limit → 422 TEXT_TOO_LONG', async (ctx) => {
    const { app, account, tts } = await setup(ctx);
    for (const fields of [
      { input: '苹果', output: '', srcLang: 'zh' as const },
      { input: '苹果', output: '/ˈæp.əl/', srcLang: 'zh' as const },
    ]) {
      const res = await speak(app, account, { entryId: (await store(account, fields)).id });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().error.code, 'NOTHING_TO_SPEAK');
    }

    const atLimit = 'é'.repeat(TTS_TEXT_MAX_CHARS);
    const ok = await speak(app, account, { entryId: (await store(account, { input: atLimit, srcLang: 'en' })).id });
    assert.equal(ok.statusCode, 200, 'the limit counts code points, not bytes');
    const tooLong = await speak(app, account, { entryId: (await store(account, { input: `${atLimit}e`, srcLang: 'en' })).id });
    assert.equal(tooLong.statusCode, 422);
    assert.equal(tooLong.json().error.code, 'TEXT_TOO_LONG');
    assert.equal(tts.calls.length, 1);
  });

  test('audio is cached by voice and text: the upstream is called once', async (ctx) => {
    const { app, account, tts } = await setup(ctx);
    const entry = await store(account, { input: 'Good morning.', output: '早上好。', srcLang: 'en' });
    const first = await speak(app, account, { entryId: entry.id });
    const second = await speak(app, account, { entryId: entry.id });
    assert.equal(tts.calls.length, 1);
    assert.deepEqual(second.rawPayload, first.rawPayload);

    // Another entry with the same speakable text shares the cached audio.
    const twin = await store(account, { input: 'Good morning.', output: '上午好', srcLang: 'en' });
    assert.equal((await speak(app, account, { entryId: twin.id })).statusCode, 200);
    assert.equal(tts.calls.length, 1);

    // The cache is not per account: same voice and text, same audio.
    const other = await createAccount(t.db);
    const theirs = await store(other, { input: 'Good morning.', output: '早', srcLang: 'en' });
    assert.equal((await speak(app, other, { entryId: theirs.id })).statusCode, 200);
    assert.equal(tts.calls.length, 1);
  });

  test('TTS_CACHE_MAX_BYTES=0 disables the cache', async (ctx) => {
    const { app, account, tts } = await setup(ctx, { config: { TTS_CACHE_MAX_BYTES: '0' } });
    const entry = await store(account);
    await speak(app, account, { entryId: entry.id });
    await speak(app, account, { entryId: entry.id });
    assert.equal(tts.calls.length, 2);
  });

  test('per-account limit → 429 RATE_LIMITED with Retry-After; other accounts unaffected', async (ctx) => {
    const { app, account, clock } = await setup(ctx, { config: { TTS_REQUESTS_PER_MINUTE: '3' } });
    const entry = await store(account);
    for (let i = 0; i < 3; i += 1) assert.equal((await speak(app, account, { entryId: entry.id })).statusCode, 200);
    clock.advance(20_000);
    const limited = await speak(app, account, { entryId: entry.id });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
    assert.equal(limited.json().error.details.retryAfterSeconds, 40);
    assert.equal(limited.headers['retry-after'], '40');

    const other = await createAccount(t.db);
    assert.equal((await speak(app, other, { entryId: (await store(other)).id })).statusCode, 200);
    clock.advance(40_001);
    assert.equal((await speak(app, account, { entryId: entry.id })).statusCode, 200, 'allowed again once the window slides');
  });

  test('the default limit is 30 per minute', async (ctx) => {
    const { app, account } = await setup(ctx);
    const entry = await store(account);
    for (let i = 0; i < 30; i += 1) assert.equal((await speak(app, account, { entryId: entry.id })).statusCode, 200);
    assert.equal((await speak(app, account, { entryId: entry.id })).statusCode, 429);
  });

  test('TTS_ENABLED=false → 503 TTS_UNAVAILABLE without calling out', async (ctx) => {
    const { app, account, tts } = await setup(ctx, { config: { TTS_ENABLED: 'false' } });
    const res = await speak(app, account, { entryId: (await store(account)).id });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'TTS_UNAVAILABLE');
    assert.equal(tts.calls.length, 0);
  });

  test('upstream failures → 502 TTS_UPSTREAM and nothing is cached', async (ctx) => {
    let fail = true;
    const tts = fakeTts(async (text, voice) => {
      if (fail) throw new Error('Edge TTS WebSocket error: connect ECONNREFUSED');
      return fakeAudio(text, voice);
    });
    const { app, account } = await setup(ctx, { tts });
    const entry = await store(account);
    const res = await speak(app, account, { entryId: entry.id });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json().error, { code: 'TTS_UPSTREAM', message: 'text to speech failed' });
    fail = false;
    assert.equal((await speak(app, account, { entryId: entry.id })).statusCode, 200);
    assert.equal(tts.calls.length, 2, 'the failure was not cached');

    const empty = await setup(ctx, { tts: fakeTts(async () => new Uint8Array(0)) });
    const emptyRes = await speak(empty.app, empty.account, { entryId: (await store(empty.account)).id });
    assert.equal(emptyRes.statusCode, 502);
    assert.equal(emptyRes.json().error.code, 'TTS_UPSTREAM');
  });

  test('a slow upstream is cut off by TTS_TIMEOUT_MS', async (ctx) => {
    const tts = fakeTts(
      (_text, _voice, signal) =>
        new Promise<Uint8Array>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const { app, account } = await setup(ctx, { tts, config: { TTS_TIMEOUT_MS: '1000' } });
    const startedAt = Date.now();
    const res = await speak(app, account, { entryId: (await store(account)).id });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error.code, 'TTS_UPSTREAM');
    assert.ok(Date.now() - startedAt < 5000);
    assert.equal(tts.calls[0]?.signal.aborted, true);
  });

  test('logs carry sizes and outcomes, never the text', async (ctx) => {
    const tts = fakeTts();
    const app = await buildTestApp(t.db, { tts, config: testConfig({ LOG_LEVEL: 'trace' }) });
    ctx.after(() => app.close());
    const logs = captureLogs(app);
    const account = await createAccount(t.db);
    const entry = await store(account, { input: 'my secret sentence', output: '我的秘密句子', srcLang: 'en' });
    assert.equal((await speak(app, account, { entryId: entry.id })).statusCode, 200);
    assert.equal((await speak(app, account, { entryId: entry.id })).statusCode, 200);
    const failing = await buildTestApp(t.db, { tts: fakeTts(async () => Promise.reject(new Error('upstream said: my secret sentence'))), config: testConfig({ LOG_LEVEL: 'trace' }) });
    ctx.after(() => failing.close());
    const failingLogs = captureLogs(failing);
    assert.equal((await speak(failing, account, { entryId: entry.id })).statusCode, 502);

    const text = logs.text() + failingLogs.text();
    assert.ok(!text.includes('my secret sentence'), 'the text is never logged');
    assert.ok(!text.includes('我的秘密句子'));
    const lines = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === 'tts request');
    assert.deepEqual(lines.map((line) => [line.outcome, line.cacheHit]), [['ok', false], ['ok', true], ['upstream_error', undefined]]);
    assert.equal(lines[0]?.textChars, 'my secret sentence'.length);
    assert.equal(typeof lines[0]?.bytes, 'number');
    assert.equal(lines[0]?.voice, TTS_VOICES.en);
  });
});
