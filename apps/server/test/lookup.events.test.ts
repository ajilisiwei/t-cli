import { after, before, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { lookupEvents, users } from '../src/db/schema.ts';
import { LOOKUP_EVENT_DEDUPE_MS, recordLookupEvent } from '../src/modules/lookup/events.ts';
import type { ChatMessage } from '../src/ports.ts';
import { buildTestApp, fakeLlm, fixedClock, testConfig, type FakeLlm, type TestClock } from './helpers/app.ts';
import { captureLogs } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import type { TestAccount } from './helpers/fixtures.ts';
import { createLearner } from './helpers/learning.ts';
import { lexiconEntry, seedLexicon } from './helpers/notes.ts';
import { sourcePayload } from './helpers/pipeline.ts';

/** Answers lexicon prompts with an entry whose lemma is the lowercased text minus a plural "s" ("xyz…" → not a word). */
function wordLlm(): FakeLlm {
  return fakeLlm(['unused'], {
    json: (messages: readonly ChatMessage[]) => {
      const payload = sourcePayload(messages) as unknown as { task: string; text: string };
      if (payload.task === 'context') return JSON.stringify({ meaning: '这里的意思', phrase: null });
      if (payload.text.startsWith('xyz')) return JSON.stringify({ entry: null });
      const lemma = payload.text.toLowerCase().replace(/s$/, '');
      return JSON.stringify({ entry: lexiconEntry(lemma, { forms: [{ label: '复数', form: `${lemma}s` }] }) });
    },
  });
}

describe('lookup events (v3)', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  async function setup(ctx: TestContext, { clock = fixedClock(), config = {} }: { clock?: TestClock; config?: Record<string, string> } = {}) {
    const app = await buildTestApp(t.db, { llm: wordLlm(), clock, config: testConfig(config) });
    ctx.after(() => app.close());
    const account = await createLearner(t.db, { now: clock() });
    return { app, account, clock };
  }

  const lookup = (app: FastifyInstance, account: TestAccount, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/lookup', headers: account.headers, payload });

  const eventsOf = async (userId: string) =>
    (await t.db.select().from(lookupEvents).where(eq(lookupEvents.userId, userId)).orderBy(asc(lookupEvents.createdAt), asc(lookupEvents.id))).map(
      ({ lemmaKey, explainLang, createdAt }) => ({ lemmaKey, explainLang, createdAt: createdAt.toISOString() }),
    );

  /** Events are written in the background: wait until `count` are there (or give up and return what is). */
  async function waitForEvents(userId: string, count: number) {
    for (let i = 0; i < 200; i += 1) {
      const rows = await eventsOf(userId);
      if (rows.length >= count) return rows;
      await sleep(10);
    }
    return eventsOf(userId);
  }

  test('a 200 records one event with the lemma key of the answer, never the sentence or the record id', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const res = await lookup(app, account, { word: 'Decisions', sentence: 'We made two decisions today.' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.lemma, 'decision');

    const events = await waitForEvents(account.userId, 1);
    assert.deepEqual(events, [{ lemmaKey: 'decision', explainLang: 'zh', createdAt: clock().toISOString() }]);
    const [row] = await t.db.select().from(lookupEvents).where(eq(lookupEvents.userId, account.userId));
    assert.deepEqual(Object.keys(row ?? {}).sort(), ['createdAt', 'explainLang', 'id', 'lemmaKey', 'mergedAt', 'userId']);
    assert.equal(row?.mergedAt, null);
  });

  test('a cache hit records an event too; the explanation language is the account’s', async (ctx) => {
    const { app, account } = await setup(ctx);
    await t.db.update(users).set({ settings: { explanationLang: 'en' } }).where(eq(users.id, account.userId));
    await seedLexicon(t.db, lexiconEntry('Paris', { forms: [] }), { explainLang: 'en', key: 'paris' });

    const res = await lookup(app, account, { word: 'Paris' });
    assert.equal(res.json().data.cached, true);
    assert.deepEqual((await waitForEvents(account.userId, 1)).map(({ lemmaKey, explainLang }) => ({ lemmaKey, explainLang })), [
      { lemmaKey: 'paris', explainLang: 'en' },
    ]);
  });

  test('at most one event per account and lemma key per 10 minutes', async (ctx) => {
    const clock = fixedClock();
    const { app, account } = await setup(ctx, { clock });
    const other = await createLearner(t.db, { now: clock() });

    await lookup(app, account, { word: 'journey' });
    await waitForEvents(account.userId, 1);
    clock.advance(LOOKUP_EVENT_DEDUPE_MS - 1);
    await lookup(app, account, { word: 'journeys' }); // same lemma key, inside the window
    await lookup(app, account, { word: 'harbor' }); // another key
    await lookup(app, other, { word: 'journey' }); // another account
    await waitForEvents(account.userId, 2);
    await waitForEvents(other.userId, 1);
    clock.advance(1);
    await lookup(app, account, { word: 'journey' }); // exactly 10 minutes after the first: allowed again

    const events = await waitForEvents(account.userId, 3);
    assert.deepEqual(events.map((event) => event.lemmaKey), ['journey', 'harbor', 'journey']);
    assert.deepEqual((await eventsOf(other.userId)).map((event) => event.lemmaKey), ['journey']);
  });

  test('concurrent lookups of one word record one event', async (ctx) => {
    const { app, account } = await setup(ctx);
    const responses = await Promise.all(Array.from({ length: 5 }, () => lookup(app, account, { word: 'lantern' })));
    assert.ok(responses.every((res) => res.statusCode === 200));
    await waitForEvents(account.userId, 1);
    await sleep(100);
    assert.equal((await eventsOf(account.userId)).length, 1);
  });

  test('failed lookups record nothing', async (ctx) => {
    const { app, account } = await setup(ctx);
    assert.equal((await lookup(app, account, { word: 'xyzzy' })).statusCode, 422);
    assert.equal((await lookup(app, account, { word: '' })).statusCode, 400);
    assert.equal((await lookup(app, account, { word: 'meadow', entryId: '01JAAAAAAAAAAAAAAAAAAAAAAA' })).statusCode, 404);
    await sleep(100);
    assert.deepEqual(await eventsOf(account.userId), []);
  });

  test('recordLookupEvent reports whether it stored the event', async () => {
    const account = await createLearner(t.db, { now: new Date() });
    const now = new Date('2026-11-20T10:00:00Z');
    const input = { userId: account.userId, lemmaKey: 'orbit', explainLang: 'zh' as const, now };
    assert.equal(await recordLookupEvent(t.db, input), true);
    assert.equal(await recordLookupEvent(t.db, { ...input, now: new Date(now.getTime() + 60_000) }), false);
    assert.equal(await recordLookupEvent(t.db, { ...input, now: new Date(now.getTime() + LOOKUP_EVENT_DEDUPE_MS) }), true);
  });

  test('a failure to record is logged without user text and never changes the response', async (ctx) => {
    const { app, account } = await setup(ctx, { config: { LOG_LEVEL: 'info' } });
    const logs = captureLogs(app);
    await t.sql`alter table lookup_events rename to lookup_events_away`;
    try {
      const res = await lookup(app, account, { word: 'zzqlantern', sentence: 'zzqsentence here' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.lemma, 'zzqlantern');
      for (let i = 0; i < 200 && !logs.text().includes('recording a lookup event failed'); i += 1) await sleep(10);
    } finally {
      await t.sql`alter table lookup_events_away rename to lookup_events`;
    }
    const text = logs.text();
    assert.ok(text.includes('recording a lookup event failed'));
    assert.ok(!text.includes('zzqlantern') && !text.includes('zzqsentence'), 'no user text in the logs');
  });
});
