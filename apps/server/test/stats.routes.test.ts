import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { insertEntries } from '../src/db/entriesRepo.ts';
import { cards } from '../src/db/schema.ts';
import { streakFrom } from '../src/modules/review/activity.ts';
import { buildTestApp, fixedClock, type TestClock } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { makeEntry, type TestAccount } from './helpers/fixtures.ts';
import { createLearner, seedItem, seedLog } from './helpers/learning.ts';

describe('streak rule (pure)', () => {
  test('counts back from today, or from yesterday while today has nothing yet', () => {
    const today = '2026-11-17';
    assert.equal(streakFrom([], today), 0);
    assert.equal(streakFrom(['2026-11-17'], today), 1);
    assert.equal(streakFrom(['2026-11-16', '2026-11-15'], today), 2, 'today empty: the streak still stands');
    assert.equal(streakFrom(['2026-11-17', '2026-11-16', '2026-11-15'], today), 3);
    assert.equal(streakFrom(['2026-11-15', '2026-11-14'], today), 0, 'yesterday empty: broken');
    assert.equal(streakFrom(['2026-11-17', '2026-11-15'], today), 1);
    assert.equal(streakFrom(['2026-03-01', '2026-02-28', '2026-02-27'], '2026-03-01'), 3, 'across a month end');
  });
});

describe('stats: GET /v1/stats', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let clock: TestClock;
  before(async () => {
    t = await createTestDatabase();
    // Tuesday 2026-11-17, 10:00 at UTC+8.
    clock = fixedClock();
    app = await buildTestApp(t.db, { clock });
  });
  after(async () => {
    await app?.close();
    await t?.drop();
  });

  const stats = async (account: TestAccount, query = '') => {
    const res = await app.inject({ method: 'GET', url: `/v1/stats${query}`, headers: account.headers });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data;
  };
  const entryAt = (iso: string) => makeEntry({ createdAt: new Date(iso) });

  test('an empty account', async () => {
    const account = await createLearner(t.db, { now: clock() });
    assert.deepEqual(await stats(account), { days: [], streakDays: 0, retention: [], totals: { entries: 0, items: 0, cards: 0, mastered: 0 } });
  });

  test('days with activity only, by local date; the streak survives an empty today, counts reviews too', async () => {
    const account = await createLearner(t.db, { now: clock() });
    await insertEntries(t.db, account.userId, [
      entryAt('2026-11-14T09:00:00+08:00'),
      entryAt('2026-11-14T23:30:00+08:00'),
      entryAt('2026-11-16T00:10:00+08:00'),
      entryAt('2026-11-10T12:00:00+08:00'),
    ]);
    const item = await seedItem(t.db, account.userId, { type: 'phrase', display: 'stats phrase', createdAt: new Date('2026-11-01T00:00:00Z') });
    await seedLog(t.db, account.userId, { cardId: item.cardIds[0]!, rating: 3, reviewedAt: new Date('2026-11-15T20:00:00+08:00') });

    let data = await stats(account);
    assert.deepEqual(data.days, [
      { date: '2026-11-10', entries: 1, reviews: 0 },
      { date: '2026-11-14', entries: 2, reviews: 0 },
      { date: '2026-11-15', entries: 0, reviews: 1 },
      { date: '2026-11-16', entries: 1, reviews: 0 },
    ]);
    assert.equal(data.streakDays, 3, '14, 15 (a review only), 16 — today has nothing yet');
    assert.deepEqual((await stats(account, '?days=3')).days.map((d: { date: string }) => d.date), ['2026-11-15', '2026-11-16']);

    // At UTC+0 the 23:30 (+08:00) entry falls on the 14th and the 00:10 one on the 15th.
    const utc = await stats(account, '?utcOffsetMinutes=0');
    assert.deepEqual(utc.days.map((d: { date: string; entries: number; reviews: number }) => [d.date, d.entries, d.reviews]), [
      ['2026-11-10', 1, 0],
      ['2026-11-14', 2, 0],
      ['2026-11-15', 1, 1],
    ]);
    assert.equal(utc.streakDays, 0, 'at UTC+0 it is 02:00 on the 17th: the 16th is empty, the streak is broken');

    await insertEntries(t.db, account.userId, [entryAt('2026-11-17T08:00:00+08:00')]);
    data = await stats(account);
    assert.equal(data.streakDays, 4);
    const summary = await app.inject({ method: 'GET', url: '/v1/review/summary', headers: account.headers });
    assert.equal(summary.json().data.streakDays, 4, 'the review summary uses the same rule');

    for (const query of ['?days=0', '?days=367', '?utcOffsetMinutes=-721']) {
      assert.equal((await app.inject({ method: 'GET', url: `/v1/stats${query}`, headers: account.headers })).statusCode, 400, query);
    }
  });

  test('retention: share of ratings ≥ 2 on non-new cards per local week, last 12 weeks, empty weeks omitted', async () => {
    const account = await createLearner(t.db, { now: clock() });
    const item = await seedItem(t.db, account.userId, { type: 'word', display: 'retention', createdAt: new Date('2026-07-01T00:00:00Z') });
    const [c1, c2, c3] = item.cardIds as [string, string, string];
    const log = (cardId: string, rating: number, iso: string) => seedLog(t.db, account.userId, { cardId, rating, reviewedAt: new Date(iso) });

    // First logs introduce the cards: never counted, even when rated 1.
    await log(c1, 1, '2026-11-02T09:00:00+08:00');
    await log(c2, 3, '2026-11-02T09:05:00+08:00');
    // Week of Nov 2: three ratings of non-new cards, two ≥ 2.
    await log(c1, 3, '2026-11-03T09:00:00+08:00');
    await log(c1, 1, '2026-11-05T09:00:00+08:00');
    await log(c2, 2, '2026-11-08T23:30:00+08:00'); // Sunday night, still the Nov 2 week locally
    // Week of Nov 16 (current): one rating, ≥ 2.
    await log(c1, 4, '2026-11-17T08:00:00+08:00');
    // 13 weeks ago, a non-new rating: outside the window.
    await log(c3, 3, '2026-08-10T09:00:00+08:00');
    await log(c3, 1, '2026-08-17T09:00:00+08:00');

    const data = await stats(account);
    assert.deepEqual(data.retention, [
      { weekStart: '2026-11-02', rate: 0.6667 },
      { weekStart: '2026-11-16', rate: 1 },
    ]);
    // At UTC+0 the Sunday-night rating moves to Sunday 15:30 — same week; the window start moves with the offset.
    assert.deepEqual((await stats(account, '?utcOffsetMinutes=0')).retention.map((w: { weekStart: string }) => w.weekStart), ['2026-11-02', '2026-11-16']);
  });

  test('totals count entries, items, cards and mastered cards of the caller only', async () => {
    const account = await createLearner(t.db, { now: clock() });
    await insertEntries(t.db, account.userId, [makeEntry(), makeEntry(), makeEntry()]);
    const word = await seedItem(t.db, account.userId, { type: 'word', display: 'totals word' });
    await seedItem(t.db, account.userId, { type: 'grammar', display: 'totals grammar' });
    await t.db.update(cards).set({ mastered: true }).where(eq(cards.id, word.cardIds[0]!));
    const other = await createLearner(t.db, { now: clock() });
    await insertEntries(t.db, other.userId, [makeEntry()]);
    await seedItem(t.db, other.userId, { type: 'word', display: 'other word' });

    assert.deepEqual((await stats(account)).totals, { entries: 3, items: 2, cards: 4, mastered: 1 });
  });
});
