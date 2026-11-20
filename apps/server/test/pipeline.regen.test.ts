import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { cards, items, jobRuns, pipelineState } from '../src/db/schema.ts';
import type { AppDeps } from '../src/deps.ts';
import { AppError } from '../src/http/errors.ts';
import { createScheduler } from '../src/lib/scheduler.ts';
import { createItemRegenerator, PIPELINE_JOB, registerPipelineJobs, runPipeline } from '../src/modules/pipeline/index.ts';
import { fakeAlerter, fakeRegenerator, fakeTts, fakeWechat, fixedClock, testConfig, type FakeAlerter } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount } from './helpers/fixtures.ts';
import { cannedWord, cardsOf, itemsOf, scriptedLlm, seedRecords, type ScriptedLlm } from './helpers/pipeline.ts';

const NIGHT = new Date('2026-11-20T05:00:30+08:00');

describe('item regeneration ("内容有误") and the nightly job', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  const appDeps = (llm: ScriptedLlm, alerter: FakeAlerter = fakeAlerter(), now = NIGHT): AppDeps => ({
    config: testConfig(),
    db: t.db,
    clock: fixedClock(now),
    wechat: fakeWechat(),
    llm,
    tts: fakeTts(),
    regenerator: fakeRegenerator(),
    alerter,
  });

  /** An account with a ready word item ("meadow") whose recognize card has been reviewed and was then reported. */
  async function reportedWord() {
    const { userId } = await createAccount(t.db);
    await seedRecords(t.db, userId, [{ input: 'meadow', output: 'meadow /ˈmed.oʊ/ 草地', at: '2026-11-19T09:00:00+08:00' }]);
    await runPipeline(appDeps(scriptedLlm()), { userId });
    const [item] = await itemsOf(t.db, userId);
    assert.equal(item?.status, 'ready');
    const before = await cardsOf(t.db, userId, item.id);
    const recognize = before.find((card) => card.cardType === 'recognize');
    assert.ok(recognize);
    const fsrs = {
      state: 2,
      due: new Date('2026-12-01T08:00:00Z'),
      stability: 12.5,
      difficulty: 4.25,
      elapsedDays: 3,
      scheduledDays: 9,
      reps: 3,
      lapses: 1,
      lastReview: new Date('2026-11-19T08:00:00Z'),
    };
    await t.db.update(cards).set(fsrs).where(and(eq(cards.userId, userId), eq(cards.id, recognize.id)));
    // What the report route does before calling the regenerator.
    await t.db.update(cards).set({ suspended: true }).where(and(eq(cards.userId, userId), eq(cards.itemId, item.id)));
    await t.db.update(items).set({ status: 'needs_regen' }).where(and(eq(items.userId, userId), eq(items.id, item.id)));
    return { userId, item, before: await cardsOf(t.db, userId, item.id), recognizeId: recognize.id, fsrs };
  }

  const fsrsOf = (card: typeof cards.$inferSelect) => ({
    state: card.state,
    due: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsedDays,
    scheduledDays: card.scheduledDays,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: card.lastReview,
  });

  test('rewrites content and card faces in place, keeps ids and FSRS fields, unsuspends', async () => {
    const { userId, item, before, recognizeId, fsrs } = await reportedWord();
    const llm = scriptedLlm({
      respond: (task, payload) => {
        if (task !== 'generate') return undefined;
        const [request] = payload.items as { ref: string; headword: string }[];
        const content = cannedWord(request?.headword ?? '');
        return {
          items: [{ ref: request?.ref, content: { ...content, examples: [{ en: 'Sheep rested in the quiet meadow.', zh: '羊在安静的草地上休息。', fromUser: false }, (content.examples as unknown[])[1]] } }],
        };
      },
    });
    const alerter = fakeAlerter();
    await createItemRegenerator(appDeps(llm, alerter)).regenerate(userId, item.id);

    const [updated] = await itemsOf(t.db, userId);
    assert.equal(updated?.status, 'ready');
    assert.equal(updated?.version, (item.version ?? 1) + 1);
    assert.equal((updated?.content as { examples: { en: string }[] }).examples[0]?.en, 'Sheep rested in the quiet meadow.');

    const afterCards = await cardsOf(t.db, userId, item.id);
    assert.deepEqual(afterCards.map((card) => card.id).sort(), before.map((card) => card.id).sort(), 'same card ids');
    assert.ok(afterCards.every((card) => !card.suspended));
    const recognize = afterCards.find((card) => card.id === recognizeId);
    assert.ok(recognize);
    assert.deepEqual(fsrsOf(recognize), fsrs, 'scheduling untouched');
    const cloze = afterCards.find((card) => card.cardType === 'cloze');
    assert.deepEqual(cloze?.front, { text: 'Sheep rested in the quiet ____.', sub: '羊在安静的草地上休息。' });
    assert.deepEqual(alerter.alerts, []);
    assert.deepEqual(llm.tasks(), ['generate']);
  });

  test('a generation that stays invalid leaves the item needs_regen, the cards suspended, and alerts', async () => {
    const { userId, item, before } = await reportedWord();
    const llm = scriptedLlm({ respond: (task) => (task === 'generate' ? { items: [] } : undefined) });
    const alerter = fakeAlerter();
    await assert.rejects(createItemRegenerator(appDeps(llm, alerter)).regenerate(userId, item.id));
    assert.deepEqual(llm.tasks(), ['generate', 'generate', 'generate'], 'tried, then retried twice');
    const [stored] = await itemsOf(t.db, userId);
    assert.equal(stored?.status, 'needs_regen');
    assert.deepEqual(stored?.content, item.content, 'the old content is kept until a new one validates');
    assert.deepEqual(await cardsOf(t.db, userId, item.id), before, 'cards unchanged and still suspended');
    assert.deepEqual(alerter.alerts.map((alert) => alert.kind), ['item_needs_regen']);
    assert.ok(alerter.alerts[0]?.message.includes(item.id));
    assert.ok(!alerter.alerts[0]?.message.includes('meadow'));
  });

  test('an upstream failure also leaves needs_regen and alerts with the error class', async () => {
    const { userId, item } = await reportedWord();
    const llm = scriptedLlm({
      respond: () => {
        throw new AppError(502, 'AI_UPSTREAM', 'AI upstream timed out');
      },
    });
    const alerter = fakeAlerter();
    await assert.rejects(createItemRegenerator(appDeps(llm, alerter)).regenerate(userId, item.id));
    const [stored] = await itemsOf(t.db, userId);
    assert.equal(stored?.status, 'needs_regen');
    assert.ok((await cardsOf(t.db, userId, item.id)).every((card) => card.suspended));
    assert.match(alerter.alerts[0]?.message ?? '', /AppError:AI_UPSTREAM/);
  });

  test("another account's item is NOT_FOUND, without any model call", async () => {
    const { item } = await reportedWord();
    const other = await createAccount(t.db);
    const llm = scriptedLlm();
    await assert.rejects(
      createItemRegenerator(appDeps(llm)).regenerate(other.userId, item.id),
      (error: unknown) => error instanceof AppError && error.statusCode === 404 && error.code === 'NOT_FOUND',
    );
    assert.equal(llm.jsonCalls.length, 0);
  });

  test('the nightly job is registered for 05:00 Asia/Shanghai and runs the pipeline once per day', async () => {
    const { userId } = await createAccount(t.db);
    await seedRecords(t.db, userId, [{ input: 'lantern', output: 'lantern /ˈlæn.tɚn/ 灯笼', at: '2026-11-21T09:00:00+08:00' }]);
    const clock = fixedClock(new Date('2026-11-22T04:59:00+08:00'));
    const deps = { ...appDeps(scriptedLlm()), clock };
    const scheduler = createScheduler({ db: t.db, clock, log: { info: () => undefined, error: () => undefined }, alerter: fakeAlerter() });
    registerPipelineJobs(scheduler, deps);

    await scheduler.tick();
    const cursor = async () => (await t.db.select().from(pipelineState).where(eq(pipelineState.userId, userId)))[0]?.lastSeq ?? 0;
    assert.equal(await cursor(), 0, 'not before 05:00');

    clock.set(new Date('2026-11-22T05:00:30+08:00'));
    await scheduler.tick();
    assert.equal(await cursor(), 1);
    const [run] = await t.db.select().from(jobRuns).where(eq(jobRuns.name, PIPELINE_JOB));
    assert.deepEqual([run?.lastRunKey, run?.lastError], ['2026-11-22', null]);
    const [item] = await itemsOf(t.db, userId);
    assert.equal(item?.status, 'ready');
  });
});
