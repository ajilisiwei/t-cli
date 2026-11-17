import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.ts';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export function createDb(url: string, { max = 5 }: { max?: number } = {}) {
  // statement_timeout keeps a runaway query from hogging the instance this
  // app shares with another project.
  const sql = postgres(url, {
    max,
    onnotice: () => {},
    connection: { statement_timeout: 5000, application_name: 't-cli-server' },
  });
  const db = drizzle(sql, { schema, casing: 'snake_case' });
  return { db, sql };
}

export type Database = ReturnType<typeof createDb>['db'];
/** A database handle or an open transaction — repository functions accept both. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
