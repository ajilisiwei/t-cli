import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema.ts';
import { effectiveLevel, levelStats } from '../src/modules/learn/level.ts';
import { buildTestApp, fixedClock, type TestClock } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import type { TestAccount } from './helpers/fixtures.ts';
import { createLearner, dailyMaterial, extendMaterial, seedItem, seedLog, seedMaterial } from './helpers/learning.ts';

const DAY = 86_400_000;

describe('effectiveLevel (pure)', () => {
  test('a fixed setting wins; auto follows retention30 and reviews30', () => {
    assert.equal(effectiveLevel('A2', { retention30: 0.99, reviews30: 999 }), 'A2');
    assert.equal(effectiveLevel('auto', { retention30: null, reviews30: 0 }), 'B1');
    assert.equal(effectiveLevel('auto', { retention30: 0.93, reviews30: 300 }), 'C1');
    assert.equal(effectiveLevel('auto', { retention30: 0.93, reviews30: 299 }), 'B2', 'too few reviews for C1, enough for B2');
    assert.equal(effectiveLevel('auto', { retention30: 0.9299, reviews30: 1000 }), 'B2');
    assert.equal(effectiveLevel('auto', { retention30: 0.88, reviews30: 150 }), 'B2');
    assert.equal(effectiveLevel('auto', { retention30: 0.88, reviews30: 149 }), 'B1');
    assert.equal(effectiveLevel('auto', { retention30: 0.8799, reviews30: 500 }), 'B1');
    assert.equal(effectiveLevel('auto', { retention30: 0.6999, reviews30: 50 }), 'A2');
    assert.equal(effectiveLevel('auto', { retention30: 0.6999, reviews30: 49 }), 'B1', 'fewer than 50 reviews keep B1');
    assert.equal(effectiveLevel('auto', { retention30: 0.7, reviews30: 400 }), 'B1');
  });
});

describe('GET /v1/learn/summary', { skip: skipWithoutDb }, () => {
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

  const summary = async (account: TestAccount, query = '') => {
    const res = await app.inject({ method: 'GET', url: `/v1/learn/summary${query}`, headers: account.headers });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data;
  };

  test('a new account: zeros, no materials, the default plan and level', async () => {
    const account = await createLearner(t.db, { now: clock() });
    assert.deepEqual(await summary(account), {
      review: { dueByScope: { all: 0, notes: 0, stars3: 0 }, doneToday: 0, estimatedMinutes: 0, streakDays: 0 },
      materials: [],
      plan: { materialFrequency: 'daily', materialWeekday: 1, extendEnabled: true },
      level: { setting: 'auto', effective: 'B1', retention30: null, reviews30: 0 },
    });
  });

  test('review by scope, the 3 latest materials, the plan from settings and the level from reviews', async () => {
    const account = await createLearner(t.db, { now: clock() });
    await t.db
      .update(users)
      .set({ settings: { materialFrequency: 'weekly', materialWeekday: 0, extendEnabled: false, studyLevel: 'auto' } })
      .where(eq(users.id, account.userId));
    await seedItem(t.db, account.userId, { type: 'phrase', display: 'starred', stars: 3 });
    await seedItem(t.db, account.userId, { type: 'phrase', display: 'plain' });

    // One card reviewed 10 times in the window (the first log introduces it): 8 of 9 later ratings ≥ 2.
    const reviewed = await seedItem(t.db, account.userId, { type: 'phrase', display: 'reviewed', createdAt: new Date(clock().getTime() - 40 * DAY) });
    const cardId = reviewed.cardIds[0]!;
    await seedLog(t.db, account.userId, { cardId, rating: 3, reviewedAt: new Date(clock().getTime() - 35 * DAY) });
    await seedLog(t.db, account.userId, { cardId, rating: 1, reviewedAt: new Date(clock().getTime() - 31 * DAY) }); // outside the window
    for (let i = 0; i < 9; i += 1) {
      await seedLog(t.db, account.userId, { cardId, rating: i === 4 ? 1 : 3, reviewedAt: new Date(clock().getTime() - (20 - i) * DAY) });
    }

    for (const date of ['2026-11-20', '2026-11-21', '2026-11-22']) {
      await seedMaterial(t.db, account.userId, { date, content: dailyMaterial(date) });
    }
    await seedMaterial(t.db, account.userId, { kind: 'extend', date: '2026-11-22', content: extendMaterial() });

    const data = await summary(account);
    // Seeded logs are not replayed, so the reviewed card still counts as new and due.
    assert.deepEqual(data.review.dueByScope, { all: 3, notes: 1, stars3: 1 });
    assert.equal(data.review.estimatedMinutes, 1);
    assert.deepEqual(
      data.materials.map((item: { kind: string; date: string }) => [item.kind, item.date]),
      [
        ['extend', '2026-11-22'],
        ['daily', '2026-11-22'],
        ['daily', '2026-11-21'],
      ],
    );
    assert.equal(data.materials[0].title, '出差旅行常用表达');
    assert.deepEqual(data.plan, { materialFrequency: 'weekly', materialWeekday: 0, extendEnabled: false });
    assert.deepEqual(data.level, { setting: 'auto', effective: 'B1', retention30: 0.8889, reviews30: 9 });
    assert.deepEqual(await levelStats(t.db, account.userId, clock()), { retention30: 0.8889, reviews30: 9 });

    await t.db.update(users).set({ settings: { studyLevel: 'C1' } }).where(eq(users.id, account.userId));
    assert.deepEqual((await summary(account)).level, { setting: 'C1', effective: 'C1', retention30: 0.8889, reviews30: 9 });
  });

  test('requires auth and validates utcOffsetMinutes', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/learn/summary' })).statusCode, 401);
    const account = await createLearner(t.db, { now: clock() });
    const res = await app.inject({ method: 'GET', url: '/v1/learn/summary?utcOffsetMinutes=900', headers: account.headers });
    assert.equal(res.statusCode, 400);
  });
});
