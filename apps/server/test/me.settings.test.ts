import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { users } from '../src/db/schema.ts';
import { buildTestApp, fixedClock, type TestClock } from './helpers/app.ts';
import { softDeleteUser } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount, type TestAccount } from './helpers/fixtures.ts';

describe('account settings: GET /v1/me and POST /v1/me/settings', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let clock: TestClock;

  before(async () => {
    t = await createTestDatabase();
    clock = fixedClock();
    app = await buildTestApp(t.db, { clock });
  });
  after(async () => {
    await app?.close();
    await t?.drop();
  });

  const me = (account: TestAccount) => app.inject({ method: 'GET', url: '/v1/me', headers: account.headers });
  const update = (account: TestAccount, payload?: unknown) =>
    app.inject({
      method: 'POST',
      url: '/v1/me/settings',
      headers: account.headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const storedSettings = async (userId: string) =>
    (await t.db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)))[0]?.settings;

  test('a new account has empty settings', async () => {
    const account = await createAccount(t.db, { now: clock() });
    const res = await me(account);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data.settings, {});
    assert.deepEqual(Object.keys(res.json().data).sort(), ['createdAt', 'id', 'role', 'settings']);
  });

  test('an update merges, returns the full settings and shows in /v1/me', async () => {
    const account = await createAccount(t.db, { now: clock() });
    const first = await update(account, { explanationLang: 'en' });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { success: true, data: { settings: { explanationLang: 'en' } }, error: null });
    assert.deepEqual((await me(account)).json().data.settings, { explanationLang: 'en' });

    // An empty partial changes nothing and still answers the full settings.
    const empty = await update(account, {});
    assert.deepEqual(empty.json().data.settings, { explanationLang: 'en' });

    const back = await update(account, { explanationLang: 'zh' });
    assert.deepEqual(back.json().data.settings, { explanationLang: 'zh' });
    assert.deepEqual(await storedSettings(account.userId), { explanationLang: 'zh' });
  });

  test('unknown keys, bad values and non-object bodies are 400 VALIDATION_FAILED; nothing changes', async () => {
    const account = await createAccount(t.db, { now: clock() });
    await update(account, { explanationLang: 'en' });
    const invalid: unknown[] = [
      undefined,
      null,
      [],
      { explanationLang: 'fr' },
      { explanationLang: null },
      { explanationLang: 1 },
      { mode: 'detail' },
      { explanationLang: 'zh', theme: 'dark' },
      { secretValue: 'my private text' },
    ];
    for (const payload of invalid) {
      const res = await update(account, payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload) ?? 'undefined');
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
      assert.ok(!res.body.includes('my private text'), 'submitted values are never echoed');
    }
    assert.deepEqual(await storedSettings(account.userId), { explanationLang: 'en' });
  });

  test('v2 keys: an update stores and shows every one; bad values are 400 and change nothing', async () => {
    const account = await createAccount(t.db, { now: clock() });
    const v2 = {
      showDirection: true,
      accent: 'pine',
      themeMode: 'time',
      themeFixed: 'dark',
      themeDayStart: '06:30',
      themeNightStart: '20:15',
      readingMode: true,
      readingFontStep: 3,
      importanceReview: false,
    };
    const res = await update(account, v2);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data.settings, v2);
    assert.deepEqual((await me(account)).json().data.settings, v2);

    const invalid: Record<string, unknown>[] = [
      { accent: 'red' },
      { themeMode: 'auto' },
      { themeFixed: 'sepia' },
      { themeDayStart: '7:00' },
      { themeNightStart: '24:00' },
      { themeDayStart: '07:60' },
      { readingFontStep: 4 },
      { readingFontStep: 1.5 },
      { showDirection: 'yes' },
      { importanceReview: null },
      { language: 'en' },
    ];
    for (const payload of invalid) {
      const bad = await update(account, payload);
      assert.equal(bad.statusCode, 400, JSON.stringify(payload));
      assert.equal(bad.json().error.code, 'VALIDATION_FAILED');
    }
    assert.deepEqual(await storedSettings(account.userId), v2);
  });

  test('keys the API does not know are kept in storage but never shown', async () => {
    const account = await createAccount(t.db, { now: clock() });
    await t.db.update(users).set({ settings: { legacy: { a: 1 }, explanationLang: 'fr' } }).where(eq(users.id, account.userId));
    assert.deepEqual((await me(account)).json().data.settings, {}, 'an invalid stored value is hidden');

    const res = await update(account, { explanationLang: 'en' });
    assert.deepEqual(res.json().data.settings, { explanationLang: 'en' });
    assert.deepEqual(await storedSettings(account.userId), { legacy: { a: 1 }, explanationLang: 'en' });
  });

  test('concurrent updates merge atomically: other stored keys survive', async () => {
    const account = await createAccount(t.db, { now: clock() });
    await t.db.update(users).set({ settings: { legacy: true } }).where(eq(users.id, account.userId));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => update(account, { explanationLang: i % 2 === 0 ? 'zh' : 'en' })),
    );
    assert.ok(results.every((res) => res.statusCode === 200));
    const stored = await storedSettings(account.userId);
    assert.equal(stored?.legacy, true);
    assert.ok(stored?.explanationLang === 'zh' || stored?.explanationLang === 'en');
  });

  test("an update only touches the caller's account", async () => {
    const alice = await createAccount(t.db, { now: clock() });
    const bob = await createAccount(t.db, { now: clock() });
    await update(alice, { explanationLang: 'en' });
    assert.deepEqual((await me(bob)).json().data.settings, {});
  });

  test('requires authentication and an active account; PATCH is not a route', async () => {
    const anonymous = await app.inject({ method: 'POST', url: '/v1/me/settings', payload: { explanationLang: 'en' } });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json().error.code, 'UNAUTHORIZED');

    const deleted = await createAccount(t.db, { now: clock() });
    await softDeleteUser(t.db, deleted.userId, clock());
    assert.equal((await update(deleted, { explanationLang: 'en' })).statusCode, 401);
    assert.deepEqual(await storedSettings(deleted.userId), {});

    // wx.request cannot send PATCH, so the contract has POST only.
    const account = await createAccount(t.db, { now: clock() });
    const patch = await app.inject({ method: 'PATCH', url: '/v1/me/settings', headers: account.headers, payload: { explanationLang: 'en' } });
    assert.equal(patch.statusCode, 404);
  });
});
