import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('loadConfig: applies defaults', () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://u@h:5432/db', JWT_SECRET: 'x'.repeat(32) });
  assert.equal(config.PORT, 3000);
  assert.equal(config.AI_REQUESTS_PER_DAY, 200);
  assert.equal(config.MIGRATE_ON_START, false);
});

test('loadConfig: names invalid variables without echoing their values', () => {
  const secret = 'short-secret-value';
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'not a url', JWT_SECRET: secret }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /JWT_SECRET/);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});
