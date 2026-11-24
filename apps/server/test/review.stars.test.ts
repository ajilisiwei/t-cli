import { after, before, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { cards, reviewLogs, users } from '../src/db/schema.ts';
import { rescheduleAccount } from '../src/modules/review/cards.ts';
import { replayCard, retentionFor, toSchedule, type RatingValue } from '../src/modules/review/fsrs.ts';
import { buildTestApp, fixedClock, testConfig, type TestClock } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import type { TestAccount } from './helpers/fixtures.ts';
import { createLearner, rate, seedItem } from './helpers/learning.ts';
import { deleteNote, lexiconEntry, saveNote, seedLexicon } from './helpers/notes.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;
const MASTERED_DAYS = 180;

describe('review by importance (stars)', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  async function setup(ctx: TestContext, clock: TestClock = fixedClock()) {
    const app = await buildTestApp(t.db, { clock, config: testConfig() });
    ctx.after(() => app.close());
    const account = await createLearner(t.db, { now: clock() });
    return { app, account, clock };
  }

  type QueueCard = { id: string; intervals: Record<'1' | '2' | '3' | '4', number> };
  const queue = async (app: FastifyInstance, account: TestAccount) =>
    (await app.inject({ method: 'GET', url: '/v1/review/queue', headers: account.headers })).json().data.cards as QueueCard[];
  const storedCard = async (userId: string, cardId: string) => {
    const [row] = await t.db.select().from(cards).where(and(eq(cards.userId, userId), eq(cards.id, cardId)));
    assert.ok(row);
    return row;
  };
  /** The schedule of a card replayed from its stored logs with `retention`. */
  const replayed = async (userId: string, cardId: string, retention: number) => {
    const card = await storedCard(userId, cardId);
    const logs = await t.db.select().from(reviewLogs).where(and(eq(reviewLogs.userId, userId), eq(reviewLogs.cardId, cardId)));
    return toSchedule(
      replayCard(card.createdAt, logs.map((log) => ({ id: log.id, rating: log.rating as RatingValue, reviewedAt: log.reviewedAt })), retention),
      MASTERED_DAYS,
    );
  };
  const scheduleOf = (row: Awaited<ReturnType<typeof storedCard>>) => ({
    state: row.state,
    due: row.due.getTime(),
    stability: row.stability,
    difficulty: row.difficulty,
    reps: row.reps,
    lapses: row.lapses,
    scheduledDays: row.scheduledDays,
  });
  const setImportanceReview = async (app: FastifyInstance, account: TestAccount, value: boolean) => {
    const res = await app.inject({ method: 'POST', url: '/v1/me/settings', headers: account.headers, payload: { importanceReview: value } });
    assert.equal(res.statusCode, 200, res.body);
  };

  test('new cards: by stars (desc) first, then by item weight; due reviews still come first', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const heavy = await seedItem(t.db, account.userId, { type: 'phrase', display: 'heavy unsaved', errorCount: 5 }); // weight 11, 0 ★
    const one = await seedItem(t.db, account.userId, { type: 'phrase', display: 'one star', stars: 1, lookupCount: 9 });
    const fourLight = await seedItem(t.db, account.userId, { type: 'phrase', display: 'four light', stars: 4, lookupCount: 1 });
    const fourHeavy = await seedItem(t.db, account.userId, { type: 'phrase', display: 'four heavy', stars: 4, lookupCount: 3 });
    const three = await seedItem(t.db, account.userId, { type: 'phrase', display: 'three', stars: 3 });
    const reviewed = await seedItem(t.db, account.userId, { type: 'phrase', display: 'reviewed', stars: 0 });
    await rate(app, account, clock, reviewed.cardIds[0]!, 4);
    clock.advance(40 * DAY);

    assert.deepEqual(
      (await queue(app, account)).map((card) => card.id),
      [reviewed, fourHeavy, fourLight, three, one, heavy].map((item) => item.cardIds[0]),
    );
  });

  test('queue intervals use each card’s retention; importanceReview off → 0.90 for every card', async (ctx) => {
    const { app, account } = await setup(ctx);
    const unsaved = await seedItem(t.db, account.userId, { type: 'phrase', display: 'unsaved' });
    const saved = await seedItem(t.db, account.userId, { type: 'phrase', display: 'saved four', stars: 4 });
    const easyOf = async () => new Map((await queue(app, account)).map((card) => [card.id, card.intervals['4']]));

    const byStars = await easyOf();
    const [unsavedEasy, savedEasy] = [byStars.get(unsaved.cardIds[0]!)!, byStars.get(saved.cardIds[0]!)!];
    assert.ok(savedEasy < unsavedEasy, `4 ★ (${savedEasy}) comes back sooner than 0 ★ (${unsavedEasy})`);
    assert.equal(unsavedEasy, 16 * 86_400, 'retention 0.85');

    await setImportanceReview(app, account, false);
    const flat = await easyOf();
    assert.equal(flat.get(unsaved.cardIds[0]!), 8 * 86_400, 'retention 0.90');
    assert.equal(flat.get(saved.cardIds[0]!), 8 * 86_400, 'retention 0.90');
  });

  test('a rating stores the schedule replayed with the item’s retention', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const items = await Promise.all([0, 2, 4].map((stars) => seedItem(t.db, account.userId, { type: 'phrase', display: `rated ${stars}`, stars })));
    const dues: number[] = [];
    for (const [i, stars] of [0, 2, 4].entries()) {
      const cardId = items[i]!.cardIds[0]!;
      const view = await rate(app, account, clock, cardId, 4);
      assert.deepEqual(scheduleOf(await storedCard(account.userId, cardId)).due, (await replayed(account.userId, cardId, retentionFor(stars, true))).due.getTime());
      dues.push(Date.parse(view.due) - clock().getTime());
    }
    assert.ok(dues[0]! > dues[1]! && dues[1]! > dues[2]!, `more stars, sooner: ${dues.join(' > ')}`);
  });

  test('changing a note’s stars re-derives the stored schedule from the same logs (progress kept)', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    await seedLexicon(t.db, lexiconEntry('tenacious'));
    const note = await saveNote(app, account, { kind: 'word', text: 'tenacious', stars: 1 });
    const [cardRow] = await t.db.select().from(cards).where(and(eq(cards.userId, account.userId), eq(cards.itemId, note.itemId!), eq(cards.cardType, 'recognize')));
    assert.ok(cardRow, 'the lexicon made the cards at once');
    const cardId = cardRow.id;
    await rate(app, account, clock, cardId, 3);
    clock.advance(10 * MINUTE);
    await rate(app, account, clock, cardId, 3);
    clock.advance(3 * DAY);
    await rate(app, account, clock, cardId, 3);
    const oneStar = scheduleOf(await storedCard(account.userId, cardId));
    assert.equal(oneStar.reps, 3);

    await saveNote(app, account, { kind: 'word', text: 'tenacious', stars: 4 }, note.id);
    const fourStars = scheduleOf(await storedCard(account.userId, cardId));
    assert.deepEqual(
      { state: fourStars.state, stability: fourStars.stability, difficulty: fourStars.difficulty, reps: fourStars.reps, lapses: fourStars.lapses },
      { state: oneStar.state, stability: oneStar.stability, difficulty: oneStar.difficulty, reps: oneStar.reps, lapses: oneStar.lapses },
      'progress kept',
    );
    assert.ok(fourStars.due < oneStar.due, 'retention 0.95: due sooner');
    assert.equal(fourStars.due, (await replayed(account.userId, cardId, 0.95)).due.getTime());

    assert.equal((await deleteNote(app, account, note.id)).statusCode, 200);
    const unsaved = scheduleOf(await storedCard(account.userId, cardId));
    assert.ok(unsaved.due > oneStar.due, 'retention 0.85 once no note is left');
    assert.equal(unsaved.due, (await replayed(account.userId, cardId, 0.85)).due.getTime());

    await saveNote(app, account, { kind: 'word', text: 'tenacious', stars: 1 }, note.id);
    assert.deepEqual(scheduleOf(await storedCard(account.userId, cardId)), oneStar, 'back to 1 ★: exactly the original schedule');

    // The next rating continues from the same progress with the current retention.
    clock.advance(20 * DAY);
    const next = await rate(app, account, clock, cardId, 3);
    assert.equal(Date.parse(next.due), (await replayed(account.userId, cardId, 0.9)).due.getTime());
    assert.equal((await storedCard(account.userId, cardId)).reps, 4);
  });

  test('importanceReview toggled: rescheduleAccount re-derives every rated card (0.90 off, by stars on)', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const four = await seedItem(t.db, account.userId, { type: 'phrase', display: 'toggle four', stars: 4 });
    const zero = await seedItem(t.db, account.userId, { type: 'phrase', display: 'toggle zero' });
    const untouched = await seedItem(t.db, account.userId, { type: 'phrase', display: 'toggle new', stars: 4 });
    for (const item of [four, zero]) await rate(app, account, clock, item.cardIds[0]!, 4);
    const before = await Promise.all([four, zero, untouched].map((item) => storedCard(account.userId, item.cardIds[0]!)));

    await setImportanceReview(app, account, false);
    assert.equal(await rescheduleAccount(t.db, account.userId, MASTERED_DAYS), 2, 'only rated cards are replayed');
    for (const item of [four, zero]) {
      const cardId = item.cardIds[0]!;
      assert.equal((await storedCard(account.userId, cardId)).due.getTime(), (await replayed(account.userId, cardId, 0.9)).due.getTime());
    }
    assert.deepEqual(await storedCard(account.userId, untouched.cardIds[0]!), before[2]);
    assert.notEqual((await storedCard(account.userId, four.cardIds[0]!)).due.getTime(), before[0]!.due.getTime());

    // Back on: the stars apply again.
    await t.db.update(users).set({ settings: { importanceReview: true } }).where(eq(users.id, account.userId));
    await rescheduleAccount(t.db, account.userId, MASTERED_DAYS);
    assert.deepEqual(scheduleOf(await storedCard(account.userId, four.cardIds[0]!)), scheduleOf(before[0]!));
    assert.deepEqual(scheduleOf(await storedCard(account.userId, zero.cardIds[0]!)), scheduleOf(before[1]!));
  });

  test('POST /v1/me/settings with importanceReview re-derives the stored schedules itself', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const four = await seedItem(t.db, account.userId, { type: 'phrase', display: 'route four', stars: 4 });
    await rate(app, account, clock, four.cardIds[0]!, 4);
    const cardId = four.cardIds[0]!;
    const before = await storedCard(account.userId, cardId);

    await setImportanceReview(app, account, false);
    assert.equal((await storedCard(account.userId, cardId)).due.getTime(), (await replayed(account.userId, cardId, 0.9)).due.getTime());

    await setImportanceReview(app, account, true);
    assert.deepEqual(scheduleOf(await storedCard(account.userId, cardId)), scheduleOf(before));
  });
});
