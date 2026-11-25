import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import { items, lookupEvents, materials, notes, users } from '../src/db/schema.ts';
import { runPipeline, type AccountRunSummary, type PipelineDeps } from '../src/modules/pipeline/index.ts';
import { EXTEND_MAX_ATTEMPTS } from '../src/modules/pipeline/extend.ts';
import { ExtendContentSchema, type ExtendMaterial } from '../src/modules/pipeline/learnContent.ts';
import { buildTestApp, fakeAlerter, fixedClock, testConfig } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount } from './helpers/fixtures.ts';
import { createLearner, seedItem, seedLog } from './helpers/learning.ts';
import { lexiconEntry, seedLexicon } from './helpers/notes.ts';
import { cannedExtend, cardsOf, scriptedLlm, seedRecords, sourcePayload, type ScriptedLlm } from './helpers/pipeline.ts';

const MONDAY = '2026-11-23';
const at = (day: string, time = '10:00') => new Date(`${day}T${time}:00+08:00`);
const night = (day: string) => new Date(`${day}T05:00:30+08:00`);
const SECRET_SENTENCE = 'Zzq our quarterly synergy offsite was postponed again.';

describe('nightly pipeline v3: 拓展资料 (step 5)', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  const deps = (llm: ScriptedLlm, now: Date): PipelineDeps => ({ config: testConfig(), db: t.db, clock: fixedClock(now), llm, alerter: fakeAlerter() });
  const run = async (userId: string, now: Date, llm: ScriptedLlm = scriptedLlm()): Promise<AccountRunSummary> => {
    const [summary] = await runPipeline(deps(llm, now), { userId });
    assert.ok(summary);
    assert.equal(summary.status, 'ok', summary.error ?? '');
    return summary;
  };
  const setSettings = (userId: string, settings: Record<string, unknown>) => t.db.update(users).set({ settings }).where(eq(users.id, userId));
  const extendOf = async (userId: string, date = MONDAY) =>
    (await t.db.select().from(materials).where(and(eq(materials.userId, userId), eq(materials.kind, 'extend'), eq(materials.date, date))))[0];
  const extendCalls = (llm: ScriptedLlm) => llm.payloads.filter((payload) => payload.task === 'extend');

  /** An active account with lookups, records, a forgotten unit, a starred unit and a grammar point. */
  async function signalAccount(): Promise<string> {
    const { userId } = await createAccount(t.db);
    for (const [key, day] of [['deadline', '2026-11-20'], ['deadline', '2026-11-21'], ['agenda', '2026-11-21'], ['ancient', '2026-10-01']] as const) {
      await t.db.insert(lookupEvents).values({ userId, id: ulid(), lemmaKey: key, explainLang: 'zh', createdAt: at(day), mergedAt: at(day) });
    }
    await seedRecords(t.db, userId, [
      { input: 'invoice', output: 'invoice /ˈɪn.vɔɪs/ 发票', at: '2026-11-21T09:00:00+08:00' },
      { input: SECRET_SENTENCE, output: '我们的季度团建又推迟了。', at: '2026-11-21T09:30:00+08:00' },
    ]);
    const forgotten = await seedItem(t.db, userId, { type: 'word', display: 'postpone', createdAt: at('2026-10-01') });
    await seedLog(t.db, userId, { cardId: forgotten.cardIds[0]!, rating: 1, reviewedAt: at('2026-11-19') });
    await seedLog(t.db, userId, { cardId: forgotten.cardIds[0]!, rating: 1, reviewedAt: at('2026-11-20') });
    await seedItem(t.db, userId, { type: 'word', display: 'negotiate', stars: 4, createdAt: at('2026-10-01') });
    await seedItem(t.db, userId, { type: 'grammar', display: '冠词', errorCount: 4, createdAt: at('2026-10-01') });
    await t.db.insert(notes).values({ userId, id: ulid(), kind: 'sentence', text: SECRET_SENTENCE, lang: 'en', stars: 3, seq: 1, createdAt: at('2026-11-21'), updatedAt: at('2026-11-21') });
    await seedItem(t.db, userId, { type: 'phrase', display: SECRET_SENTENCE, stars: 3, createdAt: at('2026-10-01'), withCards: false });
    await t.db.update(items).set({ type: 'sentence' }).where(and(eq(items.userId, userId), eq(items.display, SECRET_SENTENCE)));
    return userId;
  }

  test('a Monday run stores a valid extension from the account’s signals; reasons and level come from the server', async () => {
    const userId = await signalAccount();
    const llm = scriptedLlm();
    const summary = await run(userId, night(MONDAY), llm);
    assert.deepEqual(summary.extend, { date: MONDAY, outcome: 'created' });

    const [call] = extendCalls(llm);
    assert.ok(call);
    assert.deepEqual(call.lemmas, [
      { text: 'deadline', count: 2 },
      { text: 'agenda', count: 1 },
      { text: 'invoice', count: 1 },
    ]);
    assert.deepEqual(call.grammar, [{ title: '冠词', errors: 4 }]);
    assert.deepEqual(call.forgotten, [{ text: 'postpone', lapses: 2 }]);
    assert.deepEqual(call.starred, ['negotiate'], 'sentence units are never sent');
    assert.equal(call.level, 'B1');
    assert.deepEqual(call.mutedTopics, []);

    const request = llm.jsonCalls.find((entry) => sourcePayload(entry.messages).task === 'extend');
    const userMessage = request?.messages.find((message) => message.role === 'user')?.content ?? '';
    assert.ok(!JSON.stringify(request?.messages).includes('Zzq'), 'no user sentence reaches the prompt');
    assert.ok(userMessage.includes('<source>') && !userMessage.includes('Choose ONE direction'), 'instructions live in the system prompt only');

    const row = await extendOf(userId);
    const material = row?.content as unknown as ExtendMaterial;
    assert.equal(ExtendContentSchema.safeParse(material).success, true);
    assert.equal(material.level, 'B1');
    assert.deepEqual(material.evidence, ['deadline', 'agenda', 'invoice']);
    assert.deepEqual(material.reasons, ['最近 14 天你查了 deadline、agenda 等 3 个职场用词', '难度先定在 B1，复习多了会自动调整']);
  });

  test('evidence outside the given lemmas is dropped; too little → one retry, then no extension that week', async () => {
    const userId = await signalAccount();
    let calls = 0;
    const llm = scriptedLlm({
      respond: (task, payload) => {
        if (task !== 'extend') return undefined;
        calls += 1;
        return { ...cannedExtend(payload), evidence: calls === 1 ? ['deadline', 'blockchain'] : ['deadline', 'synergy', 'Agenda'] };
      },
    });
    const summary = await run(userId, night(MONDAY), llm);
    assert.deepEqual(summary.extend, { date: MONDAY, outcome: 'created' });
    assert.equal(extendCalls(llm).length, 2);
    assert.deepEqual(summary.rejected, { 'extend:evidence': 1 });
    assert.deepEqual((await extendOf(userId))?.content.evidence, ['deadline', 'agenda']);

    const other = await signalAccount();
    const never = scriptedLlm({ respond: (task, payload) => (task === 'extend' ? { ...cannedExtend(payload), evidence: ['blockchain', 'synergy'] } : undefined) });
    const failed = await run(other, night(MONDAY), never);
    assert.deepEqual(failed.extend, { date: MONDAY, outcome: 'invalid' });
    assert.equal(extendCalls(never).length, EXTEND_MAX_ATTEMPTS);
    assert.equal(await extendOf(other), undefined);
    const tuesday = await run(other, night('2026-11-24'), never);
    assert.equal(tuesday.extend, null, 'not retried later in the week');
  });

  test('a muted topic is refused; the prompt lists muted and chosen topics', async () => {
    const userId = await signalAccount();
    await setSettings(userId, { extendTopics: ['work', 'tech'], extendMuted: [{ topic: 'work', until: '2026-12-01' }, { topic: 'travel', until: MONDAY }] });
    const llm = scriptedLlm();
    const summary = await run(userId, night(MONDAY), llm);
    assert.deepEqual(summary.extend, { date: MONDAY, outcome: 'created' });
    const [call] = extendCalls(llm);
    assert.deepEqual(call?.chosenTopics, ['work', 'tech']);
    assert.deepEqual(call?.mutedTopics, ['work'], 'an entry whose until is today has expired');
    assert.equal((await extendOf(userId))?.content.topic, 'tech');

    const stubborn = await signalAccount();
    await setSettings(stubborn, { extendMuted: [{ topic: 'work', until: '2026-12-01' }] });
    const insists = scriptedLlm({ respond: (task, payload) => (task === 'extend' ? { ...cannedExtend(payload), topic: 'work' } : undefined) });
    assert.deepEqual((await run(stubborn, night(MONDAY), insists)).extend, { date: MONDAY, outcome: 'invalid' });
  });

  test('only on Mondays, only when enabled and active, only with signals; never twice', async () => {
    const userId = await signalAccount();
    const sunday = await run(userId, night('2026-11-22'));
    assert.equal(sunday.extend, null);
    await run(userId, night(MONDAY));
    const again = await run(userId, night(MONDAY));
    assert.deepEqual(again.extend, { date: MONDAY, outcome: 'exists' });

    const disabled = await signalAccount();
    await setSettings(disabled, { extendEnabled: false });
    assert.equal((await run(disabled, night(MONDAY))).extend, null);

    const inactive = await createAccount(t.db);
    await seedRecords(t.db, inactive.userId, [
      { input: 'harbor', output: 'harbor /ˈhɑːr.bɚ/ 港口', at: '2026-10-01T09:00:00+08:00' },
      { input: 'lantern', output: 'lantern /ˈlæn.tɚn/ 灯笼', at: '2026-10-01T09:01:00+08:00' },
    ]);
    const inactiveLlm = scriptedLlm();
    const quiet = await run(inactive.userId, night(MONDAY), inactiveLlm);
    assert.equal(quiet.active, false);
    assert.equal(quiet.extend, null);
    assert.deepEqual(extendCalls(inactiveLlm), []);

    const thin = await createAccount(t.db);
    await seedRecords(t.db, thin.userId, [{ input: 'harbor', output: 'harbor /ˈhɑːr.bɚ/ 港口', at: '2026-11-22T09:00:00+08:00' }]);
    const thinLlm = scriptedLlm();
    assert.deepEqual((await run(thin.userId, night(MONDAY), thinLlm)).extend, { date: MONDAY, outcome: 'no_signals' });
    assert.deepEqual(extendCalls(thinLlm), [], 'one lemma is not enough to call the model');
  });

  test('English explanations: English reasons; the extension feeds adoption (lexicon word ready at once)', async () => {
    const userId = await signalAccount();
    await setSettings(userId, { explanationLang: 'en', studyLevel: 'B2' });
    const llm = scriptedLlm({
      respond: (task, payload) =>
        task === 'extend'
          ? {
              ...cannedExtend(payload),
              title: 'Words for busy weeks',
              items: (cannedExtend(payload).items as { text: string }[]).map((item) => ({ ...item, gloss: `what ${item.text} means` })),
            }
          : undefined,
    });
    await run(userId, night(MONDAY), llm);
    const material = (await extendOf(userId))?.content as unknown as ExtendMaterial;
    assert.equal(material.level, 'B2');
    assert.deepEqual(material.reasons, ['In the last 14 days you looked up deadline, agenda and 1 more work words', 'The level is B2, as you set it']);

    const app: FastifyInstance = await buildTestApp(t.db, { clock: fixedClock(at(MONDAY, '12:00')) });
    try {
      const account = await createLearner(t.db, { now: at(MONDAY) });
      await seedLexicon(t.db, lexiconEntry('deadline', { forms: [], examples: [
        { text: 'The deadline is Friday.', gloss: 'when it is due' },
        { text: 'We met the deadline.', gloss: 'we finished in time' },
      ] }), { explainLang: 'en' });
      await t.db.update(users).set({ settings: { explanationLang: 'en' } }).where(eq(users.id, account.userId));
      await t.db.insert(materials).values({ userId: account.userId, kind: 'extend', date: MONDAY, content: { ...material } });
      const res = await app.inject({ method: 'POST', url: `/v1/materials/extend/${MONDAY}/adopt`, headers: account.headers, payload: { indexes: [0, 2] } });
      assert.deepEqual(res.json().data, { added: [0, 2], known: [] });
      const [deadline] = await t.db
        .select()
        .from(items)
        .where(and(eq(items.userId, account.userId), eq(items.normKey, 'deadline')));
      assert.equal(deadline?.status, 'ready');
      assert.equal((await cardsOf(t.db, account.userId, deadline!.id)).length, 3);
    } finally {
      await app.close();
    }
  });
});
