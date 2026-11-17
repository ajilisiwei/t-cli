import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createDb, runMigrations, type Database } from '../../src/db/client.ts';

/**
 * Integration tests need a PostgreSQL superuser URL (e.g. the local dev
 * instance: postgres://postgres@127.0.0.1:55433/postgres, or the CI service).
 * Without it the suites are skipped, so `npm test` still works offline.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const skipWithoutDb: string | false = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

export interface TestDatabase {
  db: Database;
  sql: postgres.Sql;
  url: string;
  drop(): Promise<void>;
}

/** Create a throwaway database with all migrations applied (one per test file). */
export async function createTestDatabase(): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  const name = `tcli_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const { db, sql } = createDb(url.toString(), { max: 10 });
  await runMigrations(db);
  return {
    db,
    sql,
    url: url.toString(),
    async drop() {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    },
  };
}
