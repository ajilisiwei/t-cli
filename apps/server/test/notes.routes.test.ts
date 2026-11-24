import { after, before, describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import { cards, items, itemSources, lexicon, notes } from '../src/db/schema.ts';
import { sentenceKey } from '../src/modules/notes/content.ts';
import { buildTestApp, fixedClock, testConfig, type TestClock } from './helpers/app.ts';
import { captureLogs } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import type { TestAccount } from './helpers/fixtures.ts';
import { createLearner, rate, seedItem } from './helpers/learning.ts';
import { deleteNote, lexiconEntry, putNote, saveNote, seedLexicon, type NoteJson } from './helpers/notes.ts';
import { cardsOf, seedRecords } from './helpers/pipeline.ts';

const MINUTE = 60_000;

describe('notes: the notebook API', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  async function setup(ctx: TestContext, { clock = fixedClock(), config = {} }: { clock?: TestClock; config?: Record<string, string> } = {}) {
    const app = await buildTestApp(t.db, { clock, config: testConfig(config) });
    ctx.after(() => app.close());
    const account = await createLearner(t.db, { now: clock() });
    return { app, account, clock };
  }

  const get = (app: FastifyInstance, account: TestAccount, url: string) => app.inject({ method: 'GET', url, headers: account.headers });
  const itemOf = async (userId: string, itemId: string | null) => {
    assert.ok(itemId, 'the note has an item');
    const [row] = await t.db.select().from(items).where(and(eq(items.userId, userId), eq(items.id, itemId)));
    assert.ok(row, 'the item exists');
    return row;
  };
  const list = async (app: FastifyInstance, account: TestAccount, query = '') =>
    (await get(app, account, `/v1/notes${query}`)).json().data as { notes: NoteJson[]; nextBefore: string | null; hasMore: boolean };
  const changes = async (app: FastifyInstance, account: TestAccount, query = '') =>
    (await get(app, account, `/v1/notes/changes${query}`)).json().data as { notes: NoteJson[]; nextAfter: number; hasMore: boolean };

  test('every route requires a valid access token', async (ctx) => {
    const { app } = await setup(ctx);
    const routes: [string, string][] = [
      ['PUT', `/v1/notes/${ulid()}`],
      ['DELETE', `/v1/notes/${ulid()}`],
      ['GET', '/v1/notes'],
      ['GET', '/v1/notes/changes'],
      ['GET', '/v1/notes/summary'],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as 'GET', url, payload: method === 'PUT' ? { kind: 'word', text: 'x', lang: 'en', stars: 1 } : undefined });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
  });

  test('PUT creates the note; a repeat changes nothing (same seq); a change gets a new seq', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const id = ulid();
    const entryId = ulid();
    const created = await saveNote(app, account, { kind: 'word', text: 'serendipity', translation: '意外发现', entryId }, id);
    assert.deepEqual(
      { ...created, itemId: typeof created.itemId },
      {
        id,
        kind: 'word',
        text: 'serendipity',
        translation: '意外发现',
        lang: 'en',
        stars: 1,
        lemma: null,
        entryId,
        itemId: 'string',
        seq: 1,
        createdAt: clock().toISOString(),
        updatedAt: clock().toISOString(),
        deletedAt: null,
        level: 'new',
        task: null,
      },
    );

    clock.advance(MINUTE);
    const repeated = await saveNote(app, account, { kind: 'word', text: 'serendipity', translation: '意外发现', entryId }, id);
    assert.deepEqual(repeated, created, 'nothing changed: the stored note, same seq and updatedAt');
    const absent = await saveNote(app, account, { kind: 'word', text: 'serendipity' }, id);
    assert.deepEqual(absent, created, 'absent fields are kept, so this changes nothing either');

    const restarred = await saveNote(app, account, { kind: 'word', text: 'serendipity', stars: 3 }, id);
    assert.equal(restarred.seq, 2);
    assert.equal(restarred.stars, 3);
    assert.equal(restarred.translation, '意外发现', 'kept when absent');
    assert.equal(restarred.entryId, entryId, 'kept when absent');
    assert.equal(restarred.updatedAt, clock().toISOString());
    assert.equal(restarred.createdAt, created.createdAt);

    const retranslated = await saveNote(app, account, { kind: 'word', text: 'serendipity', stars: 3, translation: '机缘巧合', lemma: 'serendipity' }, id);
    assert.deepEqual([retranslated.seq, retranslated.translation, retranslated.lemma], [3, '机缘巧合', 'serendipity']);
    assert.equal((await t.db.select().from(notes).where(eq(notes.userId, account.userId))).length, 1, 'one row per id');
  });

  test('409 NOTE_CONFLICT when the id exists with another kind, text or lang; 400 for a bad id or body', async (ctx) => {
    const { app, account } = await setup(ctx);
    const id = ulid();
    await saveNote(app, account, { kind: 'word', text: 'lucid' }, id);
    for (const body of [{ kind: 'phrase' as const, text: 'lucid' }, { kind: 'word' as const, text: 'Lucid' }]) {
      const res = await putNote(app, account, id, body);
      assert.equal(res.statusCode, 409, JSON.stringify(body));
      assert.equal(res.json().error.code, 'NOTE_CONFLICT');
    }
    // The same text in another form normalises to the stored one: not a conflict.
    assert.equal((await putNote(app, account, id, { kind: 'word', text: '  lucid ' })).statusCode, 200);

    assert.equal((await putNote(app, account, 'not-a-ulid', { kind: 'word', text: 'lucid' })).statusCode, 400);
    for (const body of [
      { kind: 'word' as const, text: 'lucid', stars: 5 },
      { kind: 'word' as const, text: 'lucid', lang: 'fr' },
      { kind: 'word' as const, text: 'lucid', color: 'red' },
      { kind: 'word' as const, text: '清楚' },
    ]) {
      const res = await putNote(app, account, ulid(), body);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
  });

  test('a word note with a lexicon entry: content built from it and cards made at once', async (ctx) => {
    const { app, account } = await setup(ctx);
    await seedLexicon(t.db, lexiconEntry('decision'));
    const note = await saveNote(app, account, { kind: 'word', text: 'decision', lemma: 'decision', translation: '决定', stars: 2 });
    const item = await itemOf(account.userId, note.itemId);
    assert.deepEqual(
      { type: item.type, normKey: item.normKey, display: item.display, status: item.status, stars: item.stars, lookupCount: item.lookupCount, model: item.model },
      { type: 'word', normKey: 'decision', display: 'decision', status: 'ready', stars: 2, lookupCount: 0, model: 'lexicon-model' },
    );
    assert.equal((item.content as { headword: string }).headword, 'decision');
    assert.equal((item.content as { ipa: string }).ipa, '/dɪˈsɪʒən/');
    const made = await cardsOf(t.db, account.userId, item.id);
    assert.deepEqual(made.map((card) => card.cardType).sort(), ['cloze', 'produce', 'recognize']);
    assert.ok(made.every((card) => card.state === 0 && !card.suspended));
    assert.equal((await t.db.select().from(itemSources).where(eq(itemSources.userId, account.userId))).length, 0, 'notes write no item_sources');
    const [row] = await t.db.select({ hits: lexicon.hits }).from(lexicon).where(eq(lexicon.lemma, 'decision'));
    assert.equal(row?.hits, 0, 'saving a note is not a lookup');
  });

  test('a word note keys its item by the lemma; without a lexicon entry (or in another language) it stays pending', async (ctx) => {
    const { app, account } = await setup(ctx);
    await seedLexicon(t.db, lexiconEntry('ephemeral'), { explainLang: 'en' });
    const inflected = await saveNote(app, account, { kind: 'word', text: 'Decisions', lemma: 'Decisions' });
    const withLemma = await saveNote(app, account, { kind: 'word', text: 'ephemerally', lemma: 'Ephemeral' });
    const inflectedItem = await itemOf(account.userId, inflected.itemId);
    const lemmaItem = await itemOf(account.userId, withLemma.itemId);
    assert.deepEqual([inflectedItem.normKey, inflectedItem.status, inflectedItem.content], ['decisions', 'pending', null]);
    assert.deepEqual([lemmaItem.normKey, lemmaItem.display, lemmaItem.status], ['ephemeral', 'Ephemeral', 'pending'], 'the entry is in en, the account explains in zh');
    assert.equal((await cardsOf(t.db, account.userId)).length, 0);
  });

  test('a word note joins the item the pipeline extracted; existing content is kept', async (ctx) => {
    const { app, account } = await setup(ctx);
    const seeded = await seedItem(t.db, account.userId, { type: 'word', display: 'meticulous', lookupCount: 4 });
    await seedLexicon(t.db, lexiconEntry('meticulous'));
    const [before] = await t.db.select().from(items).where(eq(items.id, seeded.itemId));
    const note = await saveNote(app, account, { kind: 'word', text: 'meticulous', stars: 4 });
    assert.equal(note.itemId, seeded.itemId);
    const item = await itemOf(account.userId, note.itemId);
    assert.deepEqual(item.content, before?.content, 'content not rebuilt');
    assert.equal(item.lookupCount, 4, 'lookupCount untouched');
    assert.equal(item.stars, 4);
    assert.equal((await cardsOf(t.db, account.userId, item.id)).length, 3, 'no extra cards');

    // A pending item without content (extracted, not generated yet) is filled from the lexicon.
    const pending = await seedItem(t.db, account.userId, { type: 'word', display: 'decision', status: 'pending', content: null, withCards: false });
    await seedLexicon(t.db, lexiconEntry('decision'));
    const filled = await saveNote(app, account, { kind: 'word', text: 'decision' });
    assert.equal(filled.itemId, pending.itemId);
    assert.equal((await itemOf(account.userId, filled.itemId)).status, 'ready');
    assert.equal((await cardsOf(t.db, account.userId, pending.itemId)).length, 3);
  });

  test('a phrase note → a pending phrase item under the pipeline phrase key', async (ctx) => {
    const { app, account } = await setup(ctx);
    const note = await saveNote(app, account, { kind: 'phrase', text: 'Look Forward To.', translation: '期待' });
    const item = await itemOf(account.userId, note.itemId);
    assert.deepEqual([item.type, item.normKey, item.display, item.status, item.content], ['phrase', 'look forward to', 'Look Forward To.', 'pending', null]);
    assert.equal((await cardsOf(t.db, account.userId, item.id)).length, 0);
  });

  test('a sentence note → a ready sentence item with one recall card; none without a translation, until one is added', async (ctx) => {
    const { app, account } = await setup(ctx);
    const text = 'It is never too late to learn.';
    const withTranslation = await saveNote(app, account, { kind: 'sentence', text, translation: '活到老，学到老。', lemma: 'ignored' });
    assert.equal(withTranslation.lemma, null, 'the lemma is ignored for sentences');
    const item = await itemOf(account.userId, withTranslation.itemId);
    assert.deepEqual(
      { type: item.type, normKey: item.normKey, display: item.display, status: item.status, content: item.content, model: item.model },
      { type: 'sentence', normKey: sentenceKey(text), display: text, status: 'ready', content: { text, translation: '活到老，学到老。' }, model: null },
    );
    const [card, ...more] = await cardsOf(t.db, account.userId, item.id);
    assert.equal(more.length, 0);
    assert.deepEqual([card?.cardType, card?.front, card?.back], ['recall', { text: '活到老，学到老。' }, { text }]);

    // The same sentence in another case and spacing is the same item.
    const again = await saveNote(app, account, { kind: 'sentence', text: 'it is never  too late to LEARN.' });
    assert.equal(again.itemId, item.id);

    const bare = await saveNote(app, account, { kind: 'sentence', text: 'Practice makes perfect.' });
    const bareItem = await itemOf(account.userId, bare.itemId);
    assert.deepEqual([bareItem.status, bareItem.content], ['ready', { text: 'Practice makes perfect.', translation: null }]);
    assert.equal((await cardsOf(t.db, account.userId, bareItem.id)).length, 0, 'nothing to recall from');

    await saveNote(app, account, { kind: 'sentence', text: 'Practice makes perfect.', translation: '熟能生巧。' }, bare.id);
    const recall = await cardsOf(t.db, account.userId, bareItem.id);
    assert.deepEqual(recall.map((c) => [c.cardType, c.front]), [['recall', { text: '熟能生巧。' }]]);
    assert.deepEqual((await itemOf(account.userId, bare.itemId)).content, { text: 'Practice makes perfect.', translation: '熟能生巧。' });

    // A corrected translation rewrites the same card's front (progress kept).
    await saveNote(app, account, { kind: 'sentence', text: 'Practice makes perfect.', translation: '熟能生巧！' }, bare.id);
    const rewritten = await cardsOf(t.db, account.userId, bareItem.id);
    assert.deepEqual(rewritten.map((c) => [c.id, c.front]), [[recall[0]!.id, { text: '熟能生巧！' }]]);
  });

  test('items.stars = the highest stars of live notes; DELETE recomputes it (0 when none is left)', async (ctx) => {
    const { app, account } = await setup(ctx);
    const a = await saveNote(app, account, { kind: 'word', text: 'resilient', stars: 2 });
    const b = await saveNote(app, account, { kind: 'word', text: 'resilience', lemma: 'resilient', stars: 4 });
    assert.equal(a.itemId, b.itemId);
    const starsOf = async () => (await itemOf(account.userId, a.itemId)).stars;
    assert.equal(await starsOf(), 4);
    await saveNote(app, account, { kind: 'word', text: 'resilience', lemma: 'resilient', stars: 1 }, b.id);
    assert.equal(await starsOf(), 2);
    assert.equal((await deleteNote(app, account, a.id)).statusCode, 200);
    assert.equal(await starsOf(), 1);
    assert.equal((await deleteNote(app, account, b.id)).statusCode, 200);
    assert.equal(await starsOf(), 0);
    assert.equal((await cardsOf(t.db, account.userId, a.itemId!)).length, 0, 'pending item: still no cards, item kept');
    assert.ok(await itemOf(account.userId, a.itemId), 'the item stays');

    // A new lemma moves the note to another item; the old one is recomputed too.
    const moving = await saveNote(app, account, { kind: 'word', text: 'ran', stars: 3 });
    const moved = await saveNote(app, account, { kind: 'word', text: 'ran', lemma: 'run', stars: 3 }, moving.id);
    assert.notEqual(moved.itemId, moving.itemId);
    assert.equal((await itemOf(account.userId, moving.itemId)).stars, 0);
    assert.equal((await itemOf(account.userId, moved.itemId)).stars, 3);
  });

  test('DELETE: soft delete with a new seq; repeat → same note; unknown or foreign → 404; PUT revives', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const other = await createLearner(t.db, { now: clock() });
    const note = await saveNote(app, account, { kind: 'sentence', text: 'See you soon.', translation: '回头见。', stars: 3 });
    const recall = await cardsOf(t.db, account.userId, note.itemId!);
    clock.advance(MINUTE);

    const res = await deleteNote(app, account, note.id);
    assert.equal(res.statusCode, 200);
    const deleted = res.json().data.note as NoteJson;
    assert.deepEqual([deleted.seq, deleted.deletedAt, deleted.updatedAt], [2, clock().toISOString(), clock().toISOString()]);
    clock.advance(MINUTE);
    assert.deepEqual((await deleteNote(app, account, note.id)).json().data.note, deleted, 'already deleted: no new seq');
    assert.deepEqual(await cardsOf(t.db, account.userId, note.itemId!), recall, 'cards and their history stay');

    for (const [who, id] of [[account, ulid()], [other, note.id], [account, 'not-a-ulid']] as const) {
      const missing = await deleteNote(app, who, id);
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error.code, 'NOT_FOUND');
    }

    const revived = await saveNote(app, account, { kind: 'sentence', text: 'See you soon.', stars: 3 }, note.id);
    assert.deepEqual([revived.seq, revived.deletedAt, revived.stars, revived.translation], [3, null, 3, '回头见。']);
    assert.equal((await itemOf(account.userId, note.itemId)).stars, 3);
  });

  test('GET /v1/notes: live notes newest first, filtered by kind and stars, paged by before', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const other = await createLearner(t.db, { now: clock() });
    await saveNote(app, other, { kind: 'word', text: 'foreign' });
    const at = (minutes: number) => ulid({ time: clock().getTime() + minutes * MINUTE });
    const ids = { w1: at(1), p2: at(2), s3: at(3), w4: at(4), w5: at(5) };
    await saveNote(app, account, { kind: 'word', text: 'alpha', stars: 1 }, ids.w1);
    await saveNote(app, account, { kind: 'phrase', text: 'by and large', stars: 2 }, ids.p2);
    await saveNote(app, account, { kind: 'sentence', text: 'Gamma ray.', stars: 2 }, ids.s3);
    await saveNote(app, account, { kind: 'word', text: 'delta', stars: 4 }, ids.w4);
    await saveNote(app, account, { kind: 'word', text: 'epsilon', stars: 4 }, ids.w5);
    await deleteNote(app, account, ids.w4);

    const all = await list(app, account);
    assert.deepEqual(all.notes.map((n) => n.id), [ids.w5, ids.s3, ids.p2, ids.w1]);
    assert.deepEqual([all.nextBefore, all.hasMore], [null, false]);
    assert.deepEqual((await list(app, account, '?kind=word')).notes.map((n) => n.id), [ids.w5, ids.w1]);
    assert.deepEqual((await list(app, account, '?stars=2')).notes.map((n) => n.id), [ids.s3, ids.p2]);
    assert.deepEqual((await list(app, account, '?kind=sentence&stars=2')).notes.map((n) => n.id), [ids.s3]);

    const first = await list(app, account, '?limit=3');
    assert.deepEqual([first.notes.map((n) => n.id), first.nextBefore, first.hasMore], [[ids.w5, ids.s3, ids.p2], ids.p2, true]);
    const second = await list(app, account, `?limit=3&before=${first.nextBefore}`);
    assert.deepEqual([second.notes.map((n) => n.id), second.nextBefore, second.hasMore], [[ids.w1], null, false]);

    for (const query of ['?limit=0', '?limit=101', '?stars=5', '?kind=idiom', '?before=nope']) {
      assert.equal((await get(app, account, `/v1/notes${query}`)).statusCode, 400, query);
    }
  });

  test('GET /v1/notes/changes: every change by seq, deletions included, in its latest state', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const other = await createLearner(t.db, { now: clock() });
    await saveNote(app, other, { kind: 'word', text: 'foreign' });
    const a = await saveNote(app, account, { kind: 'word', text: 'apple' }); // seq 1
    const b = await saveNote(app, account, { kind: 'word', text: 'banana' }); // seq 2
    await saveNote(app, account, { kind: 'word', text: 'apple', stars: 2 }, a.id); // seq 3
    await deleteNote(app, account, b.id); // seq 4
    const c = await saveNote(app, account, { kind: 'phrase', text: 'cherry on top' }); // seq 5

    const page = await changes(app, account);
    assert.deepEqual(page.notes.map((n) => [n.id, n.seq]), [[a.id, 3], [b.id, 4], [c.id, 5]]);
    assert.ok(page.notes[1]!.deletedAt, 'the deletion is carried');
    assert.deepEqual([page.nextAfter, page.hasMore], [5, false]);

    const first = await changes(app, account, '?after=0&limit=2');
    assert.deepEqual([first.notes.map((n) => n.seq), first.nextAfter, first.hasMore], [[3, 4], 4, true]);
    const rest = await changes(app, account, `?after=${first.nextAfter}&limit=2`);
    assert.deepEqual([rest.notes.map((n) => n.seq), rest.nextAfter, rest.hasMore], [[5], 5, false]);
    assert.deepEqual(await changes(app, account, '?after=5'), { notes: [], nextAfter: 5, hasMore: false });
    for (const query of ['?after=-1', '?limit=0', '?limit=501', '?after=x']) {
      assert.equal((await get(app, account, `/v1/notes/changes${query}`)).statusCode, 400, query);
    }
  });

  test('level and task are derived at read time and never bump seq', async (ctx) => {
    const { app, account, clock } = await setup(ctx);
    const other = await createLearner(t.db, { now: clock() });
    const [check] = await seedRecords(t.db, account.userId, [
      { input: 'He go home.', output: 'He goes home.', task: 'check', at: '2026-11-17T09:00:00+08:00' },
    ]);
    const [translate] = await seedRecords(t.db, account.userId, [{ input: 'He goes home.', output: '他回家了。', at: '2026-11-17T09:01:00+08:00' }]);
    // Another account's record with the id a note points at never shows.
    const [foreign] = await seedRecords(t.db, other.userId, [{ input: 'x y z', output: 'x', at: '2026-11-17T09:02:00+08:00' }]);
    assert.ok(check && translate && foreign);

    const fromCheck = await saveNote(app, account, { kind: 'sentence', text: 'He goes home.', translation: '他回家。', entryId: check.id });
    const fromTranslate = await saveNote(app, account, { kind: 'phrase', text: 'go home', entryId: translate.id });
    const unpushed = await saveNote(app, account, { kind: 'word', text: 'home', entryId: ulid() });
    const fromForeign = await saveNote(app, account, { kind: 'word', text: 'zed', entryId: foreign.id });
    const byId = async () => new Map((await list(app, account)).notes.map((n) => [n.id, n]));

    let notesNow = await byId();
    assert.deepEqual(
      [fromCheck, fromTranslate, unpushed, fromForeign].map((n) => [notesNow.get(n.id)?.task, notesNow.get(n.id)?.level]),
      [['check', 'new'], ['translate', 'new'], [null, 'new'], [null, 'new']],
    );

    // Rating the recall card makes the sentence item `learning`; seq stays.
    const [recall] = await cardsOf(t.db, account.userId, fromCheck.itemId!);
    assert.ok(recall);
    await rate(app, account, clock, recall.id, 3);
    notesNow = await byId();
    assert.equal(notesNow.get(fromCheck.id)?.level, 'learning');
    assert.equal(notesNow.get(fromCheck.id)?.seq, fromCheck.seq);
    await t.db.update(cards).set({ mastered: true }).where(and(eq(cards.userId, account.userId), eq(cards.id, recall.id)));
    const synced = new Map((await changes(app, account)).notes.map((n) => [n.id, n]));
    assert.equal(synced.get(fromCheck.id)?.level, 'mastered');
    assert.equal(synced.get(fromCheck.id)?.task, 'check');
  });

  test('GET /v1/notes/summary: live notes by kind and level, and this local week since Monday', async (ctx) => {
    // Wednesday 2026-11-18 10:00 at UTC+8; the week started Monday 2026-11-16 00:00 (+08:00).
    const clock = fixedClock(new Date('2026-11-18T10:00:00+08:00'));
    const { app, account } = await setup(ctx, { clock });
    const other = await createLearner(t.db, { now: clock() });
    await saveNote(app, other, { kind: 'word', text: 'foreign' });

    clock.set(new Date('2026-11-15T23:30:00+08:00')); // last Sunday
    await saveNote(app, account, { kind: 'word', text: 'old' });
    clock.set(new Date('2026-11-16T00:30:00+08:00')); // this Monday
    const monday = await saveNote(app, account, { kind: 'sentence', text: 'New week.', translation: '新的一周。' });
    clock.set(new Date('2026-11-18T09:00:00+08:00'));
    await saveNote(app, account, { kind: 'phrase', text: 'kick off' });
    const gone = await saveNote(app, account, { kind: 'word', text: 'gone' });
    await deleteNote(app, account, gone.id);
    const [recall] = await cardsOf(t.db, account.userId, monday.itemId!);
    await rate(app, account, clock, recall!.id, 3);
    clock.set(new Date('2026-11-18T10:00:00+08:00'));

    const summary = async (query = '') => (await get(app, account, `/v1/notes/summary${query}`)).json().data;
    assert.deepEqual(await summary(), {
      total: 3,
      thisWeek: 2,
      kinds: { word: 1, phrase: 1, sentence: 1 },
      levels: { new: 2, learning: 1, mastered: 0 },
    });
    // At UTC+0 the week started Monday 00:00Z: the Monday 00:30 (+08:00) note is still last week.
    assert.equal((await summary('?utcOffsetMinutes=0')).thisWeek, 1);
    assert.equal((await get(app, account, '/v1/notes/summary?utcOffsetMinutes=900')).statusCode, 400);
  });

  test('logs never contain the note text or translation', async (ctx) => {
    const clock = fixedClock();
    const traced = await buildTestApp(t.db, { clock, config: testConfig({ LOG_LEVEL: 'trace' }) });
    ctx.after(() => traced.close());
    const logs = captureLogs(traced);
    const account = await createLearner(t.db, { now: clock() });
    const note = await saveNote(traced, account, { kind: 'sentence', text: 'Private sentence xyzzy.', translation: '私密译文' });
    await saveNote(traced, account, { kind: 'word', text: 'plugh', translation: '秘密' });
    await deleteNote(traced, account, note.id);
    await get(traced, account, '/v1/notes?kind=sentence');
    const text = logs.text();
    assert.ok(text.includes('note saved') && text.includes('note deleted'));
    for (const secret of ['xyzzy', '私密译文', 'plugh', '秘密']) assert.ok(!text.includes(secret), secret);
  });
});
