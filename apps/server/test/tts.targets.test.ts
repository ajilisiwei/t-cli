import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ulid } from '@t-cli/core/ulid';
import { TTS_VOICES } from '../src/modules/tts/routes.ts';
import { buildTestApp, fakeAudio, fakeTts, fixedClock, testConfig, type FakeTts } from './helpers/app.ts';
import { captureLogs } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import type { TestAccount } from './helpers/fixtures.ts';
import { createLearner, dailyMaterial, extendMaterial, seedItem, seedMaterial } from './helpers/learning.ts';

describe('speech (extended): cards, items and daily stories', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let tts: FakeTts;
  const clock = fixedClock();
  before(async () => {
    t = await createTestDatabase();
    tts = fakeTts();
    app = await buildTestApp(t.db, { tts, clock, config: testConfig({ TTS_REQUESTS_PER_MINUTE: '1000' }) });
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
    assert.deepEqual(res.rawPayload, fakeAudio(text, voice));
  }

  test('a card reads its "read aloud" column', async () => {
    const account = await createLearner(t.db, { now: clock() });
    const word = await seedItem(t.db, account.userId, { type: 'word', display: 'meticulous' });
    const [recognize, produce, cloze] = word.cardIds as [string, string, string];
    await expectSpoken(account, { cardId: recognize }, 'meticulous');
    await expectSpoken(account, { cardId: produce }, 'meticulous');
    await expectSpoken(account, { cardId: cloze }, 'A meticulous example.');
    const grammar = await seedItem(t.db, account.userId, { type: 'grammar', display: 'look forward to' });
    await expectSpoken(account, { cardId: grammar.cardIds[0] }, 'I look forward to hearing from you.');
    const phrase = await seedItem(t.db, account.userId, { type: 'phrase', display: 'be torn between' });
    await expectSpoken(account, { cardId: phrase.cardIds[0] }, 'I am be torn between two jobs.');
  });

  test('an item reads its headword, phrase or the right sentence', async () => {
    const account = await createLearner(t.db, { now: clock() });
    const word = await seedItem(t.db, account.userId, { type: 'word', display: 'diligent' });
    const phrase = await seedItem(t.db, account.userId, { type: 'phrase', display: 'on the fence' });
    const grammar = await seedItem(t.db, account.userId, { type: 'grammar', display: 'gerund after to' });
    await expectSpoken(account, { itemId: word.itemId }, 'diligent');
    await expectSpoken(account, { itemId: phrase.itemId }, 'on the fence');
    await expectSpoken(account, { itemId: grammar.itemId }, 'I look forward to hearing from you.');

    // Not generated yet: a word falls back to its display, a grammar point has nothing to read.
    const pendingWord = await seedItem(t.db, account.userId, { type: 'word', display: 'pending', content: null, status: 'pending', withCards: false });
    await expectSpoken(account, { itemId: pendingWord.itemId }, 'pending');
    const pendingGrammar = await seedItem(t.db, account.userId, { type: 'grammar', display: 'pending rule', content: null, status: 'pending', withCards: false });
    const nothing = await speak(account, { itemId: pendingGrammar.itemId });
    assert.equal(nothing.statusCode, 422);
    assert.equal(nothing.json().error.code, 'NOTHING_TO_SPEAK');
  });

  test("a daily material's story", async () => {
    const account = await createLearner(t.db, { now: clock() });
    await seedMaterial(t.db, account.userId, { date: '2026-11-16', content: dailyMaterial('2026-11-16', 'Tom kept meticulous notes.') });
    await seedMaterial(t.db, account.userId, { date: '2026-11-15', content: dailyMaterial('2026-11-15', null) });
    const story = (date: string) => ({ material: { kind: 'daily', date, section: 'story' } });
    await expectSpoken(account, story('2026-11-16'), 'Tom kept meticulous notes.');
    const noStory = await speak(account, story('2026-11-15'));
    assert.equal(noStory.statusCode, 422);
    assert.equal(noStory.json().error.code, 'NOTHING_TO_SPEAK');
    assert.equal((await speak(account, story('2026-11-14'))).statusCode, 404);
  });

  test("v3: a digest's story; it is not the daily material of the same date", async () => {
    const account = await createLearner(t.db, { now: clock() });
    const digest = { ...dailyMaterial('2026-11-22', 'A week of careful notes.'), range: { start: '2026-11-16', end: '2026-11-22' }, review: [] };
    await seedMaterial(t.db, account.userId, { kind: 'digest', date: '2026-11-22', content: digest });
    await seedMaterial(t.db, account.userId, { kind: 'digest', date: '2026-11-15', content: { ...digest, story: null } });
    const story = (date: string) => ({ material: { kind: 'digest', date, section: 'story' } });
    await expectSpoken(account, story('2026-11-22'), 'A week of careful notes.');
    assert.equal((await speak(account, story('2026-11-15'))).json().error.code, 'NOTHING_TO_SPEAK');
    assert.equal((await speak(account, { material: { kind: 'daily', date: '2026-11-22', section: 'story' } })).statusCode, 404);
  });

  test("v3: an extension's passage and each item's text by index; long passages come in parts", async () => {
    const account = await createLearner(t.db, { now: clock() });
    await seedMaterial(t.db, account.userId, { kind: 'extend', date: '2026-11-23', content: extendMaterial() });
    await seedMaterial(t.db, account.userId, { kind: 'extend', date: '2026-11-16', content: extendMaterial(undefined, { passage: null }) });
    const passage = (date: string) => ({ material: { kind: 'extend', date, section: 'passage' } });
    const item = (index: number) => ({ material: { kind: 'extend', date: '2026-11-23', section: 'item', index } });
    await expectSpoken(account, passage('2026-11-23'), 'We planned the itinerary and had a short layover.');
    await expectSpoken(account, item(0), 'itinerary');
    await expectSpoken(account, item(2), 'check in');
    await expectSpoken(account, item(5), 'carry-on');
    const beyond = await speak(account, item(6));
    assert.equal(beyond.statusCode, 404);
    assert.equal(beyond.json().error.code, 'NOT_FOUND');
    assert.equal((await speak(account, passage('2026-11-16'))).json().error.code, 'NOTHING_TO_SPEAK');
    assert.equal((await speak(account, passage('2026-11-09'))).statusCode, 404);

    const sentence = 'The plan was simple and the team kept to it every single day. ';
    const long = sentence.repeat(Math.ceil(1500 / sentence.length)).trim();
    await seedMaterial(t.db, account.userId, {
      kind: 'extend',
      date: '2026-11-09',
      content: extendMaterial(undefined, { passage: { title: 'Long', text: long, zh: '长文。' } }),
    });
    const first = await speak(account, passage('2026-11-09'));
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['x-speech-parts'], '2');
    const second = await speak(account, { ...passage('2026-11-09'), part: 1 });
    assert.equal(second.statusCode, 200);
    assert.equal(second.headers['x-speech-part'], '1');
  });

  test("another account's card, item or story is 404, like an unknown one", async () => {
    const account = await createLearner(t.db, { now: clock() });
    const other = await createLearner(t.db, { now: clock() });
    const theirs = await seedItem(t.db, other.userId, { type: 'word', display: 'secretword' });
    await seedMaterial(t.db, other.userId, { date: '2026-11-16', content: dailyMaterial('2026-11-16', 'Their private story.') });
    await seedMaterial(t.db, other.userId, { kind: 'digest', date: '2026-11-16', content: dailyMaterial('2026-11-16', 'Their private week.') });
    await seedMaterial(t.db, other.userId, { kind: 'extend', date: '2026-11-16', content: extendMaterial([{ text: 'secretword', kind: 'word' }]) });
    const calls = tts.calls.length;
    for (const payload of [
      { cardId: theirs.cardIds[0] },
      { cardId: ulid() },
      { itemId: theirs.itemId },
      { itemId: ulid() },
      { material: { kind: 'daily', date: '2026-11-16', section: 'story' } },
      { material: { kind: 'digest', date: '2026-11-16', section: 'story' } },
      { material: { kind: 'extend', date: '2026-11-16', section: 'passage' } },
      { material: { kind: 'extend', date: '2026-11-16', section: 'item', index: 0 } },
    ]) {
      const res = await speak(account, payload);
      assert.equal(res.statusCode, 404, JSON.stringify(payload));
      assert.equal(res.json().error.code, 'NOT_FOUND');
      assert.ok(!res.body.includes('secretword'));
    }
    assert.equal(tts.calls.length, calls);
  });

  test('exactly one target: mixed, empty or malformed bodies are 400', async () => {
    const account = await createLearner(t.db, { now: clock() });
    const word = await seedItem(t.db, account.userId, { type: 'word', display: 'single' });
    for (const payload of [
      {},
      { cardId: word.cardIds[0], itemId: word.itemId },
      { entryId: ulid(), cardId: word.cardIds[0] },
      { cardId: '' },
      { material: { kind: 'weekly', date: '2026-11-16', section: 'story' } },
      { material: { kind: 'daily', date: '2026-11-16', section: 'words' } },
      { material: { kind: 'daily', date: '2026-13-01', section: 'story' } },
      { material: { kind: 'daily', section: 'story' } },
      { material: { kind: 'digest', date: '2026-11-16', section: 'passage' } },
      { material: { kind: 'extend', date: '2026-11-16', section: 'story' } },
      { material: { kind: 'extend', date: '2026-11-16', section: 'item' } },
      { material: { kind: 'extend', date: '2026-11-16', section: 'item', index: -1 } },
      { material: { kind: 'extend', date: '2026-11-16', section: 'item', index: 1.5 } },
      { material: { kind: 'extend', date: '2026-11-16', section: 'passage', index: 0 } },
      { material: { kind: 'daily', date: '2026-11-16', section: 'story', index: 0 } },
      { text: 'read anything' },
    ]) {
      const res = await speak(account, payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
  });

  test('logs name the target kind and id, never the text', async (ctx) => {
    const traced = await buildTestApp(t.db, { tts: fakeTts(), clock, config: testConfig({ LOG_LEVEL: 'trace' }) });
    ctx.after(() => traced.close());
    const logs = captureLogs(traced);
    const account = await createLearner(t.db, { now: clock() });
    const word = await seedItem(t.db, account.userId, { type: 'word', display: 'confidentialword' });
    const res = await traced.inject({ method: 'POST', url: '/v1/tts', headers: account.headers, payload: { itemId: word.itemId } });
    assert.equal(res.statusCode, 200);
    const text = logs.text();
    assert.ok(!text.includes('confidentialword'));
    const line = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'tts request');
    assert.deepEqual({ target: line?.target, targetId: line?.targetId, outcome: line?.outcome }, { target: 'item', targetId: word.itemId, outcome: 'ok' });
  });

  test('v3: a material log line names its kind, date, section and index, never the text', async (ctx) => {
    const traced = await buildTestApp(t.db, { tts: fakeTts(), clock, config: testConfig({ LOG_LEVEL: 'trace' }) });
    ctx.after(() => traced.close());
    const logs = captureLogs(traced);
    const account = await createLearner(t.db, { now: clock() });
    await seedMaterial(t.db, account.userId, { kind: 'extend', date: '2026-11-23', content: extendMaterial([{ text: 'confidentialitem', kind: 'word' }]) });
    const res = await traced.inject({
      method: 'POST',
      url: '/v1/tts',
      headers: account.headers,
      payload: { material: { kind: 'extend', date: '2026-11-23', section: 'item', index: 0 } },
    });
    assert.equal(res.statusCode, 200);
    const text = logs.text();
    assert.ok(!text.includes('confidentialitem'));
    const line = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'tts request');
    assert.deepEqual(
      { target: line?.target, targetId: line?.targetId, materialKind: line?.materialKind, section: line?.section, index: line?.index, outcome: line?.outcome },
      { target: 'material', targetId: '2026-11-23', materialKind: 'extend', section: 'item', index: 0, outcome: 'ok' },
    );
  });
});
