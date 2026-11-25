import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import { items, lookupEvents, materials, notes, users } from '../src/db/schema.ts';
import { runPipeline, type AccountRunSummary, type PipelineDeps } from '../src/modules/pipeline/index.ts';
import { DIGEST_CAPS, type DigestMaterial } from '../src/modules/pipeline/learnContent.ts';
import { groupByKey } from '../src/modules/pipeline/lookupStep.ts';
import type { DailyMaterial } from '../src/modules/pipeline/materials.ts';
import { fakeAlerter, fixedClock, testConfig } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount } from './helpers/fixtures.ts';
import { seedItem, seedLog } from './helpers/learning.ts';
import { lexiconEntry, seedLexicon } from './helpers/notes.ts';
import { cardsOf, itemsOf, scriptedLlm, seedRecords, type ScriptedLlm } from './helpers/pipeline.ts';

const at = (day: string, time = '10:00') => new Date(`${day}T${time}:00+08:00`);
/** 05:00 Asia/Shanghai on `day`: the nightly run whose "yesterday" is the day before. */
const night = (day: string) => new Date(`${day}T05:00:30+08:00`);

describe('groupByKey (pure)', () => {
  test('counts events per key with the first and last instant, keys sorted', () => {
    const a = new Date('2026-11-20T01:00:00Z');
    const b = new Date('2026-11-20T02:00:00Z');
    const c = new Date('2026-11-20T03:00:00Z');
    assert.deepEqual(
      groupByKey([
        { lemmaKey: 'zeal', createdAt: b },
        { lemmaKey: 'apple', createdAt: c },
        { lemmaKey: 'zeal', createdAt: a },
      ]),
      [
        { key: 'apple', n: 1, first: c, last: c },
        { key: 'zeal', n: 2, first: a, last: b },
      ],
    );
  });
});

