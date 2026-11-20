import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import { insertEntries } from '../src/db/entriesRepo.ts';
import { aiUsage, devices, identities, invites, users } from '../src/db/schema.ts';
import { buildTestApp, fakeWechat, fixedClock, testConfig, type TestClock } from './helpers/app.ts';
import { bearer, captureLogs, createInvite, nextIp, nextWechatCode, type TokenPairBody } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { makeEntry, type TestAccount } from './helpers/fixtures.ts';
import { createLearner, dailyMaterial, rate, seedGrant, seedItem, seedMaterial, seedSource } from './helpers/learning.ts';

const HOUR = 3_600_000;
const TEMPLATE = 'tmpl-review-reminder';

describe('account: settings, export, delete', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let clock: TestClock;
  const codes: Record<string, string> = {};

  before(async () => {
    t = await createTestDatabase();
    clock = fixedClock();
    app = await buildTestApp(t.db, {
      clock,
      wechat: fakeWechat(codes),
      config: testConfig({ WECHAT_REMINDER_TEMPLATE_ID: TEMPLATE, WECHAT_REMINDER_DATA: '{"thing1":"{due} 张卡片待复习"}' }),
    });
  });
  after(async () => {
    await app?.close();
    await t?.drop();
  });

  const post = (account: { headers: Record<string, string> } | null, url: string, payload?: unknown) =>
    app.inject({ method: 'POST', url, headers: account?.headers ?? {}, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  describe('settings (M3–M5 keys)', () => {
    test('autoSpeakWord, autoSpeakOnFlip and reminderHour merge and show in /v1/me', async () => {
      const account = await createLearner(t.db, { now: clock() });
      const res = await post(account, '/v1/me/settings', { autoSpeakWord: false, reminderHour: 20 });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().data.settings, { autoSpeakWord: false, reminderHour: 20 });
      const next = await post(account, '/v1/me/settings', { autoSpeakOnFlip: true, explanationLang: 'en', reminderHour: null });
      assert.deepEqual(next.json().data.settings, { explanationLang: 'en', autoSpeakWord: false, autoSpeakOnFlip: true, reminderHour: null });
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: account.headers });
      assert.deepEqual(me.json().data.settings, { explanationLang: 'en', autoSpeakWord: false, autoSpeakOnFlip: true, reminderHour: null });
    });

    test('bad values are 400 and change nothing; invalid stored values stay hidden', async () => {
      const account = await createLearner(t.db, { now: clock() });
      await post(account, '/v1/me/settings', { reminderHour: 7 });
      for (const payload of [{ reminderHour: 24 }, { reminderHour: -1 }, { reminderHour: 7.5 }, { reminderHour: '7' }, { autoSpeakWord: 'yes' }, { autoSpeakOnFlip: null }]) {
        const res = await post(account, '/v1/me/settings', payload);
        assert.equal(res.statusCode, 400, JSON.stringify(payload));
        assert.equal(res.json().error.code, 'VALIDATION_FAILED');
      }
      await t.db.update(users).set({ settings: { reminderHour: 30, autoSpeakWord: 'no', autoSpeakOnFlip: false } }).where(eq(users.id, account.userId));
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: account.headers });
      assert.deepEqual(me.json().data.settings, { autoSpeakOnFlip: false });
    });
  });

  describe('POST /v1/export', () => {
    test('records grouped by their local date, then the learning units; only the caller’s', async () => {
      const account = await createLearner(t.db, { now: clock() });
      // Each record keeps the offset it was made at (independent of this machine's time zone).
      const at = (iso: string, fields: Parameters<typeof makeEntry>[0]) => ({ ...makeEntry({ ...fields, createdAt: new Date(iso) }), createdAt: iso });
      const late = at('2026-11-15T23:50:00+08:00', { input: 'late night line one\n# not a heading', output: '深夜的句子' });
      const lookup = at('2026-11-16T09:05:00+08:00', { input: 'prioritiz', output: 'prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑' });
      const check = at('2026-11-16T10:00:00+08:00', { task: 'check', source: 'mp', input: 'He go home.', output: 'He goes home.' });
      // Made at UTC+0: grouped by its own local date (the 15th), not the server's.
      const abroad = at('2026-11-15T18:00:00+00:00', { input: 'from abroad', output: '来自国外' });
      await insertEntries(t.db, account.userId, [check, late, abroad, { ...lookup, correctedInput: 'prioritize' }]);
      const word = await seedItem(t.db, account.userId, { type: 'word', display: 'meticulous', lookupCount: 3 });
      await seedItem(t.db, account.userId, { type: 'grammar', display: 'look forward to + -ing', errorCount: 2 });
      await seedItem(t.db, account.userId, { type: 'phrase', display: 'be torn between' });
      await seedItem(t.db, account.userId, { type: 'word', display: 'pending', content: null, status: 'pending', withCards: false });
      await seedSource(t.db, account.userId, word.itemId, lookup.id);
      const other = await createLearner(t.db, { now: clock() });
      await insertEntries(t.db, other.userId, [makeEntry({ input: 'someone else entirely' })]);

      const res = await post(account, '/v1/export', { utcOffsetMinutes: 480 });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers['content-type'], 'text/markdown; charset=utf-8');
      assert.equal(res.headers['content-disposition'], 'attachment; filename="t-cli-export-20261117.md"');
      const md = res.body;
      assert.ok(!md.includes('someone else entirely'));
      assert.ok(md.startsWith('# t-cli export\n\nExported 2026-11-17T10:00:00+08:00.'));

      const dateHeadings = [...md.matchAll(/^### (\d{4}-\d{2}-\d{2})$/gm)].map((m) => m[1]);
      assert.deepEqual(dateHeadings, ['2026-11-15', '2026-11-16'], 'one heading per local date');
      const recordHeadings = [...md.matchAll(/^#### (\[\d{2}:\d{2}\] .+)$/gm)].map((m) => m[1]);
      // In time order: 23:50 at +08:00 (15:50Z) came before 18:00 at +00:00.
      assert.deepEqual(recordHeadings, [
        '[23:50] Translation · CLI',
        '[18:00] Translation · CLI',
        '[09:05] Translation · CLI',
        '[10:00] Grammar Check · mini-program',
      ]);
      assert.ok(md.includes('> late night line one\n> # not a heading'), 'inputs are quoted line by line');
      assert.ok(md.includes('**Corrected:** prioritize'));
      assert.ok(md.includes('He goes home.'));

      const units = md.slice(md.indexOf('## Learning units'));
      assert.deepEqual([...units.matchAll(/^### (\w+)$/gm)].map((m) => m[1]), ['Words', 'Phrases', 'Grammar']);
      assert.deepEqual([...units.matchAll(/^#### (.+)$/gm)].map((m) => m[1]), ['meticulous', 'pending', 'be torn between', 'look forward to + -ing']);
      assert.ok(units.includes('- adj. meticulous 的释义'));
      assert.ok(units.includes('- ✓ I look forward to hearing from you.'));
      assert.ok(units.includes('_Looked up 3 × · mistakes 0_'));
    });

    test('an empty account still gets a file; the filename follows utcOffsetMinutes (body or query)', async () => {
      const account = await createLearner(t.db, { now: clock() });
      const res = await post(account, '/v1/export?utcOffsetMinutes=-600');
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-disposition'], 'attachment; filename="t-cli-export-20261116.md"');
      assert.ok(res.body.includes('_No records._'));
      assert.ok(res.body.includes('_No learning units yet._'));
      assert.equal((await post(account, '/v1/export', { utcOffsetMinutes: 900 })).statusCode, 400);
    });

    test('at most 3 exports per account per hour', async () => {
      const account = await createLearner(t.db, { now: clock() });
      const other = await createLearner(t.db, { now: clock() });
      for (let i = 0; i < 3; i += 1) assert.equal((await post(account, '/v1/export', {})).statusCode, 200);
      const limited = await post(account, '/v1/export', {});
      assert.equal(limited.statusCode, 429);
      assert.equal(limited.json().error.code, 'RATE_LIMITED');
      assert.equal(limited.headers['retry-after'], '3600');
      assert.equal((await post(other, '/v1/export', {})).statusCode, 200, 'per account');
      clock.advance(HOUR + 1);
      try {
        assert.equal((await post(account, '/v1/export', {})).statusCode, 200);
      } finally {
        clock.set(new Date('2026-11-17T10:00:00+08:00'));
      }
    });

    test('requires authentication', async () => {
      assert.equal((await post(null, '/v1/export', {})).statusCode, 401);
    });
  });

  test('logs never carry search text, record text or exported text', async (ctx) => {
    const traced = await buildTestApp(t.db, { clock, config: testConfig({ LOG_LEVEL: 'trace' }) });
    ctx.after(() => traced.close());
    const logs = captureLogs(traced);
    const account = await createLearner(t.db, { now: clock() });
    await insertEntries(t.db, account.userId, [makeEntry({ input: 'privaterecordtext', createdAt: new Date('2026-11-17T09:00:00+08:00') })]);
    await seedItem(t.db, account.userId, { type: 'word', display: 'privateheadword' });
    const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
      traced.inject({ method, url, headers: account.headers, ...(payload ? { payload } : {}) });
    assert.equal((await call('GET', '/v1/items?q=privatesearchterm')).statusCode, 200);
    assert.equal((await call('GET', '/v1/items')).statusCode, 200);
    assert.equal((await call('GET', '/v1/entries/day?date=2026-11-17')).statusCode, 200);
    const exported = await call('POST', '/v1/export', {});
    assert.ok(exported.body.includes('privaterecordtext') && exported.body.includes('privateheadword'));
    const text = logs.text();
    for (const secret of ['privatesearchterm', 'privaterecordtext', 'privateheadword']) assert.ok(!text.includes(secret), secret);
    const exportLine = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.msg === 'export');
    assert.deepEqual({ entries: exportLine?.entries, items: exportLine?.items, outcome: exportLine?.outcome }, { entries: 1, items: 1, outcome: 'ok' });
    assert.equal(exportLine?.bytes, Buffer.byteLength(exported.body));
  });

  describe('POST /v1/me/delete', () => {
    /** A real WeChat sign-up, so the account has an identity and a refresh token. */
    async function signUp(): Promise<{ pair: TokenPairBody; code: string; account: TestAccount }> {
      const { code, openid } = nextWechatCode();
      codes[code] = openid;
      const inviteCode = await createInvite(t.db, { now: clock() });
      const res = await app.inject({ method: 'POST', url: '/v1/auth/wechat', payload: { code, inviteCode }, remoteAddress: nextIp() });
      assert.equal(res.statusCode, 200, res.body);
      const pair = res.json().data as TokenPairBody;
      return { pair, code, account: { userId: pair.user.id, deviceId: pair.deviceId, role: 'member', headers: bearer(pair.accessToken) } };
    }

    const rowsOf = async (userId: string): Promise<Record<string, number>> => {
      const tables = ['users', 'identities', 'devices', 'entries', 'ai_usage', 'items', 'item_sources', 'cards', 'review_logs', 'materials', 'notify_grants'];
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const column = table === 'users' ? 'id' : 'user_id';
        const [row] = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} = ${userId}`);
        counts[table] = row?.n ?? 0;
      }
      return counts;
    };

    test('only { confirm: "DELETE" } deletes', async () => {
      const { account } = await signUp();
      for (const payload of [undefined, {}, { confirm: 'delete' }, { confirm: 'DELETE', extra: true }, { confirm: true }]) {
        const res = await post(account, '/v1/me/delete', payload);
        assert.equal(res.statusCode, 400, JSON.stringify(payload) ?? 'undefined');
        assert.equal(res.json().error.code, 'VALIDATION_FAILED');
      }
      assert.equal((await rowsOf(account.userId)).users, 1);
      assert.equal((await post(null, '/v1/me/delete', { confirm: 'DELETE' })).statusCode, 401);
    });

    test('deletes the account and all of its data; other accounts keep theirs', async () => {
      const { pair, code, account } = await signUp();
      await insertEntries(t.db, account.userId, [makeEntry(), makeEntry()]);
      const item = await seedItem(t.db, account.userId, { type: 'word', display: 'doomed' });
      await seedSource(t.db, account.userId, item.itemId, ulid());
      await rate(app, account, clock, item.cardIds[0]!, 3);
      await seedMaterial(t.db, account.userId, { date: '2026-11-16', content: dailyMaterial('2026-11-16') });
      await seedGrant(t.db, account.userId, TEMPLATE, 2);
      await t.db.insert(aiUsage).values({ userId: account.userId, day: '2026-11-17', requests: 3 });
      const before = await rowsOf(account.userId);
      assert.ok(Object.values(before).every((n) => n > 0), JSON.stringify(before));

      const survivor = await createLearner(t.db, { now: clock() });
      await insertEntries(t.db, survivor.userId, [makeEntry()]);
      await seedItem(t.db, survivor.userId, { type: 'phrase', display: 'survives' });
      const survivorBefore = await rowsOf(survivor.userId);

      const res = await post(account, '/v1/me/delete', { confirm: 'DELETE' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { success: true, data: { deleted: true }, error: null });
      assert.ok(Object.values(await rowsOf(account.userId)).every((n) => n === 0), JSON.stringify(await rowsOf(account.userId)));
      assert.deepEqual(await rowsOf(survivor.userId), survivorBefore);
      const [usedInvite] = await t.db.select().from(invites).where(eq(invites.usedBy, account.userId));
      assert.equal(usedInvite, undefined, 'the invite no longer points at the account');

      // Every device is gone: the refresh token is dead.
      const refresh = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: pair.refreshToken }, remoteAddress: nextIp() });
      assert.equal(refresh.statusCode, 401);
      assert.equal(refresh.json().error.code, 'REFRESH_INVALID');
      assert.equal((await t.db.select().from(devices).where(eq(devices.userId, account.userId))).length, 0);

      // The same WeChat user starts over and needs a new invite.
      const again = await app.inject({ method: 'POST', url: '/v1/auth/wechat', payload: { code }, remoteAddress: nextIp() });
      assert.equal(again.statusCode, 403);
      assert.equal(again.json().error.code, 'INVITE_REQUIRED');
      assert.equal((await t.db.select().from(identities).where(eq(identities.userId, account.userId))).length, 0);
    });

    test("a deleted account's still-valid access token fails cleanly everywhere (never 500)", async () => {
      const { account } = await signUp();
      const item = await seedItem(t.db, account.userId, { type: 'word', display: 'ghost' });
      const entry = makeEntry();
      await insertEntries(t.db, account.userId, [entry]);
      assert.equal((await post(account, '/v1/me/delete', { confirm: 'DELETE' })).statusCode, 200);

      const headers = account.headers;
      const requests: { method: 'GET' | 'POST' | 'DELETE'; url: string; payload?: Record<string, unknown>; expect: number }[] = [
        { method: 'GET', url: '/v1/me', expect: 401 },
        { method: 'POST', url: '/v1/me/settings', payload: { reminderHour: 8 }, expect: 401 },
        { method: 'POST', url: '/v1/me/delete', payload: { confirm: 'DELETE' }, expect: 401 },
        { method: 'POST', url: '/v1/export', payload: {}, expect: 401 },
        { method: 'POST', url: '/v1/notify/grant', payload: { templateId: TEMPLATE }, expect: 401 },
        { method: 'POST', url: '/v1/entries', payload: { entries: [makeEntry()] }, expect: 404 },
        { method: 'GET', url: '/v1/entries', expect: 200 },
        { method: 'GET', url: '/v1/review/summary', expect: 200 },
        { method: 'GET', url: '/v1/review/queue', expect: 200 },
        { method: 'POST', url: '/v1/reviews', payload: { logs: [{ id: ulid(), cardId: item.cardIds[0], rating: 3, reviewedAt: clock().toISOString() }] }, expect: 200 },
        { method: 'DELETE', url: `/v1/reviews/${ulid()}`, expect: 404 },
        { method: 'POST', url: `/v1/cards/${item.cardIds[0]}/report`, expect: 404 },
        { method: 'GET', url: '/v1/items', expect: 200 },
        { method: 'GET', url: `/v1/items/${item.itemId}`, expect: 404 },
        { method: 'GET', url: '/v1/stats', expect: 200 },
        { method: 'GET', url: '/v1/materials/daily', expect: 404 },
        { method: 'GET', url: '/v1/entries/day?date=2026-11-17', expect: 200 },
        { method: 'POST', url: '/v1/tts', payload: { entryId: entry.id }, expect: 404 },
        { method: 'GET', url: '/v1/devices', expect: 200 },
        { method: 'POST', url: '/v1/auth/logout', expect: 200 },
      ];
      for (const { method, url, payload, expect } of requests) {
        const res = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
        assert.equal(res.statusCode, expect, `${method} ${url}: ${res.body}`);
      }
      const pushed = await app.inject({ method: 'POST', url: '/v1/reviews', headers, payload: { logs: [{ id: ulid(), cardId: item.cardIds[0], rating: 3, reviewedAt: clock().toISOString() }] } });
      assert.deepEqual(pushed.json().data.accepted, []);
      assert.deepEqual((await rowsOf(account.userId)).users, 0, 'nothing was recreated');
    });
  });
});
