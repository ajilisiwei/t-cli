/**
 * Apply pending migrations and exit: `npm run db:migrate -w @t-cli/server`.
 * Reads DATABASE_URL from the environment.
 */
import { createDb, runMigrations } from './client.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(1);
}

const { db, sql } = createDb(url, { max: 1 });
try {
  await runMigrations(db);
  process.stdout.write('migrations applied\n');
} catch (error) {
  process.stderr.write(`migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
