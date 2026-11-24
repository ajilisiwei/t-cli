import { after, before, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import { cards, items, reviewLogs } from '../src/db/schema.ts';
import { replayCard, retentionFor, toSchedule } from '../src/modules/review/fsrs.ts';
import type { ItemRegenerator } from '../src/ports.ts';
import { buildTestApp, fakeRegenerator, fixedClock, testConfig, type FakeRegenerator, type TestClock } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount, type TestAccount } from './helpers/fixtures.ts';
import { addDevice, createLearner, rate, seedItem, seedLog } from './helpers/learning.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;

describe('review: summary, queue, ratings, undo, report', { skip: skipWithoutDb }, () => {
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
    clock: TestClock;
    regenerator: FakeRegenerator;
  }

  async function setup(
    ctx: TestContext,
    { config = {}, clock = fixedClock(), regenerator = fakeRegenerator() }: { config?: Record<string, string>; clock?: TestClock; regenerator?: FakeRegenerator } = {},
  ): Promise<Setup> {
    const app = await buildTestApp(t.db, { clock, regenerator, config: testConfig(config) });
    ctx.after(() => app.close());
    const account = await createLearner(t.db, { now: clock() });
    return { app, account, clock, regenerator };
  }

  const get = (app: FastifyInstance, account: TestAccount, url: string) => app.inject({ method: 'GET', url, headers: account.headers });
  const push = (app: FastifyInstance, account: TestAccount, logs: unknown[]) =>
    app.inject({ method: 'POST', url: '/v1/reviews', headers: account.headers, payload: { logs } });
  const logAt = (cardId: string, rating: number, at: Date, id = ulid({ time: at.getTime() })) => ({ id, cardId, rating, reviewedAt: at.toISOString() });
  const queueIds = async (app: FastifyInstance, account: TestAccount, query = '') =>
    ((await get(app, account, `/v1/review/queue${query}`)).json().data.cards as { id: string }[]).map((card) => card.id);
  const summary = async (app: FastifyInstance, account: TestAccount, query = '') => (await get(app, account, `/v1/review/summary${query}`)).json().data;

  test('every route requires a valid access token', async (ctx) => {
    const { app } = await setup(ctx);
    const routes: [string, string][] = [
      ['GET', '/v1/review/summary'],
      ['GET', '/v1/review/queue'],
      ['POST', '/v1/reviews'],
      ['DELETE', `/v1/reviews/${ulid()}`],
      ['POST', `/v1/cards/${ulid()}/report`],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as 'GET', url, payload: method === 'POST' ? {} : undefined });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
      assert.equal(res.json().error.code, 'UNAUTHORIZED');
    }
  });

  test('an empty account: nothing due, empty queue', async (ctx) => {
    const { app, account } = await setup(ctx);
    assert.deepEqual(await summary(app, account), { due: 0, newAvailable: 0, reviewDue: 0, doneToday: 0, estimatedMinutes: 0, streakDays: 0 });
    assert.deepEqual(await queueIds(app, account), []);
  });

  test('the queue: due non-new cards first (oldest due first), then new cards by item weight', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const light = await seedItem(t.db, account.userId, { type: 'phrase', display: 'be torn between', lookupCount: 1 });
    const heavy = await seedItem(t.db, account.userId, { type: 'grammar', display: 'look forward to + -ing', lookupCount: 1, errorCount: 3 }); // weight 7
    const middle = await seedItem(t.db, account.userId, { type: 'phrase', display: 'on the fence', lookupCount: 5 }); // weight 5
    const early = await seedItem(t.db, account.userId, { type: 'phrase', display: 'call it a day' });
    const late = await seedItem(t.db, account.userId, { type: 'phrase', display: 'a piece of cake' });

    // `early` is rated first, `late` an hour later: both reach the review state, `early` comes due first.
    const start = clock();
    await rate(app, account, clock, early.cardIds[0]!, 4);
    clock.advance(60 * MINUTE);
    await rate(app, account, clock, late.cardIds[0]!, 4);
    clock.set(new Date(start.getTime() + 30 * DAY));

    const queue = (await get(app, account, '/v1/review/queue')).json().data.cards as { id: string; itemId: string; itemType: string; cardType: string; state: string; front: { text: string } }[];
    assert.deepEqual(
      queue.map((card) => card.id),
      [early.cardIds[0], late.cardIds[0], heavy.cardIds[0], middle.cardIds[0], light.cardIds[0]],
    );
    assert.deepEqual(queue.map((card) => card.state), ['review', 'review', 'new', 'new', 'new']);
    assert.deepEqual(
      { itemId: queue[2]!.itemId, itemType: queue[2]!.itemType, cardType: queue[2]!.cardType, front: queue[2]!.front.text },
      { itemId: heavy.itemId, itemType: 'grammar', cardType: 'fix', front: 'I look forward to hear from you.' },
    );
    assert.deepEqual(await queueIds(app, account, '?limit=2'), [early.cardIds[0], late.cardIds[0]]);
    for (const limit of ['0', '101', 'x']) assert.equal((await get(app, account, `/v1/review/queue?limit=${limit}`)).statusCode, 400);
  });

  test('a review card is due for the whole local day it falls on; learning steps only once their time has come', async (ctx) => {
    const { app, account, clock } = await setup(ctx, { clock: fixedClock(new Date('2026-11-17T08:00:00+08:00')) });
    // 1 ★ → retention 0.90 (the intervals below; 0 ★ would use 0.85).
    const item = await seedItem(t.db, account.userId, { type: 'phrase', display: 'in a nutshell', stars: 1 });
    const cardId = item.cardIds[0]!;
    const learning = await rate(app, account, clock, cardId, 3);
    assert.equal(learning.state, 'learning');
    assert.equal(learning.due, new Date('2026-11-17T08:10:00+08:00').toISOString());
    assert.deepEqual(await queueIds(app, account), [], 'a learning card waits for its step');
    clock.advance(10 * MINUTE);
    assert.deepEqual(await queueIds(app, account), [cardId]);

    const reviewed = await rate(app, account, clock, cardId, 3);
    assert.equal(reviewed.state, 'review');
    // Due 2 days later at 08:10 local: served from that day's local midnight on, not before.
    assert.equal(reviewed.due, new Date('2026-11-19T08:10:00+08:00').toISOString());
    clock.set(new Date('2026-11-18T23:59:00+08:00'));
    assert.deepEqual(await queueIds(app, account), []);
    clock.set(new Date('2026-11-19T00:01:00+08:00'));
    assert.deepEqual(await queueIds(app, account), [cardId]);
    assert.equal((await summary(app, account)).reviewDue, 1);
    // The same instant is still the 18th at UTC+0.
    assert.deepEqual(await queueIds(app, account, '?utcOffsetMinutes=0'), []);
  });

  test('intervals preview the next due time per rating, in seconds', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const item = await seedItem(t.db, account.userId, { type: 'phrase', display: 'break the ice', stars: 1 }); // retention 0.90
    const cardId = item.cardIds[0]!;
    const intervals = async () => ((await get(app, account, '/v1/review/queue')).json().data.cards as { intervals: Record<string, number> }[])[0]!.intervals;
    assert.deepEqual(await intervals(), { '1': 60, '2': 360, '3': 600, '4': 8 * 86_400 });

    await rate(app, account, clock, cardId, 3);
    clock.advance(10 * MINUTE);
    await rate(app, account, clock, cardId, 3);
    clock.advance(2 * DAY);
    const review = await intervals();
    assert.equal(review['1'], 600, 'Again → the 10-minute relearning step');
    assert.ok(review['2']! % 86_400 === 0 && review['2']! > 0);
    assert.ok(review['2']! <= review['3']! && review['3']! < review['4']!, JSON.stringify(review));

    // The preview is exactly what a rating then does.
    const after = await rate(app, account, clock, cardId, 3);
    assert.equal(Date.parse(after.due) - clock().getTime(), review['3']! * 1000);
  });

  test('POST /v1/reviews validates each log on its own and rejects unknown or foreign cards', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const other = await createLearner(t.db, { now: clock() });
    const mine = await seedItem(t.db, account.userId, { type: 'phrase', display: 'hit the sack' });
    const theirs = await seedItem(t.db, other.userId, { type: 'phrase', display: 'their phrase' });
    const now = clock();
    const good = logAt(mine.cardIds[0]!, 3, now);
    const res = await push(app, account, [
      good,
      logAt(theirs.cardIds[0]!, 3, now),
      logAt(ulid(), 3, now),
      { ...logAt(mine.cardIds[0]!, 5, now) },
      { ...logAt(mine.cardIds[0]!, 3, now), id: 'not-a-ulid' },
      logAt(mine.cardIds[0]!, 3, new Date(now.getTime() + 6 * MINUTE)),
      { ...logAt(mine.cardIds[0]!, 3, now), reviewedAt: '2026-11-17 10:00' },
      { ...logAt(mine.cardIds[0]!, 3, now), durationMs: -1 },
      'not an object',
    ]);
    assert.equal(res.statusCode, 200);
    const body = res.json().data as { accepted: string[]; rejected: { id: string | null; errors: string[] }[]; cards: { id: string; state: string }[] };
    assert.deepEqual(body.accepted, [good.id]);
    assert.equal(body.rejected.length, 8);
    assert.deepEqual(body.rejected.find((r) => r.errors.includes('unknown card'))?.errors, ['unknown card']);
    assert.equal(body.rejected.filter((r) => r.errors.includes('unknown card')).length, 2, 'foreign and unknown cards look the same');
    assert.ok(body.rejected.some((r) => r.errors.some((e) => e.startsWith('reviewedAt: is in the future'))));
    assert.ok(body.rejected.some((r) => r.id === null), 'a non-object has no id');
    assert.deepEqual(body.cards.map((card) => [card.id, card.state]), [[mine.cardIds[0], 'learning']]);
    assert.ok(!res.body.includes('their phrase'));

    // Within the 5-minute tolerance is fine.
    const nearFuture = logAt(mine.cardIds[0]!, 3, new Date(now.getTime() + 4 * MINUTE));
    assert.deepEqual((await push(app, account, [nearFuture])).json().data.accepted, [nearFuture.id]);

    const theirCard = await t.db.select().from(cards).where(and(eq(cards.userId, other.userId), eq(cards.id, theirs.cardIds[0]!)));
    assert.equal(theirCard[0]?.reps, 0, "the other account's card is untouched");

    for (const payload of [{}, { logs: [] }, { logs: Array.from({ length: 201 }, () => good) }, { logs: 'x' }]) {
      const bad = await app.inject({ method: 'POST', url: '/v1/reviews', headers: account.headers, payload });
      assert.equal(bad.statusCode, 400);
      assert.equal(bad.json().error.code, 'VALIDATION_FAILED');
    }
  });

  test('pushes are idempotent by log id', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const item = await seedItem(t.db, account.userId, { type: 'phrase', display: 'once in a blue moon' });
    const cardId = item.cardIds[0]!;
    const log = logAt(cardId, 3, clock());
    const first = (await push(app, account, [log, log])).json().data;
    const second = (await push(app, account, [log])).json().data;
    assert.deepEqual(first.accepted, [log.id]);
    assert.deepEqual(second.accepted, [log.id]);
    assert.deepEqual(second.cards, first.cards);
    const stored = await t.db.select().from(reviewLogs).where(eq(reviewLogs.userId, account.userId));
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.deviceId, account.deviceId);
    const [card] = await t.db.select().from(cards).where(and(eq(cards.userId, account.userId), eq(cards.id, cardId)));
    assert.equal(card?.reps, 1);
  });

  test("two devices' offline ratings both count, whatever order they arrive in (replay by reviewed_at, id)", async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const a = await seedItem(t.db, account.userId, { type: 'phrase', display: 'device order a' });
    const b = await seedItem(t.db, account.userId, { type: 'phrase', display: 'device order b' });
    const t0 = clock();
    const times = [t0, new Date(t0.getTime() + 10 * MINUTE), new Date(t0.getTime() + 3 * DAY), new Date(t0.getTime() + 10 * DAY)];
    const ratings = [3, 3, 1, 3] as const;
    clock.set(new Date(t0.getTime() + 11 * DAY));

    // Card A: the CLI pushes logs 0 and 2, later the phone pushes 1 and 3.
    const cli = await addDevice(t.db, account, { now: t0 });
    const logsA = times.map((at, i) => logAt(a.cardIds[0]!, ratings[i]!, at));
    await push(app, cli, [logsA[0], logsA[2]]);
    const final = (await push(app, account, [logsA[3], logsA[1]])).json().data.cards[0];
    const devicesOfLogs = await t.db.select({ deviceId: reviewLogs.deviceId }).from(reviewLogs).where(eq(reviewLogs.cardId, a.cardIds[0]!));
    assert.deepEqual(new Set(devicesOfLogs.map((row) => row.deviceId)), new Set([cli.deviceId, account.deviceId]));
    // Card B: everything in one batch, reversed.
    const logsB = times.map((at, i) => logAt(b.cardIds[0]!, ratings[i]!, at));
    await push(app, account, [...logsB].reverse());

    const rows = await t.db.select().from(cards).where(eq(cards.userId, account.userId));
    const pick = (id: string) => {
      const row = rows.find((r) => r.id === id)!;
      return { state: row.state, due: row.due.toISOString(), stability: row.stability, difficulty: row.difficulty, reps: row.reps, lapses: row.lapses, scheduledDays: row.scheduledDays };
    };
    assert.deepEqual(pick(a.cardIds[0]!), pick(b.cardIds[0]!));
    assert.equal(pick(a.cardIds[0]!).reps, 4);
    assert.equal(pick(a.cardIds[0]!).lapses, 1);

    // Seeded items have no note: 0 stars → retention 0.85.
    const expected = toSchedule(
      replayCard(new Date('2026-11-16T21:00:00Z'), times.map((at, i) => ({ id: logsA[i]!.id, rating: ratings[i]!, reviewedAt: at })), retentionFor(0, true)),
      180,
    );
    assert.equal(final.due, expected.due.toISOString());
    assert.equal(pick(a.cardIds[0]!).stability, expected.stability);
  });

  test('undo: within 5 minutes of acceptance the card goes back; later → 409 UNDO_EXPIRED; unknown or foreign → 404', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const other = await createLearner(t.db, { now: clock() });
    const item = await seedItem(t.db, account.userId, { type: 'phrase', display: 'under the weather' });
    const cardId = item.cardIds[0]!;
    const undo = (who: TestAccount, id: string) => app.inject({ method: 'DELETE', url: `/v1/reviews/${id}`, headers: who.headers });

    const first = logAt(cardId, 3, clock());
    const afterFirst = (await push(app, account, [first])).json().data.cards[0];
    clock.advance(10 * MINUTE);
    const second = logAt(cardId, 3, clock());
    await push(app, account, [second]);

    assert.equal((await undo(other, second.id)).statusCode, 404, "another account's log");
    clock.advance(5 * MINUTE);
    const undone = await undo(account, second.id);
    assert.equal(undone.statusCode, 200);
    assert.deepEqual(undone.json().data.card, afterFirst);
    assert.equal((await undo(account, second.id)).statusCode, 404, 'already undone');
    assert.equal((await undo(account, ulid())).statusCode, 404);

    // The first log was accepted 15 minutes ago.
    const expired = await undo(account, first.id);
    assert.equal(expired.statusCode, 409);
    assert.equal(expired.json().error.code, 'UNDO_EXPIRED');

    // The window counts from when the server accepted the log, not from reviewedAt.
    const offline = logAt(cardId, 2, new Date(clock().getTime() - 2 * DAY));
    await push(app, account, [offline]);
    clock.advance(4 * MINUTE);
    assert.equal((await undo(account, offline.id)).statusCode, 200);
  });

  test('daily limits (D10) reset at local midnight', async (ctx) => {
    const { app, account, clock } = await setup(ctx, {
      config: { REVIEW_NEW_PER_DAY: '2', REVIEW_MAX_PER_DAY: '1' },
      clock: fixedClock(new Date('2026-11-17T23:30:00+08:00')),
    });
    const seeded = [];
    for (const display of ['limit one', 'limit two', 'limit three', 'limit four']) {
      seeded.push(await seedItem(t.db, account.userId, { type: 'phrase', display, createdAt: new Date('2026-11-17T10:00:00+08:00') }));
    }
    const cardIds = seeded.map((item) => item.cardIds[0]!);
    assert.deepEqual(
      { due: (await summary(app, account)).due, newAvailable: (await summary(app, account)).newAvailable },
      { due: 2, newAvailable: 2 },
    );
    await rate(app, account, clock, cardIds[0]!, 1);
    await rate(app, account, clock, cardIds[1]!, 1);
    let s = await summary(app, account);
    assert.deepEqual({ newAvailable: s.newAvailable, doneToday: s.doneToday }, { newAvailable: 0, doneToday: 2 });

    // Both learning cards come due in a minute; only one non-new review is allowed today.
    clock.advance(2 * MINUTE);
    s = await summary(app, account);
    assert.deepEqual({ due: s.due, reviewDue: s.reviewDue, newAvailable: s.newAvailable }, { due: 1, reviewDue: 1, newAvailable: 0 });
    assert.equal((await queueIds(app, account)).length, 1);
    await rate(app, account, clock, cardIds[0]!, 3);
    s = await summary(app, account);
    assert.deepEqual({ due: s.due, doneToday: s.doneToday, estimatedMinutes: s.estimatedMinutes }, { due: 0, doneToday: 3, estimatedMinutes: 0 });
    assert.deepEqual(await queueIds(app, account), []);

    // 00:05 local on the 18th: a new day, new limits.
    clock.set(new Date('2026-11-18T00:05:00+08:00'));
    s = await summary(app, account);
    assert.deepEqual({ newAvailable: s.newAvailable, reviewDue: s.reviewDue, doneToday: s.doneToday }, { newAvailable: 2, reviewDue: 1, doneToday: 0 });
    assert.equal(s.estimatedMinutes, 1);
    const queue = await queueIds(app, account);
    assert.equal(queue.length, 3);
    assert.ok(queue.slice(1).every((id) => id === cardIds[2] || id === cardIds[3]), 'then the two new cards');

    // At UTC+0 it is still the 17th (16:05): the limits used there still apply.
    s = await summary(app, account, '?utcOffsetMinutes=0');
    assert.deepEqual({ newAvailable: s.newAvailable, doneToday: s.doneToday }, { newAvailable: 0, doneToday: 3 });
    assert.equal((await get(app, account, '/v1/review/summary?utcOffsetMinutes=900')).statusCode, 400);
  });

  test('mastered and suspended cards leave the queue', async (ctx) => {
    const { app, account, clock } = await setup(ctx, { config: { MASTERED_DAYS: '30' } });
    const item = await seedItem(t.db, account.userId, { type: 'phrase', display: 'piece of cake' });
    const cardId = item.cardIds[0]!;
    let card = await rate(app, account, clock, cardId, 4);
    for (let i = 0; i < 5 && !card.mastered; i += 1) {
      clock.set(new Date(card.due));
      card = await rate(app, account, clock, cardId, 4);
    }
    assert.equal(card.mastered, true);
    clock.set(new Date(Date.parse(card.due) + DAY));
    assert.deepEqual(await queueIds(app, account), []);
    assert.equal((await summary(app, account)).due, 0);

    const suspended = await seedItem(t.db, account.userId, { type: 'phrase', display: 'suspended phrase' });
    await t.db.update(cards).set({ suspended: true }).where(eq(cards.id, suspended.cardIds[0]!));
    assert.deepEqual(await queueIds(app, account), []);
  });

  test('report: suspends the item, marks it needs_regen, starts regeneration without waiting → 202', async (ctx) => {
    const pending = Promise.withResolvers<void>();
    const calls: { userId: string; itemId: string }[] = [];
    const slow: ItemRegenerator & FakeRegenerator = {
      calls,
      async regenerate(userId, itemId) {
        calls.push({ userId, itemId });
        await pending.promise;
      },
    };
    const { app, account } = await setup(ctx, { regenerator: slow });
    ctx.after(() => pending.resolve());
    const other = await createAccount(t.db);
    const word = await seedItem(t.db, account.userId, { type: 'word', display: 'meticulous' });
    const theirs = await seedItem(t.db, other.userId, { type: 'word', display: 'theirs' });
    const report = (who: TestAccount, id: string) => app.inject({ method: 'POST', url: `/v1/cards/${id}/report`, headers: who.headers });

    const res = await report(account, word.cardIds[1]!);
    assert.equal(res.statusCode, 202);
    assert.deepEqual(res.json(), { success: true, data: { regenerating: true }, error: null });
    assert.deepEqual(calls, [{ userId: account.userId, itemId: word.itemId }]);
    const rows = await t.db.select().from(cards).where(and(eq(cards.userId, account.userId), eq(cards.itemId, word.itemId)));
    assert.deepEqual(rows.map((row) => row.suspended), [true, true, true]);
    const [item] = await t.db.select().from(items).where(and(eq(items.userId, account.userId), eq(items.id, word.itemId)));
    assert.equal(item?.status, 'needs_regen');

    // A second report while the first regeneration runs does not start another.
    assert.equal((await report(account, word.cardIds[0]!)).statusCode, 202);
    assert.equal(calls.length, 1);

    assert.equal((await report(account, theirs.cardIds[0]!)).statusCode, 404);
    assert.equal((await report(account, ulid())).statusCode, 404);
    assert.equal(calls.length, 1);
    const [theirItem] = await t.db.select().from(items).where(eq(items.id, theirs.itemId));
    assert.equal(theirItem?.status, 'ready');
  });

  test('report: a failing regeneration is logged, not surfaced; at most 10 reports per minute', async (ctx) => {
    const { app, account, clock, regenerator } = await setup(ctx, { regenerator: fakeRegenerator(true) });
    const item = await seedItem(t.db, account.userId, { type: 'phrase', display: 'report limit' });
    const report = () => app.inject({ method: 'POST', url: `/v1/cards/${item.cardIds[0]}/report`, headers: account.headers });
    for (let i = 0; i < 10; i += 1) assert.equal((await report()).statusCode, 202);
    const limited = await report();
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.ok(regenerator.calls.length >= 1);
    clock.advance(MINUTE + 1);
    assert.equal((await report()).statusCode, 202);
  });

  test('summary counts what the queue serves; logs seeded for another account do not count', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const other = await createAccount(t.db);
    const mine = await seedItem(t.db, account.userId, { type: 'word', display: 'summary word' });
    const theirs = await seedItem(t.db, other.userId, { type: 'phrase', display: 'their summary' });
    await seedLog(t.db, other.userId, { cardId: theirs.cardIds[0]!, rating: 3, reviewedAt: clock() });
    const s = await summary(app, account);
    assert.deepEqual(s, { due: 3, newAvailable: 3, reviewDue: 0, doneToday: 0, estimatedMinutes: 1, streakDays: 0 });
    assert.equal((await queueIds(app, account)).length, mine.cardIds.length);
  });
});
