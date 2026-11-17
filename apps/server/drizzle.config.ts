import { defineConfig } from 'drizzle-kit';

// Only `drizzle-kit generate` uses this (it diffs the schema, no DB needed).
// Migrations are applied by src/db/migrate.ts at deploy time.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
});
