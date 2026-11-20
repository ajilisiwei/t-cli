import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { insertEntries, listEntriesAfter, offsetMinutesOf, toIsoWithOffset } from '../src/db/entriesRepo.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount, makeEntry } from './helpers/fixtures.ts';

test('offsetMinutesOf / toIsoWithOffset round-trip the client offset', () => {
  assert.equal(offsetMinutesOf('2026-11-17T09:12:03+08:00'), 480);
  assert.equal(offsetMinutesOf('2026-11-17T09:12:03-05:30'), -330);
  assert.equal(offsetMinutesOf('2026-11-17T01:12:03Z'), 0);
  const iso = '2026-11-17T09:12:03+08:00';
  assert.equal(toIsoWithOffset(new Date(iso), 480), iso);
  assert.equal(toIsoWithOffset(new Date('2026-11-17T09:12:03-05:30'), -330), '2026-11-17T09:12:03-05:30');
});

describe('entries repository', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test('insert assigns consecutive seq and is idempotent by id', async () => {
    const { userId } = await createAccount(t.db);
    const batch = [makeEntry(), makeEntry(), makeEntry()];
    const first = await insertEntries(t.db, userId, batch);
    assert.deepEqual(first, { accepted: batch.map((e) => e.id), inserted: 3, lastSeq: 3 });

    const again = await insertEntries(t.db, userId, [...batch, makeEntry()]);
    assert.equal(again.inserted, 1, 'only the new entry is stored');
    assert.equal(again.lastSeq, 4, 'no seq is wasted on duplicates');
    assert.equal(again.accepted.length, 4, 'duplicates are still acknowledged');
  });

  test('duplicate ids inside one batch are stored once', async () => {
    const { userId } = await createAccount(t.db);
    const entry = makeEntry();
    const result = await insertEntries(t.db, userId, [entry, entry]);
    assert.equal(result.inserted, 1);
    assert.deepEqual(result.accepted, [entry.id]);
  });

  test('pull returns the original entry (incl. offset and correctedInput) in seq order', async () => {
    const { userId } = await createAccount(t.db);
    const misspelled = makeEntry({ input: 'prioritiz', output: 'prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑' });
    const plain = makeEntry();
    await insertEntries(t.db, userId, [misspelled, plain]);
    const page = await listEntriesAfter(t.db, userId, { after: 0, limit: 10 });
    assert.deepEqual(page.entries.map(({ seq, ...entry }) => entry), [misspelled, plain]);
    assert.deepEqual(page.entries.map((e) => e.seq), [1, 2]);
    assert.equal(page.entries[0]?.correctedInput, 'prioritize');
  });

  test('pull pages with after/limit', async () => {
    const { userId } = await createAccount(t.db);
    await insertEntries(t.db, userId, Array.from({ length: 5 }, () => makeEntry()));
    const first = await listEntriesAfter(t.db, userId, { after: 0, limit: 2 });
    assert.deepEqual([first.entries.length, first.nextAfter, first.hasMore], [2, 2, true]);
    const last = await listEntriesAfter(t.db, userId, { after: 4, limit: 2 });
    assert.deepEqual([last.entries.length, last.nextAfter, last.hasMore], [1, 5, false]);
    const empty = await listEntriesAfter(t.db, userId, { after: 5, limit: 2 });
    assert.deepEqual([empty.entries.length, empty.nextAfter, empty.hasMore], [0, 5, false]);
  });

  test('accounts are isolated: same entry id, separate rows and counters', async () => {
    const a = await createAccount(t.db);
    const b = await createAccount(t.db);
    const shared = makeEntry();
    await insertEntries(t.db, a.userId, [shared]);
    const forB = await insertEntries(t.db, b.userId, [shared]);
    assert.equal(forB.inserted, 1, 'the same id under another account is a different row');
    assert.equal((await listEntriesAfter(t.db, a.userId, { after: 0, limit: 10 })).entries.length, 1);
    assert.equal((await listEntriesAfter(t.db, b.userId, { after: 0, limit: 10 })).entries.length, 1);
  });

  test('unknown or deleted account is rejected', async () => {
    await assert.rejects(insertEntries(t.db, 'no-such-user', [makeEntry()]), /account not found/);
  });

  test('concurrent writers never let a cursor-based reader skip a row', async () => {
    const { userId } = await createAccount(t.db);
    const writers = 40;
    const seen = new Set<string>();
    let cursor = 0;
    let writing = true;

    // A reader that keeps pulling with its cursor while writers commit.
    const reader = (async () => {
      while (writing) {
        const page = await listEntriesAfter(t.db, userId, { after: cursor, limit: 100 });
        for (const entry of page.entries) seen.add(entry.id);
        cursor = page.nextAfter;
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    const batches = Array.from({ length: writers }, () => [makeEntry(), makeEntry()]);
    try {
      await Promise.all(batches.map((batch) => insertEntries(t.db, userId, batch)));
    } finally {
      writing = false;
      await reader;
    }
    // Final catch-up pull, exactly as a client would on its next sync.
    for (;;) {
      const page = await listEntriesAfter(t.db, userId, { after: cursor, limit: 100 });
      for (const entry of page.entries) seen.add(entry.id);
      cursor = page.nextAfter;
      if (!page.hasMore) break;
    }

    assert.equal(seen.size, writers * 2, 'every committed entry was observed through the cursor');
    const all = await listEntriesAfter(t.db, userId, { after: 0, limit: 500 });
    assert.deepEqual(all.entries.map((e) => e.seq), Array.from({ length: writers * 2 }, (_, i) => i + 1), 'seq has no gaps');
  });
});
