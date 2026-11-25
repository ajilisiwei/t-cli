import { after, before, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ulid } from '@t-cli/core/ulid';
import { insertEntries } from '../src/db/entriesRepo.ts';
import { aiUsage, lexicon, users } from '../src/db/schema.ts';
import { AppError } from '../src/http/errors.ts';
import type { LexiconEntry } from '../src/modules/lookup/lexicon.ts';
import { CONTEXT_MAX_TOKENS, LEXICON_MAX_TOKENS } from '../src/modules/lookup/service.ts';
import type { ChatMessage, LlmClient } from '../src/ports.ts';
import { buildTestApp, fakeLlm, fixedClock, testConfig, type FakeLlm, type TestClock } from './helpers/app.ts';
import { captureLogs } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { makeEntry, type TestAccount } from './helpers/fixtures.ts';
import { createLearner } from './helpers/learning.ts';
import { sourcePayload } from './helpers/pipeline.ts';

// ------------------------------------------------------------------ fake model

type Form = LexiconEntry['forms'][number];

/** A contract-valid entry; forms default to the plural. */
function cannedEntry(lemma: string, forms: Form[] = [{ label: '复数', form: `${lemma}s` }]): LexiconEntry {
  return {
    lemma,
    ipa: { us: '/ˈfeɪk/', uk: '/ˈfeɪk/' },
    senses: [{ pos: 'n.', gloss: `${lemma} 的释义`, def: `A definition of ${lemma}.` }],
    forms,
    collocations: [{ text: `a big ${lemma}`, gloss: '一个大的' }],
    examples: [
      { text: `The ${lemma} was hard.`, gloss: '它很难。' },
      { text: `We need a ${lemma} now.`, gloss: '我们现在需要它。' },
    ],
    contrasts: [{ word: 'thing', note: '更口语' }],
    memory: '',
  };
}

interface Payload {
  task: 'lexicon' | 'context';
  text: string;
  sentence?: string;
}

interface Script {
  /** The lemma for a tapped text; null → not a word. Default: the text, lowercased. */
  lemma?: (text: string) => string | null;
  /** Forms of an entry (default: its plural). */
  forms?: (lemma: string) => Form[];
  /** The context answer (default: a meaning, no phrase). */
  context?: (payload: Payload) => unknown;
  /** Replace an answer: a string is sent verbatim; undefined keeps the canned one. */
  raw?: (payload: Payload, call: number) => string | undefined;
}

interface LookupLlm extends FakeLlm {
  payloads: Payload[];
  tasks(): string[];
}

/** Answers the lookup prompts by their <source> payload's task (each answer reports 100 + 50 tokens). */
function lookupLlm(script: Script = {}): LookupLlm {
  const payloads: Payload[] = [];
  const llm = fakeLlm(['unused'], {
    json: (messages: readonly ChatMessage[]) => {
      const payload = sourcePayload(messages) as unknown as Payload;
      payloads.push(payload);
      const raw = script.raw?.(payload, payloads.length);
      if (raw !== undefined) return raw;
      if (payload.task === 'context') return JSON.stringify(script.context?.(payload) ?? { meaning: '这里的意思', phrase: null });
      const lemma = script.lemma ? script.lemma(payload.text) : payload.text.toLowerCase();
      return JSON.stringify({ entry: lemma === null ? null : cannedEntry(lemma, script.forms?.(lemma)) });
    },
  });
  return Object.assign(llm, { payloads, tasks: () => payloads.map((payload) => payload.task) });
}

// ------------------------------------------------------------------ tests

