import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { cards, items, materials } from '../src/db/schema.ts';
import { createItemRegenerator, runPipeline, type PipelineDeps } from '../src/modules/pipeline/index.ts';
import type { DailyMaterial } from '../src/modules/pipeline/materials.ts';
import { buildTestApp, fakeAlerter, fakeTts, fakeWechat, fixedClock, testConfig } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createLearner } from './helpers/learning.ts';
import { saveNote } from './helpers/notes.ts';
import { cardsOf, itemsOf, scriptedLlm, seedRecords, type ScriptedLlm } from './helpers/pipeline.ts';

const DAY = '2026-11-19'; // a Thursday
const at = (time: string) => new Date(`${DAY}T${time}:00+08:00`);
const NIGHT = new Date('2026-11-20T05:00:30+08:00');

describe('notes and the nightly pipeline', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  const pipelineDeps = (llm: ScriptedLlm): PipelineDeps => ({ config: testConfig(), db: t.db, clock: fixedClock(NIGHT), llm, alerter: fakeAlerter() });

  /** An app at `now` and a learner, for saving notes during the day. */
  async function learnerAt(now: Date) {
    const app = await buildTestApp(t.db, { clock: fixedClock(now) });
    const account = await createLearner(t.db, { now });
    return { app, account };
  }

  test('the nightly run fills word and phrase items saved as notes, even without records; sentence items never go to the model', async () => {
    const { app, account } = await learnerAt(at('12:00'));
    try {
      const word = await saveNote(app, account, { kind: 'word', text: 'quixotic', stars: 2 });
      const phrase = await saveNote(app, account, { kind: 'phrase', text: 'on the fence' });
      const sentence = await saveNote(app, account, { kind: 'sentence', text: 'Better late than never.', translation: '迟做总比不做好。' });
      const llm = scriptedLlm();

      const summaries = await runPipeline(pipelineDeps(llm));
      const mine = summaries.find((summary) => summary.userId === account.userId);
      assert.ok(mine, 'an account with notes but no records is part of the nightly run');
      assert.deepEqual([mine.status, mine.entriesProcessed, mine.itemsGenerated], ['ok', 0, 2]);
      assert.deepEqual(llm.tasks(), ['generate', 'generate'], 'no extraction (no records), no daily material (no records that day)');
      assert.ok(!JSON.stringify(llm.payloads).includes('Better late'), 'the sentence never reaches the model');

      const rows = new Map((await itemsOf(t.db, account.userId)).map((item) => [item.id, item]));
      assert.deepEqual([rows.get(word.itemId!)?.status, rows.get(phrase.itemId!)?.status], ['ready', 'ready']);
      assert.equal(rows.get(word.itemId!)?.stars, 2, 'generation keeps the stars');
      assert.equal((await cardsOf(t.db, account.userId, word.itemId!)).length, 3);
      assert.equal((await cardsOf(t.db, account.userId, phrase.itemId!)).length, 1);
      assert.deepEqual((await cardsOf(t.db, account.userId, sentence.itemId!)).map((card) => card.cardType), ['recall']);

      // A sentence item marked needs_regen is still never picked for generation.
      await t.db.update(items).set({ status: 'needs_regen' }).where(and(eq(items.userId, account.userId), eq(items.id, sentence.itemId!)));
      const again = scriptedLlm();
      await runPipeline(pipelineDeps(again), { userId: account.userId });
      assert.deepEqual(again.tasks(), []);
    } finally {
      await app.close();
    }
  });

  test('"内容有误" on a sentence card rebuilds it from the note, without the model', async () => {
    const { app, account } = await learnerAt(at('12:00'));
    try {
      const sentence = await saveNote(app, account, { kind: 'sentence', text: 'Time flies.', translation: '光阴似箭。' });
      const [recall] = await cardsOf(t.db, account.userId, sentence.itemId!);
      assert.ok(recall);
      // What the report route does before calling the regenerator.
      await t.db.update(cards).set({ suspended: true }).where(and(eq(cards.userId, account.userId), eq(cards.itemId, sentence.itemId!)));
      await t.db.update(items).set({ status: 'needs_regen' }).where(and(eq(items.userId, account.userId), eq(items.id, sentence.itemId!)));

      const llm = scriptedLlm();
      const alerter = fakeAlerter();
      const regenerator = createItemRegenerator({
        config: testConfig(),
        db: t.db,
        clock: fixedClock(NIGHT),
        wechat: fakeWechat(),
        llm,
        tts: fakeTts(),
        alerter,
      });
      await regenerator.regenerate(account.userId, sentence.itemId!);
      assert.deepEqual(llm.tasks(), []);
      assert.deepEqual(alerter.alerts, []);
      const [item] = (await itemsOf(t.db, account.userId)).filter((row) => row.id === sentence.itemId);
      assert.equal(item?.status, 'ready');
      const [after] = await cardsOf(t.db, account.userId, sentence.itemId!);
      assert.deepEqual([after?.id, after?.suspended, after?.front, after?.back], [recall.id, false, { text: '光阴似箭。' }, { text: 'Time flies.' }]);
    } finally {
      await app.close();
    }
  });

  test('daily material: 4 ★ items first, then 3 ★, then the usual weighting — notes saved that day included', async () => {
    const { app, account } = await learnerAt(at('20:00'));
    try {
      const words = ['alpaca', 'badger', 'camel', 'dingo', 'eland', 'ferret', 'gecko', 'hyena', 'ibex', 'jackal', 'koala', 'lemur', 'yak', 'zebra'];
      await seedRecords(t.db, account.userId, [
        ...words.map((word, i) => ({ input: word, output: `${word} /ˈwɜːrd/ 释义`, at: `${DAY}T09:${String(i).padStart(2, '0')}:00+08:00` })),
        // `heavy` is looked up three times: the heaviest unsaved word.
        ...[0, 1, 2].map((i) => ({ input: 'heavy', output: 'heavy /ˈhevi/ 重的', at: `${DAY}T10:0${i}:00+08:00` })),
      ]);
      await saveNote(app, account, { kind: 'word', text: 'zebra', stars: 4 });
      await saveNote(app, account, { kind: 'word', text: 'yak', stars: 3 });
      await saveNote(app, account, { kind: 'word', text: 'alpaca', stars: 2 });
      // Tapped in a sentence and saved: no record of its own that day.
      await saveNote(app, account, { kind: 'word', text: 'quokka', stars: 4 });

      const summary = (await runPipeline(pipelineDeps(scriptedLlm()), { userId: account.userId }))[0];
      assert.equal(summary?.daily?.outcome, 'created');
      const [row] = await t.db
        .select()
        .from(materials)
        .where(and(eq(materials.userId, account.userId), eq(materials.kind, 'daily'), eq(materials.date, DAY)));
      const material = row?.content as unknown as DailyMaterial;
      assert.equal(material.words.length, 12);
      assert.deepEqual(
        material.words.slice(0, 4).map((word) => word.headword),
        ['zebra', 'quokka', 'yak', 'heavy'],
        '4 ★ (zebra has a lookup, quokka none), then 3 ★, then the heaviest; 2 ★ alpaca ranks by weight',
      );
      assert.ok(material.story);
      assert.deepEqual(material.story.words.slice(0, 3), ['zebra', 'quokka', 'yak'], 'the story gets the important words first');
    } finally {
      await app.close();
    }
  });
});
