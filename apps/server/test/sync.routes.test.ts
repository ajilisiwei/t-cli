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
