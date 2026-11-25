import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import { lookupEvents, materials, users } from '../src/db/schema.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount } from './helpers/fixtures.ts';

describe('migration 0003_v3_learn', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test('lookup_events has the documented columns and indexes, and no user text column', async () => {
    const columns = await t.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns where table_name = 'lookup_events' order by ordinal_position`;
    assert.deepEqual(
      columns.map((column) => [column.column_name, column.is_nullable]),
      [
        ['user_id', 'NO'],
        ['id', 'NO'],
        ['lemma_key', 'NO'],
        ['explain_lang', 'NO'],
        ['created_at', 'NO'],
        ['merged_at', 'YES'],
      ],
    );
    const indexes = await t.sql<{ indexname: string }[]>`select indexname from pg_indexes where tablename = 'lookup_events' order by indexname`;
    assert.deepEqual(
      indexes.map((index) => index.indexname),
      ['lookup_events_unmerged_idx', 'lookup_events_user_created_idx', 'lookup_events_user_id_id_pk'],
    );
  });

  test('materials accept digest and extend and a nullable read_at; deleting the account cascades', async () => {
    const { userId } = await createAccount(t.db);
    await t.db.insert(materials).values([
      { userId, kind: 'digest', date: '2026-11-22', content: { a: 1 } },
      { userId, kind: 'extend', date: '2026-11-23', content: { b: 2 }, readAt: new Date('2026-11-23T10:00:00Z') },
    ]);
    await t.db.insert(lookupEvents).values({ userId, id: ulid(), lemmaKey: 'decision', explainLang: 'zh' });

    const rows = await t.db.select({ kind: materials.kind, readAt: materials.readAt }).from(materials).where(eq(materials.userId, userId));
    assert.deepEqual(
      rows.map((row) => [row.kind, row.readAt?.toISOString() ?? null]).sort(),
      [
        ['digest', null],
        ['extend', '2026-11-23T10:00:00.000Z'],
      ],
    );

    await t.db.delete(users).where(eq(users.id, userId));
    assert.equal((await t.db.select().from(lookupEvents).where(eq(lookupEvents.userId, userId))).length, 0);
    assert.equal((await t.db.select().from(materials).where(eq(materials.userId, userId))).length, 0);
  });
});
