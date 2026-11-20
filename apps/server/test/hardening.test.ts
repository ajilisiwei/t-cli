import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { FastifyInstance } from 'fastify';
import { aiUsage } from '../src/db/schema.ts';
import { loggableError } from '../src/http/errors.ts';
import { createLlmClient } from '../src/modules/ai/llm.ts';
import { buildTestApp, testConfig } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount } from './helpers/fixtures.ts';

const PRIVATE = 'my private sentence about the merger';

test('loggableError: a database error keeps class, SQLSTATE and frames, never its params', () => {
  const cause = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', name: 'PostgresError' });
  // A multi-line param whose second line looks like a stack frame start.
  const error = new DrizzleQueryError('insert into "entries" ("input") values ($1)', [`${PRIVATE}\n    at least we tried`], cause);
  const logged = loggableError(error);
  const serialized = JSON.stringify(logged);
  assert.equal(logged.errName, 'DrizzleQueryError');
  assert.equal(logged.sqlState, '23505');
  assert.ok(logged.frames && logged.frames.length > 0, 'real stack frames are kept');
  assert.ok(!serialized.includes('merger'), 'param values are not logged');
  assert.ok(!serialized.includes('least we tried'), 'a param line shaped like "at ..." is not mistaken for a frame');
  assert.ok(!serialized.includes('insert into'), 'the query text is not logged');
});

test('loggableError: plain errors log no message either', () => {
  const logged = loggableError(new Error(`could not process ${PRIVATE}`));
  assert.equal(logged.errName, 'Error');
  assert.ok(!JSON.stringify(logged).includes('merger'));
});

describe('hardening', { skip: skipWithoutDb }, () => {
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

  test('per-IP limits use the address nginx appends, so a spoofed X-Forwarded-For does not help', async () => {
    let limited = 0;
    for (let i = 0; i < 40; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/device/start',
        // The client controls everything left of the last entry.
        headers: { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` },
        payload: { deviceName: 'spoof test' },
      });
      if (response.statusCode === 429) limited += 1;
    }
    assert.ok(limited > 0, 'rotating the spoofable part must not evade the per-IP limit');
  });

  test('AI proxy without an API key answers 503 and does not charge the daily quota', async () => {
    const config = testConfig();
    const noKeyApp = await buildTestApp(t.db, { config, llm: createLlmClient(config) });
    try {
      const account = await createAccount(t.db);
      const response = await noKeyApp.inject({
        method: 'POST',
        url: '/v1/ai/translate',
        headers: account.headers,
        payload: { text: 'hello', task: 'translate' },
      });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'AI_UNAVAILABLE');
      assert.equal((await t.db.select().from(aiUsage)).length, 0, 'no quota row was written');
    } finally {
      await noKeyApp.close();
    }
  });
});