describe('nightly pipeline v3: lookup events, activity, frequency, digest', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  const deps = (llm: ScriptedLlm, now: Date): PipelineDeps => ({
    config: testConfig(),
    db: t.db,
    clock: fixedClock(now),
    llm,
    alerter: fakeAlerter(),
  });
  const run = async (userId: string, now: Date, llm: ScriptedLlm = scriptedLlm()): Promise<AccountRunSummary> => {
    const [summary] = await runPipeline(deps(llm, now), { userId });
    assert.ok(summary);
    assert.equal(summary.status, 'ok', summary.error ?? '');
    return summary;
  };
  const setSettings = (userId: string, settings: Record<string, unknown>) => t.db.update(users).set({ settings }).where(eq(users.id, userId));
  const seedEvent = (userId: string, lemmaKey: string, createdAt: Date) =>
    t.db.insert(lookupEvents).values({ userId, id: ulid({ time: createdAt.getTime() }), lemmaKey, explainLang: 'zh', createdAt });
  const materialOf = async (userId: string, kind: 'daily' | 'digest', date: string) =>
    (await t.db.select().from(materials).where(and(eq(materials.userId, userId), eq(materials.kind, kind), eq(materials.date, date))))[0];
  const unit = async (userId: string, normKey: string) =>
    (await t.db.select().from(items).where(and(eq(items.userId, userId), eq(items.type, 'word'), eq(items.normKey, normKey))))[0];

  test('step 0: events become word units (ready from the lexicon, else pending → generated), counted once', async () => {
    const { userId } = await createAccount(t.db);
    await seedLexicon(t.db, lexiconEntry('decision'));
    await seedLexicon(t.db, lexiconEntry('Paris', { forms: [], examples: [
      { text: 'Paris is lovely in May.', gloss: '五月的巴黎很美。' },
      { text: 'We flew to Paris.', gloss: '我们飞去了巴黎。' },
    ] }), { key: 'paris' });
    const journey = await seedItem(t.db, userId, { type: 'word', display: 'journey', lookupCount: 1, lastSeenAt: at('2026-11-10') });
    for (const time of ['09:00', '11:00', '15:00']) await seedEvent(userId, 'decision', at('2026-11-19', time));
    await seedEvent(userId, 'paris', at('2026-11-19'));
    await seedEvent(userId, 'harbor', at('2026-11-19'));
    await seedEvent(userId, 'journey', at('2026-11-18'));
    await seedEvent(userId, 'journey', at('2026-11-19', '12:00'));
    await seedEvent(userId, 'ancient', new Date(night('2026-11-20').getTime() - 181 * 86_400_000));

    const llm = scriptedLlm();
    const summary = await run(userId, night('2026-11-20'), llm);
    assert.deepEqual(summary.lookups, { events: 8, keys: 5, unitsCreated: 4, unitsFilled: 2, deleted: 1 });

    const decision = await unit(userId, 'decision');
    assert.equal(decision?.status, 'ready');
    assert.equal(decision?.lookupCount, 3);
    assert.equal(decision?.firstSeenAt.toISOString(), at('2026-11-19', '09:00').toISOString());
    assert.equal(decision?.lastSeenAt.toISOString(), at('2026-11-19', '15:00').toISOString());
    assert.equal((await cardsOf(t.db, userId, decision!.id)).length, 3);
    assert.equal((await unit(userId, 'paris'))?.display, 'Paris', 'the lexicon lemma is the display form');

    const harbor = await unit(userId, 'harbor');
    assert.equal(harbor?.status, 'ready', 'pending from step 0, generated in step 2');
    assert.ok(
      llm.payloads.some((payload) => payload.task === 'generate' && JSON.stringify(payload.items).includes('"headword":"harbor"')),
      'the model wrote harbor',
    );
    assert.ok(!llm.payloads.some((payload) => JSON.stringify(payload).includes('"headword":"decision"')), 'the lexicon word needs no model');

    const journeyRow = await unit(userId, 'journey');
    assert.equal(journeyRow?.id, journey.itemId);
    assert.equal(journeyRow?.lookupCount, 3);
    assert.equal(journeyRow?.lastSeenAt.toISOString(), at('2026-11-19', '12:00').toISOString());

    const left = await t.db.select().from(lookupEvents).where(eq(lookupEvents.userId, userId));
    assert.equal(left.length, 7);
    assert.ok(left.every((event) => event.mergedAt !== null));

    const again = await run(userId, night('2026-11-21'));
    assert.deepEqual(again.lookups, { events: 0, keys: 0, unitsCreated: 0, unitsFilled: 0, deleted: 0 });
    assert.equal((await unit(userId, 'decision'))?.lookupCount, 3, 'never counted twice');
  });

  test('an account with only lookup events is picked up by the nightly run', async () => {
    const { userId } = await createAccount(t.db);
    await seedLexicon(t.db, lexiconEntry('decision'));
    await seedEvent(userId, 'decision', at('2026-11-19'));
    const summaries = await runPipeline(deps(scriptedLlm(), night('2026-11-20')));
    const mine = summaries.find((summary) => summary.userId === userId);
    assert.equal(mine?.lookups?.unitsCreated, 1);
    assert.deepEqual(mine?.daily, { date: '2026-11-19', outcome: 'created' });
    const daily = (await materialOf(userId, 'daily', '2026-11-19'))?.content as unknown as DailyMaterial;
    assert.deepEqual(daily.words.map((word) => word.headword), ['decision'], "a day's units include its lookups");
  });

  test('daily: any activity makes the material (a note, a review); a day without activity does not', async () => {
    const noteDay = await createAccount(t.db);
    await t.db.insert(notes).values({
      userId: noteDay.userId,
      id: ulid(),
      kind: 'sentence',
      text: 'A sentence I liked.',
      lang: 'en',
      stars: 1,
      seq: 1,
      createdAt: at('2026-11-19'),
      updatedAt: at('2026-11-19'),
    });
    await seedItem(t.db, noteDay.userId, { type: 'phrase', display: 'old phrase', createdAt: at('2026-10-01') });
    assert.deepEqual((await run(noteDay.userId, night('2026-11-20'))).daily, { date: '2026-11-19', outcome: 'created' });

    const reviewDay = await createAccount(t.db);
    const item = await seedItem(t.db, reviewDay.userId, { type: 'phrase', display: 'reviewed', createdAt: at('2026-10-01') });
    await seedLog(t.db, reviewDay.userId, { cardId: item.cardIds[0]!, rating: 3, reviewedAt: at('2026-11-19') });
    assert.deepEqual((await run(reviewDay.userId, night('2026-11-20'))).daily, { date: '2026-11-19', outcome: 'created' });

    const quiet = await createAccount(t.db);
    await seedRecords(t.db, quiet.userId, [{ input: 'orbit', output: 'orbit /ˈɔːr.bɪt/ 轨道', at: '2026-11-17T10:00:00+08:00' }]);
    const summary = await run(quiet.userId, night('2026-11-20'));
    assert.equal(summary.active, true);
    assert.deepEqual(summary.daily, { date: '2026-11-19', outcome: 'no_activity' });
    assert.equal(await materialOf(quiet.userId, 'daily', '2026-11-19'), undefined);
  });

  test('no activity in the last 30 days: no 周期资料 (and the run still extracts)', async () => {
    const { userId } = await createAccount(t.db);
    await seedRecords(t.db, userId, [{ input: 'orbit', output: 'orbit /ˈɔːr.bɪt/ 轨道', at: '2026-10-01T10:00:00+08:00' }]);
    const summary = await run(userId, night('2026-11-20'));
    assert.equal(summary.entriesProcessed, 1);
    assert.equal(summary.active, false);
    assert.equal(summary.daily, null);
    assert.equal(summary.digest, null);
  });

  test('materialFrequency off: nothing; weekly: a digest on the chosen weekday only', async () => {
    const off = await createAccount(t.db);
    await setSettings(off.userId, { materialFrequency: 'off' });
    await seedRecords(t.db, off.userId, [{ input: 'orbit', output: 'orbit /ˈɔːr.bɪt/ 轨道', at: '2026-11-19T10:00:00+08:00' }]);
    const offSummary = await run(off.userId, night('2026-11-20'));
    assert.equal(offSummary.daily, null);
    assert.equal(offSummary.digest, null);

    const weekly = await createAccount(t.db);
    await setSettings(weekly.userId, { materialFrequency: 'weekly', materialWeekday: 5, extendEnabled: false }); // Friday
    await seedRecords(t.db, weekly.userId, [{ input: 'orbit', output: 'orbit /ˈɔːr.bɪt/ 轨道', at: '2026-11-18T10:00:00+08:00' }]);
    const thursday = await run(weekly.userId, night('2026-11-19'));
    assert.equal(thursday.daily, null, 'no daily material in weekly mode');
    assert.equal(thursday.digest, null, 'not the chosen weekday');
    const friday = await run(weekly.userId, night('2026-11-20'));
    assert.deepEqual(friday.digest, { date: '2026-11-19', outcome: 'created' });
    const digest = (await materialOf(weekly.userId, 'digest', '2026-11-19'))?.content as unknown as DigestMaterial;
    assert.deepEqual(digest.range, { start: '2026-11-13', end: '2026-11-19' });
    assert.equal(digest.date, '2026-11-19');
    assert.deepEqual(digest.words.map((word) => word.headword), ['orbit']);
    assert.deepEqual(digest.review, []);
    assert.deepEqual((await run(weekly.userId, night('2026-11-20'))).digest, { date: '2026-11-19', outcome: 'exists' });
  });

  test('digest: DIGEST_CAPS, the review recap, and a week without new units still gets one', async () => {
    const { userId } = await createAccount(t.db);
    await setSettings(userId, { materialFrequency: 'weekly', extendEnabled: false }); // Monday (default weekday)
    const words = Array.from({ length: 25 }, (_, i) => `word${String.fromCharCode(97 + i)}`);
    await seedRecords(
      t.db,
      userId,
      words.map((word, i) => ({ input: word, output: `${word} /ˈwɜːrd/ 释义`, at: `2026-11-${String(16 + (i % 7)).padStart(2, '0')}T09:${String(i).padStart(2, '0')}:00+08:00` })),
    );
    const forgotten = await seedItem(t.db, userId, { type: 'phrase', display: 'fall behind', createdAt: at('2026-10-01') });
    const grammar = await seedItem(t.db, userId, { type: 'grammar', display: '冠词', createdAt: at('2026-10-01') });
    for (const day of ['2026-11-17', '2026-11-19', '2026-11-21']) {
      await seedLog(t.db, userId, { cardId: forgotten.cardIds[0]!, rating: 1, reviewedAt: at(day) });
    }
    await seedLog(t.db, userId, { cardId: grammar.cardIds[0]!, rating: 1, reviewedAt: at('2026-11-20') });
    await seedLog(t.db, userId, { cardId: grammar.cardIds[0]!, rating: 1, reviewedAt: at('2026-11-10') }); // before the range

    const llm = scriptedLlm();
    const summary = await run(userId, night('2026-11-23'), llm);
    assert.deepEqual(summary.digest, { date: '2026-11-22', outcome: 'created' });
    const digest = (await materialOf(userId, 'digest', '2026-11-22'))?.content as unknown as DigestMaterial;
    assert.equal(digest.words.length, DIGEST_CAPS.words);
    assert.deepEqual(digest.range, { start: '2026-11-16', end: '2026-11-22' });
    assert.deepEqual(digest.review, [
      { itemId: forgotten.itemId, display: 'fall behind', gloss: '左右为难', lapses: 3 },
      { itemId: grammar.itemId, display: '冠词', gloss: 'look forward to + 名词 / 动名词', lapses: 1 },
    ]);
    assert.deepEqual(digest.mistakes.map((mistake) => mistake.itemId), [forgotten.itemId], 'forgotten at least twice');
    assert.ok(digest.story, 'the story uses the week’s words');
    assert.equal(digest.overview.newWords, 25);

    // The next week: no records, only a review → a digest of its review.
    await seedLog(t.db, userId, { cardId: forgotten.cardIds[0]!, rating: 1, reviewedAt: at('2026-11-25') });
    const quiet = await run(userId, night('2026-11-30'), llm);
    assert.deepEqual(quiet.digest, { date: '2026-11-29', outcome: 'created' });
    const next = (await materialOf(userId, 'digest', '2026-11-29'))?.content as unknown as DigestMaterial;
    assert.deepEqual(next.words, []);
    assert.equal(next.story, null);
    assert.deepEqual(next.review.map((entry) => [entry.display, entry.lapses]), [['fall behind', 1]]);
  });

  test('materialParts without story: no story call; the story follows the effective level', async () => {
    const words = ['amber', 'basin', 'cedar', 'delta', 'ember', 'fjord'];
    const specs = words.map((word, i) => ({ input: word, output: `${word} /ˈwɜːrd/ 释义`, at: `2026-11-19T09:0${i}:00+08:00` }));

    const noStory = await createAccount(t.db);
    await setSettings(noStory.userId, { materialParts: ['words', 'exercises'] });
    await seedRecords(t.db, noStory.userId, specs);
    const llm = scriptedLlm();
    await run(noStory.userId, night('2026-11-20'), llm);
    assert.deepEqual(llm.tasks().filter((task) => task === 'daily'), [], 'no call without story or mistakes');
    const material = (await materialOf(noStory.userId, 'daily', '2026-11-19'))?.content as unknown as DailyMaterial;
    assert.equal(material.words.length, 6);
    assert.equal(material.story, null);

    const c1 = await createAccount(t.db);
    await setSettings(c1.userId, { studyLevel: 'C1' });
    await seedRecords(t.db, c1.userId, specs);
    const leveled = scriptedLlm();
    await run(c1.userId, night('2026-11-20'), leveled);
    const daily = leveled.payloads.find((payload) => payload.task === 'daily');
    assert.equal(daily?.level, 'C1');
    assert.ok((await materialOf(c1.userId, 'daily', '2026-11-19'))?.content.story);
  });

  test('events recorded after a run are merged by the next one, once', async () => {
    const { userId } = await createAccount(t.db);
    await seedEvent(userId, 'harbor', at('2026-11-19'));
    await run(userId, night('2026-11-20'));
    await seedEvent(userId, 'harbor', at('2026-11-20', '09:00'));
    const summary = await run(userId, night('2026-11-21'));
    assert.equal(summary.lookups?.events, 1);
    assert.equal((await unit(userId, 'harbor'))?.lookupCount, 2);
    assert.equal((await itemsOf(t.db, userId)).length, 1);
  });
});
