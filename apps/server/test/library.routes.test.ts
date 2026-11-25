import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import { insertEntries } from '../src/db/entriesRepo.ts';
import { cards } from '../src/db/schema.ts';
import { buildTestApp, fixedClock, type TestClock } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { makeEntry, type TestAccount } from './helpers/fixtures.ts';
import { createLearner, dailyMaterial, seedItem, seedMaterial, seedSource } from './helpers/learning.ts';

describe('library: materials, items, entries of a day', { skip: skipWithoutDb }, () => {
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

  const get = (account: TestAccount, url: string) => app.inject({ method: 'GET', url, headers: account.headers });
  const learner = () => createLearner(t.db, { now: clock() });

  test('every route requires a valid access token', async () => {
    for (const url of ['/v1/materials/daily', '/v1/materials/weekly', '/v1/materials?kind=daily', '/v1/items', `/v1/items/${ulid()}`, '/v1/stats', '/v1/entries/day?date=2026-11-17']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 401, url);
    }
  });

  test('materials: by date, latest, list with paging; 404 when absent', async () => {
    const account = await learner();
    const other = await learner();
    for (const date of ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']) {
      await seedMaterial(t.db, account.userId, { date, content: dailyMaterial(date) });
    }
    await seedMaterial(t.db, account.userId, { kind: 'weekly', date: '2026-11-09', content: { weekStart: '2026-11-09', summary: 'week' } });
    await seedMaterial(t.db, other.userId, { date: '2026-11-17', content: dailyMaterial('2026-11-17', 'their story') });

    const latest = await get(account, '/v1/materials/daily');
    assert.equal(latest.statusCode, 200);
    assert.equal(latest.json().data.date, '2026-11-16', "another account's newer material is not the latest");
    assert.equal(latest.json().data.content.story.text, 'Tom kept meticulous notes every day.');
    assert.equal(latest.json().data.createdAt, '2026-11-16T22:00:00.000Z');

    assert.equal((await get(account, '/v1/materials/daily?date=2026-11-14')).json().data.date, '2026-11-14');
    assert.equal((await get(account, '/v1/materials/daily?date=2026-11-17')).statusCode, 404, "the other account's date");
    assert.equal((await get(account, '/v1/materials/weekly')).json().data.content.summary, 'week');
    assert.equal((await get(account, '/v1/materials/weekly?date=2026-11-16')).statusCode, 404);
    for (const bad of ['2026-11-31', '20261114', 'today']) {
      assert.equal((await get(account, `/v1/materials/daily?date=${bad}`)).statusCode, 400, bad);
    }

    // v1 fields only (v3 adds `items`, tested in materials.v3.test.ts).
    const v1 = (data: { dates: string[]; nextBefore: string | null }) => ({ dates: data.dates, nextBefore: data.nextBefore });
    const page1 = (await get(account, '/v1/materials?kind=daily&limit=3')).json().data;
    assert.deepEqual(v1(page1), { dates: ['2026-11-16', '2026-11-15', '2026-11-14'], nextBefore: '2026-11-14' });
    const page2 = (await get(account, `/v1/materials?kind=daily&limit=3&before=${page1.nextBefore}`)).json().data;
    assert.deepEqual(v1(page2), { dates: ['2026-11-13'], nextBefore: null });
    assert.deepEqual(v1((await get(account, '/v1/materials?kind=weekly')).json().data), { dates: ['2026-11-09'], nextBefore: null });
    for (const query of ['', '?kind=monthly', '?kind=daily&limit=61', '?kind=daily&before=x']) {
      assert.equal((await get(account, `/v1/materials${query}`)).statusCode, 400, query);
    }
    const empty = await learner();
    assert.equal((await get(empty, '/v1/materials/daily')).statusCode, 404);
  });

  test('items: newest first, filtered by type and level, paged by offset', async () => {
    const account = await learner();
    const base = Date.parse('2026-11-10T00:00:00Z');
    const at = (hours: number) => new Date(base + hours * 3_600_000);
    const fresh = await seedItem(t.db, account.userId, { type: 'word', display: 'fresh', lastSeenAt: at(5) });
    const learning = await seedItem(t.db, account.userId, { type: 'word', display: 'learning', lastSeenAt: at(4) });
    const mastered = await seedItem(t.db, account.userId, { type: 'phrase', display: 'mastered phrase', lastSeenAt: at(3) });
    const pending = await seedItem(t.db, account.userId, { type: 'grammar', display: 'pending grammar', status: 'pending', content: null, withCards: false, lastSeenAt: at(2) });
    await t.db.update(cards).set({ state: 2 }).where(eq(cards.id, learning.cardIds[0]!));
    await t.db.update(cards).set({ state: 2, mastered: true }).where(eq(cards.itemId, mastered.itemId));
    const other = await learner();
    await seedItem(t.db, other.userId, { type: 'word', display: 'fresher', lastSeenAt: at(9) });

    const all = (await get(account, '/v1/items')).json().data;
    assert.deepEqual(all.items.map((item: { display: string; level: string }) => [item.display, item.level]), [
      ['fresh', 'new'],
      ['learning', 'learning'],
      ['mastered phrase', 'mastered'],
      ['pending grammar', 'new'],
    ]);
    assert.deepEqual(all.items[0], { id: fresh.itemId, type: 'word', display: 'fresh', lookupCount: 1, errorCount: 0, level: 'new', stars: 0, lastSeenAt: at(5).toISOString() });
    assert.equal(all.nextOffset, null);

    const ids = async (query: string) => (await get(account, `/v1/items${query}`)).json().data.items.map((item: { id: string }) => item.id);
    assert.deepEqual(await ids('?type=word'), [fresh.itemId, learning.itemId]);
    assert.deepEqual(await ids('?level=new'), [fresh.itemId, pending.itemId]);
    assert.deepEqual(await ids('?level=mastered'), [mastered.itemId]);
    assert.deepEqual(await ids('?level=learning&type=word'), [learning.itemId]);
    assert.deepEqual(await ids('?type=grammar&level=mastered'), []);
    // v2: sentence items are a type filter of their own (none seeded here).
    assert.deepEqual(await ids('?type=sentence'), []);

    const first = (await get(account, '/v1/items?limit=3')).json().data;
    assert.equal(first.items.length, 3);
    assert.equal(first.nextOffset, 3);
    const second = (await get(account, '/v1/items?limit=3&offset=3')).json().data;
    assert.deepEqual(second.items.map((item: { id: string }) => item.id), [pending.itemId]);
    assert.equal(second.nextOffset, null);
    for (const query of ['?limit=51', '?limit=0', '?type=idiom', '?level=done', '?offset=-1']) {
      assert.equal((await get(account, `/v1/items${query}`)).statusCode, 400, query);
    }
  });

  test('items search: exact, then prefix, then trigram similarity; LIKE wildcards are literal', async () => {
    const account = await learner();
    for (const display of ['meticulous', 'meticulously', 'metal', 'immaculate', 'method', 'ridiculous', '100% sure', 'Meticulous care']) {
      await seedItem(t.db, account.userId, { type: 'word', display, withCards: false });
    }
    const other = await learner();
    await seedItem(t.db, other.userId, { type: 'word', display: 'meticulous', withCards: false });
    const search = async (q: string) =>
      (await get(account, `/v1/items?q=${encodeURIComponent(q)}`)).json().data.items.map((item: { display: string }) => item.display);

    const exact = await search('meticulous');
    assert.equal(exact[0], 'meticulous', 'the exact match comes first');
    assert.deepEqual(exact.slice(1, 3).sort(), ['Meticulous care', 'meticulously'], 'then prefix matches');
    assert.ok(!exact.includes('metal'));
    assert.equal(exact.filter((d: string) => d === 'meticulous').length, 1, "another account's item is never found");

    assert.deepEqual((await search('met')).slice(0, 5).sort(), ['Meticulous care', 'metal', 'method', 'meticulous', 'meticulously'], 'a short prefix');
    assert.ok((await search('meticulos')).includes('meticulous'), 'a misspelling still finds it (trigrams)');
    assert.deepEqual(await search('100%'), ['100% sure']);
    assert.deepEqual(await search('%'), [], '% is not a wildcard');
    assert.deepEqual(await search('zzzzzz'), []);
    assert.equal((await get(account, '/v1/items?q=')).json().data.items.length, 8, 'an empty q lists everything');
  });

  test('item detail: content, level, cards and the 10 latest sources; foreign or unknown → 404', async () => {
    const account = await learner();
    const word = await seedItem(t.db, account.userId, { type: 'word', display: 'meticulous', lookupCount: 12 });
    await t.db.update(cards).set({ state: 1 }).where(eq(cards.id, word.cardIds[0]!));
    const stored = [];
    for (let i = 0; i < 12; i += 1) {
      stored.push(makeEntry({ input: `meticulous ${i}`, createdAt: new Date(Date.parse('2026-11-01T09:00:00+08:00') + i * 86_400_000) }));
    }
    await insertEntries(t.db, account.userId, stored);
    for (const entry of stored) await seedSource(t.db, account.userId, word.itemId, entry.id);

    const res = await get(account, `/v1/items/${word.itemId}`);
    assert.equal(res.statusCode, 200);
    const item = res.json().data;
    assert.deepEqual(
      { id: item.id, type: item.type, display: item.display, status: item.status, lookupCount: item.lookupCount, level: item.level },
      { id: word.itemId, type: 'word', display: 'meticulous', status: 'ready', lookupCount: 12, level: 'learning' },
    );
    assert.equal(item.content.headword, 'meticulous');
    assert.deepEqual(item.cards.map((card: { cardType: string; state: string; suspended: boolean }) => [card.cardType, card.state, card.suspended]), [
      ['recognize', 'learning', false],
      ['produce', 'new', false],
      ['cloze', 'new', false],
    ]);
    assert.equal(item.sources.length, 10);
    assert.deepEqual(item.sources[0], { entryId: stored[11]!.id, input: 'meticulous 11', createdAt: stored[11]!.createdAt });
    assert.equal(item.sources[9].input, 'meticulous 2');

    const other = await learner();
    const theirs = await seedItem(t.db, other.userId, { type: 'word', display: 'their word' });
    for (const id of [theirs.itemId, ulid()]) {
      const missing = await get(account, `/v1/items/${id}`);
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error.code, 'NOT_FOUND');
      assert.ok(!missing.body.includes('their word'));
    }
  });

  test("entries of a local day: that day's records, oldest first, at the caller's offset", async () => {
    const account = await learner();
    const at = (iso: string, input: string) => makeEntry({ input, createdAt: new Date(iso) });
    const records = [
      at('2026-11-16T23:59:00+08:00', 'before midnight'),
      at('2026-11-17T00:00:00+08:00', 'at midnight'),
      at('2026-11-17T12:00:00+08:00', 'noon'),
      at('2026-11-17T23:59:59+08:00', 'last second'),
      at('2026-11-18T00:00:00+08:00', 'next day'),
    ];
    await insertEntries(t.db, account.userId, [records[2]!, records[0]!, records[4]!, records[3]!, records[1]!]);
    const other = await learner();
    await insertEntries(t.db, other.userId, [at('2026-11-17T10:00:00+08:00', 'their record')]);

    const day = (await get(account, '/v1/entries/day?date=2026-11-17')).json().data.entries;
    assert.deepEqual(day.map((entry: { input: string }) => entry.input), ['at midnight', 'noon', 'last second']);
    assert.equal(day[0].createdAt, records[1]!.createdAt);
    assert.equal(typeof day[0].seq, 'number');
    assert.deepEqual(Object.keys(day[0]).sort(), [...Object.keys(records[1]!), 'seq'].sort());

    // At UTC+0 the 17th runs from 08:00 to 08:00 the next day (+08:00).
    const utc = (await get(account, '/v1/entries/day?date=2026-11-17&utcOffsetMinutes=0')).json().data.entries;
    assert.deepEqual(utc.map((entry: { input: string }) => entry.input), ['noon', 'last second', 'next day']);
    for (const query of ['', '?date=2026-02-30', '?date=2026-11-17&utcOffsetMinutes=841']) {
      assert.equal((await get(account, `/v1/entries/day${query}`)).statusCode, 400, query);
    }
  });
});
