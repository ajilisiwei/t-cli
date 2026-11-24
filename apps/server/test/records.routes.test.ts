import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Entry } from '@t-cli/core/entry';
import { insertEntries } from '../src/db/entriesRepo.ts';
import { escapeLike } from '../src/modules/sync/records.ts';
import { buildTestApp, testConfig } from './helpers/app.ts';
import { captureLogs } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount, makeEntry, type TestAccount } from './helpers/fixtures.ts';

type EntryFields = Parameters<typeof makeEntry>[0];

describe('records: escapeLike (pure)', () => {
  test('escapes the LIKE wildcards and the escape character', () => {
    assert.equal(escapeLike('100% sure'), '100\\% sure');
    assert.equal(escapeLike('snake_case'), 'snake\\_case');
    assert.equal(escapeLike('a\\b'), 'a\\\\b');
    assert.equal(escapeLike('plain 中文'), 'plain 中文');
  });
});

describe('records: GET /v1/entries/days and the history filters', { skip: skipWithoutDb }, () => {
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

  async function store(account: TestAccount, fields: EntryFields[]): Promise<Entry[]> {
    const batch = fields.map((f) => makeEntry(f));
    await insertEntries(t.db, account.userId, batch);
    return batch;
  }

  const at = (iso: string): { createdAt: Date } => ({ createdAt: new Date(iso) });

  const get = (account: TestAccount | null, url: string) => app.inject({ method: 'GET', url, headers: account?.headers ?? {} });

  async function days(account: TestAccount, query: string): Promise<{ date: string; count: number }[]> {
    const res = await get(account, `/v1/entries/days?${query}`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data.days;
  }

  async function history(account: TestAccount, query: string): Promise<{ ids: string[]; nextBefore: number | null; hasMore: boolean }> {
    const res = await get(account, `/v1/entries/history?${query}`);
    assert.equal(res.statusCode, 200, res.body);
    const data = res.json().data;
    return { ids: data.entries.map((e: { id: string }) => e.id), nextBefore: data.nextBefore, hasMore: data.hasMore };
  }

  const ids = (batch: Entry[], ...indexes: number[]): string[] => indexes.map((i) => batch[i]!.id);

  test('both routes require a valid access token', async () => {
    for (const url of ['/v1/entries/days?from=2026-11-01&to=2026-11-30', '/v1/entries/history?q=abc']) {
      const res = await get(null, url);
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'UNAUTHORIZED');
    }
  });

  test('days: local dates with at least one record, ascending, with their counts', async () => {
    const account = await createAccount(t.db);
    await store(account, [
      at('2026-11-10T09:00:00+08:00'),
      { ...at('2026-11-10T21:00:00+08:00'), task: 'check', input: 'He go.', output: 'He goes.' },
      at('2026-11-12T00:00:00+08:00'), // the first instant of 11-12 (local)
      at('2026-11-12T23:59:59+08:00'),
      at('2026-11-12T12:00:00+08:00'),
      at('2026-11-30T23:59:00+08:00'),
      at('2026-12-01T00:00:00+08:00'), // outside the range
      at('2026-10-31T23:59:59+08:00'), // outside the range
    ]);
    const other = await createAccount(t.db);
    await store(other, [at('2026-11-11T09:00:00+08:00')]);

    assert.deepEqual(await days(account, 'from=2026-11-01&to=2026-11-30'), [
      { date: '2026-11-10', count: 2 },
      { date: '2026-11-12', count: 3 },
      { date: '2026-11-30', count: 1 },
    ]);
    assert.deepEqual(await days(account, 'from=2026-11-12&to=2026-11-12'), [{ date: '2026-11-12', count: 3 }], 'from = to: one day');
    assert.deepEqual(await days(account, 'from=2026-11-13&to=2026-11-29'), [], 'no records → no days');
  });

  test('days: dates are local to utcOffsetMinutes (default 480)', async () => {
    const account = await createAccount(t.db);
    // 2026-11-17T17:30Z: 11-18 01:30 in Shanghai, 11-17 in London and New York.
    await store(account, [at('2026-11-17T17:30:00Z'), at('2026-11-17T03:00:00Z')]);
    assert.deepEqual(await days(account, 'from=2026-11-16&to=2026-11-19'), [
      { date: '2026-11-17', count: 1 },
      { date: '2026-11-18', count: 1 },
    ]);
    assert.deepEqual(await days(account, 'from=2026-11-16&to=2026-11-19&utcOffsetMinutes=0'), [{ date: '2026-11-17', count: 2 }]);
    assert.deepEqual(await days(account, 'from=2026-11-16&to=2026-11-19&utcOffsetMinutes=-300'), [
      { date: '2026-11-16', count: 1 }, // 03:00Z is 22:00 the day before in New York
      { date: '2026-11-17', count: 1 },
    ]);
    // The range bounds are local too: at +14:00, 17:30Z is already 11-18.
    assert.deepEqual(await days(account, 'from=2026-11-18&to=2026-11-18&utcOffsetMinutes=840'), [{ date: '2026-11-18', count: 1 }]);
  });

  test('days: source narrows to cli or mp records', async () => {
    const account = await createAccount(t.db);
    await store(account, [
      { ...at('2026-11-05T09:00:00+08:00'), source: 'cli' },
      { ...at('2026-11-05T10:00:00+08:00'), source: 'mp' },
      { ...at('2026-11-06T10:00:00+08:00'), source: 'mp' },
    ]);
    const range = 'from=2026-11-01&to=2026-11-30';
    assert.deepEqual(await days(account, `${range}&source=cli`), [{ date: '2026-11-05', count: 1 }]);
    assert.deepEqual(await days(account, `${range}&source=mp`), [
      { date: '2026-11-05', count: 1 },
      { date: '2026-11-06', count: 1 },
    ]);
    assert.deepEqual(await days(account, range), [
      { date: '2026-11-05', count: 2 },
      { date: '2026-11-06', count: 1 },
    ]);
  });

  test('days: from and to are required, from ≤ to, at most 366 days', async () => {
    const account = await createAccount(t.db);
    assert.equal((await get(account, '/v1/entries/days?from=2025-11-25&to=2026-11-25')).statusCode, 200, '366 days inclusive');
    assert.equal((await get(account, '/v1/entries/days?from=2024-01-01&to=2024-12-31')).statusCode, 200, 'a leap year is 366 days');
    for (const query of [
      '',
      'from=2026-11-01',
      'to=2026-11-01',
      'from=2026-11-02&to=2026-11-01',
      'from=2025-11-24&to=2026-11-25',
      'from=2026-02-30&to=2026-03-01',
      'from=20261101&to=2026-11-02',
      'from=2026-11-01&to=2026-11-02&source=web',
      'from=2026-11-01&to=2026-11-02&utcOffsetMinutes=900',
      'from=2026-11-01&to=2026-11-02&utcOffsetMinutes=abc',
    ]) {
      const res = await get(account, `/v1/entries/days?${query}`);
      assert.equal(res.statusCode, 400, query);
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
  });

  test('history: date keeps one local day, still newest first and paged', async () => {
    const account = await createAccount(t.db);
    const batch = await store(account, [
      at('2026-11-17T23:59:59+08:00'), // 0: 11-17
      at('2026-11-18T00:00:00+08:00'), // 1: 11-18
      at('2026-11-18T08:00:00+08:00'), // 2: 11-18
      at('2026-11-18T23:00:00+08:00'), // 3: 11-18
      at('2026-11-19T00:00:00+08:00'), // 4: 11-19
    ]);
    const page1 = await history(account, 'date=2026-11-18&limit=2');
    assert.deepEqual(page1.ids, ids(batch, 3, 2));
    assert.equal(page1.hasMore, true);
    const page2 = await history(account, `date=2026-11-18&limit=2&before=${page1.nextBefore}`);
    assert.deepEqual(page2.ids, ids(batch, 1));
    assert.deepEqual([page2.hasMore, page2.nextBefore], [false, null]);

    // At UTC, 11-18 00:00+08:00 (16:00Z) belongs to 11-17; 11-18 08:00+08:00 is 11-18 00:00Z.
    assert.deepEqual((await history(account, 'date=2026-11-17&utcOffsetMinutes=0')).ids, ids(batch, 1, 0));
    assert.deepEqual((await history(account, 'date=2026-11-18&utcOffsetMinutes=0')).ids, ids(batch, 4, 3, 2));
    assert.deepEqual((await history(account, 'date=2026-11-20')).ids, []);
  });

  test('history: source keeps cli or mp records', async () => {
    const account = await createAccount(t.db);
    const batch = await store(account, [{ source: 'cli' }, { source: 'mp' }, { source: 'cli' }]);
    assert.deepEqual((await history(account, 'source=cli')).ids, ids(batch, 2, 0));
    assert.deepEqual((await history(account, 'source=mp')).ids, ids(batch, 1));
  });

  test('history: q is a case-insensitive literal substring of the input', async () => {
    const account = await createAccount(t.db);
    const batch = await store(account, [
      { input: 'Good Morning everyone', output: '大家早上好' }, // 0
      { input: 'morning', output: '早晨' }, // 1
      { input: 'evening', output: 'morning is not in the input' }, // 2
      { input: '我今天早上很忙', output: 'I was busy this morning.', srcLang: 'zh' }, // 3
      { input: 'I am 100% sure', output: '我百分之百确定' }, // 4
      { input: 'I am 100 percent sure', output: '我百分之百确定' }, // 5
      { input: 'snake_case names', output: '蛇形命名' }, // 6
      { input: 'snakeXcase names', output: '蛇形命名' }, // 7
      { input: 'a back\\slash', output: '反斜杠' }, // 8
    ]);
    const search = async (q: string) => (await history(account, `q=${encodeURIComponent(q)}`)).ids;
    assert.deepEqual(await search('MORNING'), ids(batch, 1, 0), 'only the input is searched');
    assert.deepEqual(await search('早上'), ids(batch, 3));
    assert.deepEqual(await search('%'), ids(batch, 4), '% matches itself');
    assert.deepEqual(await search('100%'), ids(batch, 4));
    assert.deepEqual(await search('_'), ids(batch, 6), '_ matches itself');
    assert.deepEqual(await search('\\'), ids(batch, 8), '\\ matches itself');
    assert.deepEqual(await search('  morning\t'), ids(batch, 1, 0), 'trimmed');
    assert.deepEqual(await search('zzz'), []);
    // Empty after trimming = absent: every record.
    assert.equal((await history(account, 'q=%20%20&limit=100')).ids.length, batch.length);
    assert.equal((await history(account, 'q=&limit=100')).ids.length, batch.length);
  });

  test('history: q is 1–100 code points', async () => {
    const account = await createAccount(t.db);
    const batch = await store(account, [{ input: `前缀${'字'.repeat(100)}后缀`, output: 'x' }]);
    assert.deepEqual((await history(account, `q=${encodeURIComponent('字'.repeat(100))}`)).ids, ids(batch, 0), '100 code points');
    const tooLong = await get(account, `/v1/entries/history?q=${encodeURIComponent('字'.repeat(101))}`);
    assert.equal(tooLong.statusCode, 400);
    assert.equal(tooLong.json().error.code, 'VALIDATION_FAILED');
    assert.ok(!tooLong.body.includes('字字'), 'the submitted text is not echoed');
  });

  test('history: filters combine with AND and never reach another account', async () => {
    const account = await createAccount(t.db);
    const batch = await store(account, [
      { ...at('2026-11-18T09:00:00+08:00'), source: 'mp', input: 'deadline tomorrow' }, // 0
      { ...at('2026-11-18T10:00:00+08:00'), source: 'cli', input: 'deadline today' }, // 1
      { ...at('2026-11-19T10:00:00+08:00'), source: 'mp', input: 'deadline again' }, // 2
      { ...at('2026-11-18T11:00:00+08:00'), source: 'mp', input: 'no match here' }, // 3
    ]);
    const other = await createAccount(t.db);
    await store(other, [{ ...at('2026-11-18T09:30:00+08:00'), source: 'mp', input: 'their deadline' }]);
    assert.deepEqual((await history(account, 'date=2026-11-18&source=mp&q=deadline')).ids, ids(batch, 0));
    assert.deepEqual((await history(account, 'q=deadline')).ids, ids(batch, 2, 1, 0));
    assert.deepEqual((await history(account, 'q=deadline&source=mp')).ids, ids(batch, 2, 0));
    assert.deepEqual((await history(account, 'date=2026-11-18')).ids, ids(batch, 3, 1, 0));
  });

  test('history: invalid filters are 400', async () => {
    const account = await createAccount(t.db);
    for (const query of ['date=2026-13-01', 'date=yesterday', 'source=web', 'utcOffsetMinutes=-721', 'q=a&q=b']) {
      const res = await get(account, `/v1/entries/history?${query}`);
      assert.equal(res.statusCode, 400, query);
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
  });

  test('history: the search text never reaches the logs', async (ctx) => {
    const traced = await buildTestApp(t.db, { config: testConfig({ LOG_LEVEL: 'trace' }) });
    ctx.after(() => traced.close());
    const logs = captureLogs(traced);
    const account = await createAccount(t.db);
    await store(account, [{ input: 'my confidential phrase', output: '机密' }]);
    const res = await traced.inject({ method: 'GET', url: '/v1/entries/history?q=confidential%20phrase&source=cli', headers: account.headers });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.entries.length, 1);
    const text = logs.text();
    assert.ok(text.includes('/v1/entries/history'), 'the request is logged');
    assert.ok(!text.includes('confidential'), 'without its query string');
  });
});
