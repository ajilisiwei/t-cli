import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { items, users } from '../src/db/schema.ts';
import { ExtendContentSchema, exercisesFor } from '../src/modules/pipeline/learnContent.ts';
import { buildTestApp, fixedClock, type TestClock } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import type { TestAccount } from './helpers/fixtures.ts';
import { cardsOf, cannedGrammar, cannedPhrase, cannedWord } from './helpers/pipeline.ts';
import { createLearner, dailyMaterial, extendMaterial, seedItem, seedMaterial } from './helpers/learning.ts';
import { lexiconEntry, seedLexicon } from './helpers/notes.ts';

/** A daily material (or digest) with real words, phrases and grammar, so exercises can be derived. */
function richDaily(date: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...dailyMaterial(date),
    words: ['harbor', 'lantern', 'meadow'].map((word) => ({ itemId: `w-${word}`, ...cannedWord(word) })),
    phrases: [{ itemId: 'p-1', ...cannedPhrase('look after') }],
    grammar: [{ itemId: 'g-1', ...cannedGrammar('主谓一致') }],
    ...extra,
  };
}

describe('materials (v3): list items, digest, extend, read, adopt, dismiss', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let clock: TestClock;

  before(async () => {
    t = await createTestDatabase();
    clock = fixedClock(new Date('2026-11-24T10:00:00+08:00'));
    app = await buildTestApp(t.db, { clock });
  });
  after(async () => {
    await app?.close();
    await t?.drop();
  });

  const learner = () => createLearner(t.db, { now: clock() });
  const get = (account: TestAccount, url: string) => app.inject({ method: 'GET', url, headers: account.headers });
  const post = (account: TestAccount, url: string, payload?: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, headers: account.headers, ...(payload ? { payload } : {}) });
  const setLang = (account: TestAccount, explanationLang: 'zh' | 'en') =>
    t.db.update(users).set({ settings: { explanationLang } }).where(eq(users.id, account.userId));

  async function seedAll(account: TestAccount) {
    await seedMaterial(t.db, account.userId, { date: '2026-11-23', content: richDaily('2026-11-23') });
    await seedMaterial(t.db, account.userId, { kind: 'extend', date: '2026-11-23', content: extendMaterial() });
    await seedMaterial(t.db, account.userId, {
      kind: 'digest',
      date: '2026-11-22',
      content: { ...richDaily('2026-11-22'), range: { start: '2026-11-16', end: '2026-11-22' }, review: [] },
    });
    await seedMaterial(t.db, account.userId, { date: '2026-11-22', content: dailyMaterial('2026-11-22', null) });
    await seedMaterial(t.db, account.userId, {
      kind: 'weekly',
      date: '2026-11-16',
      content: { weekStart: '2026-11-16', totals: { entries: 30, newItems: 9, reviews: 126 }, retention: { thisWeek: 0.82, lastWeek: null }, summary: 'x' },
    });
  }

  test('kind=all: date desc, then extend, digest, daily, weekly; titles, counts, pages and readAt', async () => {
    const account = await learner();
    const other = await learner();
    await seedAll(account);
    await seedMaterial(t.db, other.userId, { date: '2026-11-24', content: richDaily('2026-11-24') });

    const res = await get(account, '/v1/materials?kind=all');
    assert.equal(res.statusCode, 200);
    const data = res.json().data;
    assert.deepEqual(data.dates, ['2026-11-23', '2026-11-22', '2026-11-16'], 'each date once');
    assert.equal(data.nextBefore, null);
    assert.deepEqual(
      data.items.map((item: { kind: string; date: string; title: string }) => [item.kind, item.date, item.title]),
      [
        ['extend', '2026-11-23', '出差旅行常用表达'],
        ['daily', '2026-11-23', '3 个词和一篇短文'],
        ['digest', '2026-11-22', '7 天合集：3 个词'],
        ['daily', '2026-11-22', '今日回顾'],
        ['weekly', '2026-11-16', '复习 126 次，记住 82%'],
      ],
    );
    const [extend, daily, , , weekly] = data.items;
    const exercises = exercisesFor(richDaily('2026-11-23') as never);
    assert.deepEqual(daily.counts, {
      words: 3,
      phrases: 1,
      grammar: 1,
      exercises: exercises.cloze.length + exercises.translate.length + exercises.fix.length,
      items: 0,
    });
    assert.deepEqual(extend.counts, { words: 0, phrases: 0, grammar: 0, exercises: 0, items: 6 });
    assert.deepEqual(weekly.counts, { words: 0, phrases: 0, grammar: 0, exercises: 0, items: 0 });
    assert.equal(weekly.pages, 0);
    assert.ok(daily.pages >= 1 && extend.pages >= 1);
    assert.equal(daily.readAt, null);
    assert.equal(daily.createdAt, '2026-11-23T22:00:00.000Z');

    await setLang(account, 'en');
    const en = (await get(account, '/v1/materials?kind=all')).json().data;
    assert.deepEqual(
      en.items.map((item: { title: string }) => item.title),
      ['出差旅行常用表达', '3 words and a short story', '7-day digest: 3 words', 'Daily review', '126 reviews, 82% remembered'],
    );
  });

  test('pages are whole dates: a date never straddles two pages', async () => {
    const account = await learner();
    await seedAll(account);
    const page1 = (await get(account, '/v1/materials?kind=all&limit=1')).json().data;
    assert.deepEqual(page1.dates, ['2026-11-23']);
    assert.deepEqual(page1.items.map((item: { kind: string }) => item.kind), ['extend', 'daily']);
    assert.equal(page1.nextBefore, '2026-11-23');
    const page2 = (await get(account, `/v1/materials?kind=all&limit=1&before=${page1.nextBefore}`)).json().data;
    assert.deepEqual(page2.items.map((item: { kind: string }) => item.kind), ['digest', 'daily']);
    const digests = (await get(account, '/v1/materials?kind=digest')).json().data;
    assert.deepEqual(digests.dates, ['2026-11-22']);
    assert.deepEqual(digests.items.map((item: { kind: string }) => item.kind), ['digest']);
  });

  test('daily and digest carry derived exercises; extend carries known; weekly neither', async () => {
    const account = await learner();
    await seedAll(account);
    await seedItem(t.db, account.userId, { type: 'word', display: 'layover' });
    await seedItem(t.db, account.userId, { type: 'phrase', display: 'jet lag' });

    const daily = (await get(account, '/v1/materials/daily?date=2026-11-23')).json().data;
    assert.deepEqual(Object.keys(daily).sort(), ['content', 'createdAt', 'date', 'exercises', 'kind', 'readAt']);
    assert.equal(daily.kind, 'daily');
    assert.deepEqual(daily.exercises, exercisesFor(richDaily('2026-11-23') as never));
    assert.ok(daily.exercises.cloze.length > 0 && daily.exercises.fix.length > 0);

    const digest = (await get(account, '/v1/materials/digest')).json().data;
    assert.equal(digest.date, '2026-11-22');
    assert.deepEqual(digest.content.range, { start: '2026-11-16', end: '2026-11-22' });
    assert.ok(digest.exercises);

    const extend = (await get(account, '/v1/materials/extend')).json().data;
    assert.equal(extend.date, '2026-11-23');
    assert.equal(ExtendContentSchema.safeParse(extend.content).success, true);
    assert.deepEqual(extend.known, [false, true, false, false, true, false]);
    assert.equal(extend.exercises, undefined);

    const weekly = (await get(account, '/v1/materials/weekly')).json().data;
    assert.equal(weekly.exercises, undefined);
    assert.equal(weekly.known, undefined);
    assert.equal((await get(account, '/v1/materials/extend?date=2026-11-16')).statusCode, 404);
  });

  test('read: marks 学完了 (the first mark is kept), undo clears it; unknown → 404', async () => {
    const account = await learner();
    await seedAll(account);
    const first = await post(account, '/v1/materials/daily/2026-11-23/read', { read: true });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json().data, { readAt: clock().toISOString() });
    clock.advance(60_000);
    assert.deepEqual((await post(account, '/v1/materials/daily/2026-11-23/read', { read: true })).json().data, {
      readAt: new Date(clock().getTime() - 60_000).toISOString(),
    });
    const list = (await get(account, '/v1/materials?kind=daily')).json().data;
    assert.ok(list.items[0].readAt);
    assert.equal((await get(account, '/v1/materials/daily?date=2026-11-23')).json().data.readAt, list.items[0].readAt);

    assert.deepEqual((await post(account, '/v1/materials/daily/2026-11-23/read', { read: false })).json().data, { readAt: null });
    const extendRead = await post(account, '/v1/materials/extend/2026-11-23/read', { read: true });
    assert.equal(extendRead.statusCode, 200, 'the extend read route is reachable next to adopt and dismiss');

    assert.equal((await post(account, '/v1/materials/daily/2026-11-20/read', { read: true })).statusCode, 404);
    assert.equal((await post(account, '/v1/materials/monthly/2026-11-23/read', { read: true })).statusCode, 400);
    assert.equal((await post(account, '/v1/materials/daily/2026-11-23/read', { read: 'yes' })).statusCode, 400);
    assert.equal((await post(account, '/v1/materials/daily/2026-11-23/read', { read: true, at: 1 })).statusCode, 400);
    const other = await learner();
    assert.equal((await post(other, '/v1/materials/daily/2026-11-23/read', { read: true })).statusCode, 404, "another account's material");
  });

  test('adopt: a lexicon word is ready with cards at once, others pending, existing ones known; idempotent', async () => {
    const account = await learner();
    await seedMaterial(t.db, account.userId, { kind: 'extend', date: '2026-11-23', content: extendMaterial() });
    await seedLexicon(t.db, lexiconEntry('itinerary', { forms: [], examples: [
      { text: 'The itinerary changed twice.', gloss: '行程改了两次。' },
      { text: 'Check the itinerary first.', gloss: '先看行程。' },
    ] }));
    await seedItem(t.db, account.userId, { type: 'phrase', display: 'jet lag', lookupCount: 4 });

    const res = await post(account, '/v1/materials/extend/2026-11-23/adopt', { indexes: [4, 0, 2] });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data, { added: [0, 2], known: [4] });

    const unit = async (type: 'word' | 'phrase', normKey: string) =>
      (await t.db.select().from(items).where(and(eq(items.userId, account.userId), eq(items.type, type), eq(items.normKey, normKey))))[0];
    const itinerary = await unit('word', 'itinerary');
    assert.equal(itinerary?.status, 'ready');
    assert.equal(itinerary?.lookupCount, 0);
    assert.equal((await cardsOf(t.db, account.userId, itinerary!.id)).length, 3);
    const checkIn = await unit('phrase', 'check in');
    assert.equal(checkIn?.status, 'pending');
    assert.equal(checkIn?.display, 'check in');
    assert.equal((await unit('phrase', 'jet lag'))?.lookupCount, 4, 'a known unit is left untouched');

    const again = await post(account, '/v1/materials/extend/2026-11-23/adopt', { indexes: [0, 2, 4] });
    assert.deepEqual(again.json().data, { added: [], known: [0, 2, 4] });
    const known = (await get(account, '/v1/materials/extend?date=2026-11-23')).json().data.known;
    assert.deepEqual(known, [true, false, true, false, true, false]);
  });

  test('adopt validates indexes and the material', async () => {
    const account = await learner();
    await seedMaterial(t.db, account.userId, { kind: 'extend', date: '2026-11-23', content: extendMaterial() });
    for (const payload of [{ indexes: [] }, { indexes: [6] }, { indexes: [1, 1] }, { indexes: [-1] }, { indexes: [0.5] }, { indexes: [0], x: 1 }, {}]) {
      const res = await post(account, '/v1/materials/extend/2026-11-23/adopt', payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
    assert.equal((await post(account, '/v1/materials/extend/2026-11-16/adopt', { indexes: [0] })).statusCode, 404);
    const other = await learner();
    assert.equal((await post(other, '/v1/materials/extend/2026-11-23/adopt', { indexes: [0] })).statusCode, 404);
    assert.equal((await t.db.select().from(items).where(eq(items.userId, other.userId))).length, 0);
  });

  test('dismiss mutes the topic for 30 local days; undo removes it; other is never muted', async () => {
    const account = await learner();
    await seedMaterial(t.db, account.userId, { kind: 'extend', date: '2026-11-23', content: extendMaterial() });
    await seedMaterial(t.db, account.userId, { kind: 'extend', date: '2026-11-16', content: extendMaterial(undefined, { topic: 'other' }) });
    await seedMaterial(t.db, account.userId, { kind: 'extend', date: '2026-11-09', content: extendMaterial(undefined, { topic: 'work' }) });
    await t.db
      .update(users)
      .set({ settings: { extendMuted: [{ topic: 'travel', until: '2026-12-01' }, { topic: 'health', until: '2026-11-20' }] } })
      .where(eq(users.id, account.userId));

    const muted = await post(account, '/v1/materials/extend/2026-11-23/dismiss', {});
    assert.equal(muted.statusCode, 200);
    assert.deepEqual(muted.json().data, { extendMuted: [{ topic: 'travel', until: '2026-12-24' }] }, 'replaced; the expired entry is dropped');

    const work = await post(account, '/v1/materials/extend/2026-11-09/dismiss', { utcOffsetMinutes: -600 });
    assert.deepEqual(work.json().data.extendMuted, [
      { topic: 'travel', until: '2026-12-24' },
      { topic: 'work', until: '2026-12-23' },
    ], 'the local day at the given offset');

    const other = await post(account, '/v1/materials/extend/2026-11-16/dismiss');
    assert.equal(other.statusCode, 200);
    assert.equal(other.json().data.extendMuted.length, 2, 'other is never muted');

    const undo = await post(account, '/v1/materials/extend/2026-11-23/dismiss', { undo: true });
    assert.deepEqual(undo.json().data, { extendMuted: [{ topic: 'work', until: '2026-12-23' }] });
    const me = (await get(account, '/v1/me')).json().data.settings;
    assert.deepEqual(me.extendMuted, [{ topic: 'work', until: '2026-12-23' }]);

    assert.equal((await post(account, '/v1/materials/extend/2026-11-02/dismiss', {})).statusCode, 404);
    assert.equal((await post(account, '/v1/materials/extend/2026-11-23/dismiss', { undo: 'yes' })).statusCode, 400);
  });

  test('every material route needs auth', async () => {
    const date = '2026-11-23';
    for (const [method, url] of [
      ['GET', '/v1/materials?kind=all'],
      ['GET', '/v1/materials/digest'],
      ['GET', '/v1/materials/extend'],
      ['POST', `/v1/materials/daily/${date}/read`],
      ['POST', `/v1/materials/extend/${date}/adopt`],
      ['POST', `/v1/materials/extend/${date}/dismiss`],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      assert.equal(res.statusCode, 401, url);
    }
  });
});
