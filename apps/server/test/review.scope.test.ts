import { after, before, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, fixedClock, testConfig, type TestClock } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import type { TestAccount } from './helpers/fixtures.ts';
import { createLearner, rate, seedItem } from './helpers/learning.ts';

const DAY = 86_400_000;

describe('review scope (v3)', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  async function setup(ctx: TestContext, config: Record<string, string> = {}, clock: TestClock = fixedClock()) {
    const app = await buildTestApp(t.db, { clock, config: testConfig(config) });
    ctx.after(() => app.close());
    const account = await createLearner(t.db, { now: clock() });
    return { app, account, clock };
  }

  const get = (app: FastifyInstance, account: TestAccount, url: string) => app.inject({ method: 'GET', url, headers: account.headers });
  const queueIds = async (app: FastifyInstance, account: TestAccount, scope?: string) =>
    ((await get(app, account, `/v1/review/queue${scope ? `?scope=${scope}` : ''}`)).json().data.cards as { id: string }[]).map((card) => card.id);

  test('scope filters due and new cards alike; order is unchanged', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const none = await seedItem(t.db, account.userId, { type: 'phrase', display: 'no star', lookupCount: 9 });
    const one = await seedItem(t.db, account.userId, { type: 'phrase', display: 'one star', stars: 1 });
    const three = await seedItem(t.db, account.userId, { type: 'phrase', display: 'three stars', stars: 3 });
    const reviewedNone = await seedItem(t.db, account.userId, { type: 'phrase', display: 'reviewed none' });
    const reviewedFour = await seedItem(t.db, account.userId, { type: 'phrase', display: 'reviewed four', stars: 4 });
    await rate(app, account, clock, reviewedNone.cardIds[0]!, 4);
    await rate(app, account, clock, reviewedFour.cardIds[0]!, 4);
    clock.advance(40 * DAY);
    // Due reviews come first, oldest due first: 4 ★ (retention 0.95) is due sooner than 0 ★ (0.85).

    const ids = (items: { cardIds: string[] }[]) => items.map((item) => item.cardIds[0]);
    assert.deepEqual(await queueIds(app, account), ids([reviewedFour, reviewedNone, three, one, none]));
    assert.deepEqual(await queueIds(app, account, 'all'), ids([reviewedFour, reviewedNone, three, one, none]));
    assert.deepEqual(await queueIds(app, account, 'notes'), ids([reviewedFour, three, one]));
    assert.deepEqual(await queueIds(app, account, 'stars3'), ids([reviewedFour, three]));

    const summary = (await get(app, account, '/v1/review/summary')).json().data;
    assert.deepEqual(summary.dueByScope, { all: 5, notes: 3, stars3: 2 });
    assert.equal(summary.due, summary.dueByScope.all);
  });

  test('each scope is computed with the same daily limits', async (ctx) => {
    const { app, account } = await setup(ctx, { REVIEW_NEW_PER_DAY: '2' });
    for (let i = 0; i < 3; i += 1) await seedItem(t.db, account.userId, { type: 'phrase', display: `starred ${i}`, stars: 3 });
    await seedItem(t.db, account.userId, { type: 'phrase', display: 'one star', stars: 1 });
    await seedItem(t.db, account.userId, { type: 'phrase', display: 'plain' });

    const summary = (await get(app, account, '/v1/review/summary')).json().data;
    assert.deepEqual(summary.dueByScope, { all: 2, notes: 2, stars3: 2 });
    assert.equal((await queueIds(app, account, 'stars3')).length, 2);
  });

  test('an unknown scope is 400', async (ctx) => {
    const { app, account } = await setup(ctx);
    const res = await get(app, account, '/v1/review/queue?scope=stars5');
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'VALIDATION_FAILED');
  });
});
