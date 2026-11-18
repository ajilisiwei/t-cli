import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('loadConfig: applies defaults', () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://u@h:5432/db', JWT_SECRET: 'x'.repeat(32) });
  assert.equal(config.PORT, 3000);
  assert.equal(config.AI_REQUESTS_PER_DAY, 200);
  assert.equal(config.MIGRATE_ON_START, false);
  assert.equal(config.WECHAT_DEV_LOGIN, false);
  assert.equal(config.TTS_ENABLED, true);
  assert.equal(config.TTS_REQUESTS_PER_MINUTE, 30);
  assert.equal(config.TTS_TIMEOUT_MS, 15_000);
  assert.equal(config.TTS_CACHE_MAX_BYTES, 16 * 1024 * 1024);
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

const BASE = { DATABASE_URL: 'postgres://u@h:5432/db', JWT_SECRET: 'x'.repeat(32) };

test('loadConfig: WECHAT_DEV_LOGIN is refused in production', () => {
  for (const value of ['1', 'true']) {
    assert.throws(
      () => loadConfig({ ...BASE, NODE_ENV: 'production', WECHAT_DEV_LOGIN: value }),
      (error: unknown) => error instanceof Error && /^Invalid configuration: WECHAT_DEV_LOGIN$/.test(error.message),
    );
  }
  assert.equal(loadConfig({ ...BASE, NODE_ENV: 'production', WECHAT_DEV_LOGIN: '0' }).WECHAT_DEV_LOGIN, false);
  assert.equal(loadConfig({ ...BASE, NODE_ENV: 'production' }).WECHAT_DEV_LOGIN, false);
  for (const NODE_ENV of ['development', 'test']) {
    assert.equal(loadConfig({ ...BASE, NODE_ENV, WECHAT_DEV_LOGIN: '1' }).WECHAT_DEV_LOGIN, true, NODE_ENV);
  }
  // NODE_ENV defaults to development.
  assert.equal(loadConfig({ ...BASE, WECHAT_DEV_LOGIN: '1' }).WECHAT_DEV_LOGIN, true);
});

test('loadConfig: TTS settings are validated', () => {
  const tts = loadConfig({ ...BASE, TTS_ENABLED: 'false', TTS_REQUESTS_PER_MINUTE: '5', TTS_TIMEOUT_MS: '8000', TTS_CACHE_MAX_BYTES: '0' });
  assert.deepEqual(
    [tts.TTS_ENABLED, tts.TTS_REQUESTS_PER_MINUTE, tts.TTS_TIMEOUT_MS, tts.TTS_CACHE_MAX_BYTES],
    [false, 5, 8000, 0],
  );
  for (const [name, value] of [
    ['TTS_ENABLED', 'maybe'],
    ['TTS_REQUESTS_PER_MINUTE', '0'],
    ['TTS_TIMEOUT_MS', '10'],
    ['TTS_CACHE_MAX_BYTES', '-1'],
    ['TTS_CACHE_MAX_BYTES', String(1024 * 1024 * 1024)],
  ] as const) {
    assert.throws(() => loadConfig({ ...BASE, [name]: value }), new RegExp(name), `${name}=${value}`);
  }
});
