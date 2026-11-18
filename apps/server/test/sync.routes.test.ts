import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount, makeEntry } from './helpers/fixtures.ts';

describe('sync routes', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  before(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db);
  });
  after(async () => {
    await app?.close();
    await t?.drop();
  });

  test('push and pull require a valid access token', async () => {
    for (const authorization of [undefined, 'Bearer nope', 'Basic abc']) {
      const headers = authorization ? { authorization } : {};
      const push = await app.inject({ method: 'POST', url: '/v1/entries', headers, payload: { entries: [makeEntry()] } });
      const pull = await app.inject({ method: 'GET', url: '/v1/entries', headers });
      assert.equal(push.statusCode, 401);
      assert.equal(pull.statusCode, 401);
      assert.equal(push.json().error.code, 'UNAUTHORIZED');
    }
  });

  test('push stores valid entries, reports invalid ones, and is idempotent', async () => {
    const account = await createAccount(t.db);
    const good = [makeEntry(), makeEntry()];
    const bad = { ...makeEntry(), task: 'quiz' };
    const payload = { entries: [good[0], bad, good[1]] };

    const first = await app.inject({ method: 'POST', url: '/v1/entries', headers: account.headers, payload });
    assert.equal(first.statusCode, 200);
    const body = first.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data.accepted, good.map((e) => e.id));
    assert.equal(body.data.rejected.length, 1);
    assert.equal(body.data.rejected[0].index, 1);
    assert.equal(body.data.lastSeq, 2);

    const second = await app.inject({ method: 'POST', url: '/v1/entries', headers: account.headers, payload });
    assert.equal(second.json().data.lastSeq, 2, 're-pushing the same batch stores nothing new');
  });

  test('pull pages through entries in seq order', async () => {
    const account = await createAccount(t.db);
    const batch = Array.from({ length: 3 }, () => makeEntry());
    await app.inject({ method: 'POST', url: '/v1/entries', headers: account.headers, payload: { entries: batch } });

    const page1 = (await app.inject({ method: 'GET', url: '/v1/entries?after=0&limit=2', headers: account.headers })).json().data;
    assert.deepEqual(page1.entries.map((e: { id: string }) => e.id), batch.slice(0, 2).map((e) => e.id));
    assert.equal(page1.hasMore, true);
    const page2 = (await app.inject({ method: 'GET', url: `/v1/entries?after=${page1.nextAfter}&limit=2`, headers: account.headers })).json().data;
    assert.deepEqual(page2.entries.map((e: { id: string }) => e.id), [batch[2]!.id]);
    assert.equal(page2.hasMore, false);
  });

  test('srcLang "other" entries are accepted and pulled back unchanged', async () => {
    const account = await createAccount(t.db);
    const entry = makeEntry({ input: '会議室を予約しました', output: '我预约了会议室。', srcLang: 'other' });
    const push = await app.inject({ method: 'POST', url: '/v1/entries', headers: account.headers, payload: { entries: [entry] } });
    assert.deepEqual(push.json().data.accepted, [entry.id]);
    const [pulled] = (await app.inject({ method: 'GET', url: '/v1/entries?after=0', headers: account.headers })).json().data.entries;
    assert.deepEqual(pulled, { ...entry, seq: 1 });
  });

  test("an account never sees another account's entries", async () => {
    const alice = await createAccount(t.db);
    const bob = await createAccount(t.db);
    await app.inject({ method: 'POST', url: '/v1/entries', headers: alice.headers, payload: { entries: [makeEntry({ input: 'alice private text' })] } });
    const bobPull = (await app.inject({ method: 'GET', url: '/v1/entries?after=0', headers: bob.headers })).json().data;
    assert.deepEqual(bobPull.entries, []);
  });

  const history = (headers: { authorization: string }, query = '') =>
    app.inject({ method: 'GET', url: `/v1/entries/history${query}`, headers });

  test('history pages newest first with a before cursor', async () => {
    const account = await createAccount(t.db);
    const batch = Array.from({ length: 5 }, () => makeEntry());
    await app.inject({ method: 'POST', url: '/v1/entries', headers: account.headers, payload: { entries: batch } });
    const ids = (page: { entries: { id: string }[] }) => page.entries.map((e) => e.id);
    const newestFirst = [...batch].reverse().map((e) => e.id);

    const page1 = (await history(account.headers, '?limit=2')).json().data;
    assert.deepEqual(ids(page1), newestFirst.slice(0, 2));
    assert.deepEqual(page1.entries.map((e: { seq: number }) => e.seq), [5, 4]);
    assert.deepEqual({ nextBefore: page1.nextBefore, hasMore: page1.hasMore }, { nextBefore: 4, hasMore: true });
    assert.deepEqual(page1.entries[0], { ...batch[4], seq: 5 }, 'entries carry every Entry field plus seq');

    const page2 = (await history(account.headers, `?before=${page1.nextBefore}&limit=2`)).json().data;
    assert.deepEqual(ids(page2), newestFirst.slice(2, 4));
    assert.equal(page2.nextBefore, 2);

    const page3 = (await history(account.headers, `?before=${page2.nextBefore}&limit=2`)).json().data;
    assert.deepEqual(ids(page3), newestFirst.slice(4));
    assert.deepEqual({ nextBefore: page3.nextBefore, hasMore: page3.hasMore }, { nextBefore: null, hasMore: false });

    // Exactly `limit` left: no phantom next page.
    const exact = (await history(account.headers, '?before=3&limit=2')).json().data;
    assert.deepEqual({ count: exact.entries.length, nextBefore: exact.nextBefore, hasMore: exact.hasMore }, { count: 2, nextBefore: null, hasMore: false });

    const all = (await history(account.headers)).json().data;
    assert.deepEqual(ids(all), newestFirst, 'default: from the newest, up to 30');
    assert.deepEqual((await history(account.headers, '?before=1')).json().data, { entries: [], nextBefore: null, hasMore: false });
  });

  test('history default and maximum page sizes', async () => {
    const account = await createAccount(t.db);
    const batch = Array.from({ length: 101 }, () => makeEntry());
    await app.inject({ method: 'POST', url: '/v1/entries', headers: account.headers, payload: { entries: batch } });
    const defaults = (await history(account.headers)).json().data;
    assert.equal(defaults.entries.length, 30);
    assert.equal(defaults.nextBefore, 72);
    const max = (await history(account.headers, '?limit=100')).json().data;
    assert.equal(max.entries.length, 100);
    assert.equal(max.hasMore, true);
  });

  test("history is scoped to the caller: another account's entries never appear", async () => {
    const alice = await createAccount(t.db);
    const bob = await createAccount(t.db);
    await app.inject({ method: 'POST', url: '/v1/entries', headers: alice.headers, payload: { entries: [makeEntry({ input: 'alice private text' })] } });
    const bobEntry = makeEntry();
    await app.inject({ method: 'POST', url: '/v1/entries', headers: bob.headers, payload: { entries: [bobEntry] } });
    for (const query of ['', '?before=1000', '?before=2&limit=100']) {
      const page = (await history(bob.headers, query)).json().data;
      assert.ok(page.entries.every((e: { id: string }) => e.id === bobEntry.id), query);
      assert.ok(!JSON.stringify(page).includes('alice private text'), query);
    }
  });

  test('history validates its query and requires authentication', async () => {
    const account = await createAccount(t.db);
    for (const query of ['?limit=0', '?limit=101', '?limit=abc', '?before=0', '?before=-1', '?before=1.5', '?before=abc', '?before=']) {
      const res = await history(account.headers, query);
      assert.equal(res.statusCode, 400, query);
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
    const anonymous = await app.inject({ method: 'GET', url: '/v1/entries/history' });
    assert.equal(anonymous.statusCode, 401);
  });

  test('request validation errors do not echo submitted values', async () => {
    const account = await createAccount(t.db);
    const empty = await app.inject({ method: 'POST', url: '/v1/entries', headers: account.headers, payload: { entries: [] } });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().error.code, 'VALIDATION_FAILED');
    const badQuery = await app.inject({ method: 'GET', url: '/v1/entries?limit=99999', headers: account.headers });
    assert.equal(badQuery.statusCode, 400);
    const secret = await app.inject({ method: 'POST', url: '/v1/entries', headers: account.headers, payload: { entries: 'my secret text' } });
    assert.equal(secret.statusCode, 400);
    assert.ok(!secret.body.includes('my secret text'));
  });

  test('healthz and readyz', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).json().data.status, 'ready');
  });
});