describe('lookup: POST /v1/lookup', { skip: skipWithoutDb }, () => {
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
    llm: LlmClient;
    clock: TestClock;
  }

  async function setup(
    ctx: TestContext,
    { llm = lookupLlm(), config = {}, clock = fixedClock() }: { llm?: LlmClient; config?: Record<string, string>; clock?: TestClock } = {},
  ): Promise<Setup> {
    const app = await buildTestApp(t.db, { llm, clock, config: testConfig(config) });
    ctx.after(() => app.close());
    const account = await createLearner(t.db, { now: clock() });
    return { app, account, llm, clock };
  }

  const lookup = (app: FastifyInstance, account: TestAccount | null, payload?: unknown) =>
    app.inject({
      method: 'POST',
      url: '/v1/lookup',
      headers: account?.headers ?? {},
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  const usageOf = async (userId: string) =>
    (await t.db.select().from(aiUsage).where(eq(aiUsage.userId, userId))).map(({ day, requests, tokens }) => ({ day, requests, tokens }));

  const rowOf = async (lemma: string, explainLang = 'zh') =>
    (await t.db.select().from(lexicon).where(and(eq(lexicon.lemma, lemma), eq(lexicon.explainLang, explainLang))))[0];

  const DAY = '2026-11-17';

  test('a miss generates the entry, stores it under its lemma and counts one request', async (ctx) => {
    const llm = lookupLlm({ lemma: (text) => (text === 'Decisions' ? 'decision' : text) });
    const { app, account } = await setup(ctx, { llm });

    const res = await lookup(app, account, { word: '  Decisions ' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      success: true,
      data: { lemma: 'decision', lang: 'en', entry: cannedEntry('decision'), context: null, cached: false },
      error: null,
    });
    assert.deepEqual(llm.payloads, [{ task: 'lexicon', text: 'Decisions' }]);
    assert.equal(llm.jsonCalls[0]?.maxTokens, LEXICON_MAX_TOKENS);

    const row = await rowOf('decision');
    assert.ok(row);
    assert.deepEqual(Object.keys(row).sort(), ['content', 'createdAt', 'explainLang', 'hits', 'lang', 'lemma', 'model', 'version'], 'no user column');
    assert.deepEqual(
      { lang: row.lang, explainLang: row.explainLang, version: row.version, hits: row.hits, model: row.model, content: row.content },
      { lang: 'en', explainLang: 'zh', version: 1, hits: 0, model: testConfig().DEEPSEEK_MODEL, content: cannedEntry('decision') },
    );
    assert.deepEqual(await usageOf(account.userId), [{ day: DAY, requests: 1, tokens: 150 }]);
  });

  test('a hit calls no model and counts nothing; an inflected form finds its lemma', async (ctx) => {
    const llm = lookupLlm();
    const { app, account } = await setup(ctx, { llm });
    assert.equal((await lookup(app, account, { word: 'journey' })).json().data.cached, false);

    for (const word of ['journeys', 'Journey', 'journey']) {
      const res = await lookup(app, account, { word });
      assert.equal(res.statusCode, 200, word);
      assert.deepEqual(res.json().data, { lemma: 'journey', lang: 'en', entry: cannedEntry('journey'), context: null, cached: true }, word);
    }
    assert.equal(llm.jsonCalls.length, 1);
    assert.equal((await rowOf('journey'))?.hits, 3);
    assert.deepEqual(await usageOf(account.userId), [{ day: DAY, requests: 1, tokens: 150 }]);
  });

  test('a key derived by the rules counts only when the entry lists the text as an inflection', async (ctx) => {
    const llm = lookupLlm({
      forms: (lemma) =>
        lemma === 'teach'
          ? [
              { label: '第三人称单数', form: 'teaches' },
              { label: '名词', form: 'teacher' },
            ]
          : [{ label: '比较级', form: `${lemma}er` }],
    });
    const { app, account } = await setup(ctx, { llm });
    await lookup(app, account, { word: 'teach' });
    await lookup(app, account, { word: 'new' });

    assert.equal((await lookup(app, account, { word: 'teaches' })).json().data.lemma, 'teach');
    const teacher = (await lookup(app, account, { word: 'teacher' })).json().data;
    const news = (await lookup(app, account, { word: 'news' })).json().data;
    assert.deepEqual([teacher.lemma, teacher.cached, news.lemma, news.cached], ['teacher', false, 'news', false]);
    assert.deepEqual(llm.payloads.map((payload) => payload.text), ['teach', 'new', 'teacher', 'news']);
  });

  test('a sentence adds the context: generated per request, never cached, counted', async (ctx) => {
    const sentence = 'We must meet tight deadlines every week.';
    const llm = lookupLlm({
      lemma: (text) => (text === 'deadlines' ? 'deadline' : text),
      context: ({ sentence: s }) => ({ meaning: '截止日期（这里指工作期限）', phrase: { text: s === sentence ? 'meet tight deadlines' : 'meet a deadline', gloss: '赶上紧迫的期限' } }),
    });
    const { app, account } = await setup(ctx, { llm });
    const entryId = makeEntry({ input: sentence, output: '我们每周都要赶紧迫的期限。' });
    await insertEntries(t.db, account.userId, [entryId]);

    const miss = await lookup(app, account, { word: 'deadlines', sentence, entryId: entryId.id });
    assert.equal(miss.statusCode, 200);
    assert.deepEqual(miss.json().data, {
      lemma: 'deadline',
      lang: 'en',
      entry: cannedEntry('deadline'),
      context: { meaning: '截止日期（这里指工作期限）', phrase: { text: 'meet tight deadlines', gloss: '赶上紧迫的期限' } },
      cached: false,
    });
    assert.deepEqual(llm.tasks(), ['lexicon', 'context']);
    assert.deepEqual(
      llm.jsonCalls.map(({ maxTokens, thinking }) => ({ maxTokens, thinking })),
      [
        { maxTokens: LEXICON_MAX_TOKENS, thinking: false },
        { maxTokens: CONTEXT_MAX_TOKENS, thinking: false },
      ],
      'both calls answer without reasoning',
    );
    assert.deepEqual(llm.payloads.find((payload) => payload.task === 'lexicon'), { task: 'lexicon', text: 'deadlines' }, 'the lexicon prompt has no sentence');
    assert.ok(!JSON.stringify(await rowOf('deadline')).includes('tight'), 'the sentence is not stored');

    const hit = await lookup(app, account, { word: 'deadlines', sentence });
    assert.equal(hit.json().data.cached, true);
    assert.equal(hit.json().data.context.phrase.text, 'meet tight deadlines');
    assert.deepEqual(llm.tasks().slice(2), ['context'], 'a hit with a sentence asks for the context only');

    const elsewhere = await lookup(app, account, { word: 'deadlines', sentence: 'Deadlines come fast.' });
    assert.deepEqual(elsewhere.json().data.context, { meaning: '截止日期（这里指工作期限）', phrase: null }, 'a phrase not in the sentence is dropped');
    assert.deepEqual(await usageOf(account.userId), [{ day: DAY, requests: 3, tokens: 600 }]);
  });

  test('requires a valid access token', async (ctx) => {
    const { app } = await setup(ctx);
    const res = await lookup(app, null, { word: 'hello' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'UNAUTHORIZED');
  });

  test('invalid bodies → 400 VALIDATION_FAILED without echoing values, before any other check', async (ctx) => {
    const llm = lookupLlm();
    const { app, account } = await setup(ctx, { llm, config: { LOOKUP_ENABLED: '0' } });
    const secret = 'zzsecretzz';
    const bodies: unknown[] = [
      undefined,
      {},
      { word: '' },
      { word: '   ' },
      { word: `${secret}${'a'.repeat(60)}` },
      { word: '决定' },
      { word: '1234' },
      { word: 'ok', sentence: `${secret} ${'x'.repeat(2000)}` },
      { word: 'ok', entryId: secret },
      { word: 'ok', lang: secret },
      { word: 42 },
    ];
    for (const body of bodies) {
      const res = await lookup(app, account, body);
      assert.equal(res.statusCode, 400, JSON.stringify(body)?.slice(0, 40));
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
      assert.ok(!res.body.includes(secret));
    }
    assert.equal(llm.jsonCalls.length, 0);
  });

  test('LOOKUP_ENABLED=0 → 503 LOOKUP_DISABLED (after auth and validation), no model, no quota', async (ctx) => {
    const llm = lookupLlm();
    const { app, account } = await setup(ctx, { llm, config: { LOOKUP_ENABLED: '0' } });
    assert.equal((await lookup(app, null, { word: 'hello' })).statusCode, 401);
    const res = await lookup(app, account, { word: 'hello', sentence: 'hello there', entryId: ulid() });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'LOOKUP_DISABLED');
    assert.equal(llm.jsonCalls.length, 0);
    assert.deepEqual(await usageOf(account.userId), []);
  });

  test('per-minute limit → 429 RATE_LIMITED with Retry-After (before the entryId check); the next minute is allowed', async (ctx) => {
    const { app, account, clock } = await setup(ctx, { config: { LOOKUP_REQUESTS_PER_MINUTE: '2' } });
    assert.equal((await lookup(app, account, { word: 'meadow' })).statusCode, 200);
    clock.advance(10_000);
    assert.equal((await lookup(app, account, { word: 'meadow' })).statusCode, 200);

    const limited = await lookup(app, account, { word: 'meadow', entryId: ulid() });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
    assert.equal(limited.headers['retry-after'], '50');
    assert.deepEqual(limited.json().error.details, { retryAfterSeconds: 50 });

    clock.advance(50_000);
    assert.equal((await lookup(app, account, { word: 'meadow' })).statusCode, 200);
  });

  test('entryId: the caller’s record → 200; unknown or another account’s → 404 before quota or model', async (ctx) => {
    const llm = lookupLlm();
    const { app, account, clock } = await setup(ctx, { llm });
    const other = await createLearner(t.db, { now: clock() });
    const entry = makeEntry({ input: 'The harbor was quiet.', output: '港口很安静。' });
    await insertEntries(t.db, account.userId, [entry]);

    for (const [who, entryId] of [[other, entry.id], [account, ulid()]] as const) {
      const res = await lookup(app, who, { word: 'harbor', sentence: 'The harbor was quiet.', entryId });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error.code, 'NOT_FOUND');
    }
    assert.equal(llm.jsonCalls.length, 0);
    assert.deepEqual(await usageOf(other.userId), []);
    assert.equal((await lookup(app, account, { word: 'harbor', entryId: entry.id })).statusCode, 200);
  });

  test('NOT_A_WORD: 422, nothing cached, the request counted', async (ctx) => {
    const llm = lookupLlm({ lemma: () => null });
    const { app, account } = await setup(ctx, { llm });
    for (const body of [{ word: 'qwzxv' }, { word: 'qwzxv', sentence: 'He typed qwzxv by mistake.' }]) {
      const res = await lookup(app, account, body);
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().error.code, 'NOT_A_WORD');
    }
    assert.equal(await rowOf('qwzxv'), undefined);
    assert.equal((await usageOf(account.userId))[0]?.requests, 2);
  });

  test('daily quota: a miss or a sentence is refused with 429 QUOTA_EXCEEDED; a plain hit is still served', async (ctx) => {
    const llm = lookupLlm();
    const { app, account } = await setup(ctx, { llm, config: { AI_REQUESTS_PER_DAY: '1' } });
    assert.equal((await lookup(app, account, { word: 'lantern' })).statusCode, 200);

    for (const body of [{ word: 'compass' }, { word: 'lantern', sentence: 'A lantern glowed.' }]) {
      const res = await lookup(app, account, body);
      assert.equal(res.statusCode, 429);
      assert.deepEqual(res.json().error, { code: 'QUOTA_EXCEEDED', message: 'daily AI quota exhausted', details: { limit: 1, kind: 'requests' } });
    }
    assert.equal((await lookup(app, account, { word: 'lanterns' })).json().data.cached, true);
    assert.equal(llm.jsonCalls.length, 1);
    assert.deepEqual(await usageOf(account.userId), [{ day: DAY, requests: 1, tokens: 150 }]);
  });

  test('token budget reached → 429 QUOTA_EXCEEDED kind tokens', async (ctx) => {
    const { app, account } = await setup(ctx, { config: { AI_TOKENS_PER_DAY: '100' } });
    assert.equal((await lookup(app, account, { word: 'pebble' })).statusCode, 200);
    const res = await lookup(app, account, { word: 'boulder' });
    assert.equal(res.statusCode, 429);
    assert.deepEqual(res.json().error.details, { limit: 100, kind: 'tokens' });
  });

  test('no model configured → 503 AI_UNAVAILABLE, not counted; an exhausted quota is reported first; hits still work', async (ctx) => {
    const llm: LlmClient = { ...lookupLlm(), isAvailable: () => false };
    const { app, account } = await setup(ctx, { llm, config: { AI_REQUESTS_PER_DAY: '3' } });
    await t.db.insert(lexicon).values({ lang: 'en', explainLang: 'zh', lemma: 'orchard', version: 1, content: cannedEntry('orchard'), model: 'seed' });

    const res = await lookup(app, account, { word: 'vineyard' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'AI_UNAVAILABLE');
    assert.deepEqual(await usageOf(account.userId), []);
    assert.equal((await lookup(app, account, { word: 'orchards' })).json().data.lemma, 'orchard');

    await t.db.insert(aiUsage).values({ userId: account.userId, day: DAY, requests: 3 });
    const exhausted = await lookup(app, account, { word: 'vineyard' });
    assert.equal(exhausted.statusCode, 429);
    assert.equal(exhausted.json().error.code, 'QUOTA_EXCEEDED');
  });

  test('an invalid answer is asked once more; still invalid → 502 AI_UPSTREAM and nothing cached', async (ctx) => {
    const once = lookupLlm({ raw: (_payload, call) => (call === 1 ? '{"entry": {"lemma": "glacier"}}' : undefined) });
    const first = await setup(ctx, { llm: once });
    const ok = await lookup(first.app, first.account, { word: 'glacier' });
    assert.equal(ok.statusCode, 200);
    assert.equal(once.jsonCalls.length, 2);
    assert.deepEqual(await usageOf(first.account.userId), [{ day: DAY, requests: 1, tokens: 300 }], 'both calls cost tokens');

    const never = lookupLlm({ raw: () => 'not json at all' });
    const second = await setup(ctx, { llm: never });
    const failed = await lookup(second.app, second.account, { word: 'tundra' });
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.json().error.code, 'AI_UPSTREAM');
    assert.equal(never.jsonCalls.length, 2);
    assert.equal(await rowOf('tundra'), undefined);
  });

  test('upstream errors and the deadline → 502 AI_UPSTREAM', async (ctx) => {
    const broken: LlmClient = {
      ...lookupLlm(),
      completeJson: async () => {
        throw new AppError(502, 'AI_UPSTREAM', 'AI upstream returned HTTP 500');
      },
    };
    const a = await setup(ctx, { llm: broken });
    assert.equal((await lookup(a.app, a.account, { word: 'canyon' })).json().error.code, 'AI_UPSTREAM');

    const hanging: LlmClient = {
      ...lookupLlm(),
      completeJson: (_messages, { signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    };
    const b = await setup(ctx, { llm: hanging, config: { LOOKUP_TIMEOUT_MS: '1000' } });
    const startedAt = Date.now();
    const res = await lookup(b.app, b.account, { word: 'canyon', sentence: 'The canyon was deep.' });
    assert.equal(res.statusCode, 502);
    assert.deepEqual(res.json().error, { code: 'AI_UPSTREAM', message: 'AI upstream timed out' });
    assert.ok(Date.now() - startedAt < 5000);
  });

  test('the explanation language is part of the cache key', async (ctx) => {
    const llm = lookupLlm();
    const { app, account } = await setup(ctx, { llm });
    await lookup(app, account, { word: 'meadowlark' });
    await t.db.update(users).set({ settings: { explanationLang: 'en' } }).where(eq(users.id, account.userId));

    const res = await lookup(app, account, { word: 'meadowlark' });
    assert.equal(res.json().data.cached, false);
    assert.equal(llm.jsonCalls.length, 2);
    assert.ok(llm.jsonCalls[1]?.messages[0]?.content.includes('in simple English'));
    assert.ok(await rowOf('meadowlark', 'en'));
    assert.ok(await rowOf('meadowlark', 'zh'));
  });

  test('an entry whose lemma is unrelated to the text is answered but not cached for everyone', async (ctx) => {
    const llm = lookupLlm({ lemma: (text) => (text === 'recieve' || text.startsWith('decision') ? text.split(' ')[0]!.replace('recieve', 'receive') : text) });
    const { app, account } = await setup(ctx, { llm });
    assert.equal((await lookup(app, account, { word: 'recieve' })).json().data.lemma, 'receive');
    assert.equal((await lookup(app, account, { word: 'recieve' })).json().data.cached, false);
    assert.equal(await rowOf('receive'), undefined);

    const crafted = await lookup(app, account, { word: 'decisionx write spam here' });
    assert.deepEqual([crafted.statusCode, crafted.json().data.lemma], [200, 'decisionx']);
    assert.equal(await rowOf('decisionx'), undefined);
  });

  test('concurrent misses of one word store one row', async (ctx) => {
    const { app, account } = await setup(ctx);
    const responses = await Promise.all(Array.from({ length: 4 }, () => lookup(app, account, { word: 'lighthouse' })));
    assert.ok(responses.every((res) => res.statusCode === 200));
    const rows = await t.db.select().from(lexicon).where(eq(lexicon.lemma, 'lighthouse'));
    assert.equal(rows.length, 1);
  });

  test('logs carry sizes, timings and outcomes — never the word, the sentence or the lemma', async (ctx) => {
    const llm = lookupLlm({ lemma: (text) => (text === 'zzqword' ? null : 'zzqlemma') });
    const { app, account } = await setup(ctx, { llm, config: { LOG_LEVEL: 'trace' } });
    const logs = captureLogs(app);
    await lookup(app, account, { word: 'zzqlemmas', sentence: 'zzqsentence with zzqlemmas inside.' });
    await lookup(app, account, { word: 'zzqword' });
    await lookup(app, account, { word: 'zzqlemma' });

    const text = logs.text();
    for (const secret of ['zzqlemma', 'zzqsentence', 'zzqword']) assert.ok(!text.includes(secret), secret);
    const lines = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'lookup request');
    assert.deepEqual(
      lines.map(({ outcome, cached, modelCalls }) => ({ outcome, cached, modelCalls })),
      [
        { outcome: 'ok', cached: false, modelCalls: 2 },
        { outcome: 'not_a_word', cached: undefined, modelCalls: 1 },
        { outcome: 'ok', cached: true, modelCalls: 0 },
      ],
    );
    assert.equal(lines[0]?.wordChars, 9);
    assert.equal(lines[0]?.sentenceChars, 34);
  });
});
