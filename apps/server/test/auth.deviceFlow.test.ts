import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { deviceAuthRequests, devices } from '../src/db/schema.ts';
import { DEVICE_CODE_TTL_SECONDS, DEVICE_POLL_INTERVAL_SECONDS } from '../src/modules/auth/deviceFlow.ts';
import { AUTH_IP_LIMIT_PER_MINUTE, DEVICE_APPROVE_LIMIT_PER_MINUTE } from '../src/modules/auth/routes.ts';
import { buildTestApp, fixedClock, type TestClock } from './helpers/app.ts';
import { bearer, getDevice, nextIp, softDeleteUser, type TokenPairBody } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount, type TestAccount } from './helpers/fixtures.ts';

interface Started {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
  qrPayload: string;
}

describe('auth: CLI device authorization', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let clock: TestClock;

  const start = async (deviceName = 'MacBook t-cli', ip = nextIp()): Promise<Started> => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/device/start', payload: { deviceName }, remoteAddress: ip });
    assert.equal(res.statusCode, 200);
    return res.json().data;
  };
  const poll = (deviceCode: string, ip = nextIp()) =>
    app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode }, remoteAddress: ip });
  const approve = (account: TestAccount, userCode: string, decision = true) =>
    app.inject({ method: 'POST', url: '/v1/auth/device/approve', headers: account.headers, payload: { userCode, approve: decision } });
  const expectPollError = async (deviceCode: string, code: string) => {
    const res = await poll(deviceCode);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, code);
  };
  const waitInterval = () => clock.advance(DEVICE_POLL_INTERVAL_SECONDS * 1000);

  before(async () => {
    t = await createTestDatabase();
    clock = fixedClock();
    app = await buildTestApp(t.db, { clock });
  });
  after(async () => {
    await app?.close();
    await t?.drop();
  });

  test('start returns the codes and stores only a hash of the device code', async () => {
    const started = await start();
    assert.match(started.deviceCode, /^[A-Za-z0-9_-]{43}$/);
    assert.match(started.userCode, /^\d{6}$/);
    assert.equal(started.expiresIn, DEVICE_CODE_TTL_SECONDS);
    assert.equal(started.interval, DEVICE_POLL_INTERVAL_SECONDS);
    assert.equal(started.qrPayload, `tcli://device?code=${started.userCode}`);

    const [row] = await t.db.select().from(deviceAuthRequests).where(eq(deviceAuthRequests.userCode, started.userCode));
    assert.equal(row?.deviceCodeHash, createHash('sha256').update(started.deviceCode).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(started.deviceCode));
    assert.equal(row?.expiresAt.getTime(), clock().getTime() + DEVICE_CODE_TTL_SECONDS * 1000);
  });

  test('start validates the device name', async () => {
    for (const payload of [{}, { deviceName: '' }, { deviceName: '   ' }, { deviceName: 'x'.repeat(65) }]) {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/device/start', payload, remoteAddress: nextIp() });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
  });

  test('full flow: pending, slow_down, approve, tokens exactly once', async () => {
    const owner = await createAccount(t.db, { now: clock() });
    const started = await start('work laptop');

    await expectPollError(started.deviceCode, 'authorization_pending');
    await expectPollError(started.deviceCode, 'slow_down');
    waitInterval();
    await expectPollError(started.deviceCode, 'authorization_pending');

    const approved = await approve(owner, started.userCode);
    assert.equal(approved.statusCode, 200);
    assert.deepEqual(approved.json().data, { deviceName: 'work laptop', approved: true });

    waitInterval();
    const res = await poll(started.deviceCode);
    assert.equal(res.statusCode, 200);
    const pair: TokenPairBody = res.json().data;
    assert.equal(pair.user.id, owner.userId);
    assert.equal(pair.user.role, 'member');
    const device = await getDevice(t.db, pair.deviceId);
    assert.equal(device?.kind, 'cli');
    assert.equal(device?.name, 'work laptop');
    assert.equal(device?.userId, owner.userId);

    waitInterval();
    await expectPollError(started.deviceCode, 'expired_token');

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(pair.accessToken) });
    assert.equal(me.json().data.id, owner.userId);
    const refreshed = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: pair.refreshToken } });
    assert.equal(refreshed.statusCode, 200);
  });

  test('two concurrent polls of an approved request get tokens only once', async () => {
    const owner = await createAccount(t.db, { now: clock() });
    const started = await start('race');
    await approve(owner, started.userCode);

    const results = await Promise.all(Array.from({ length: 4 }, () => poll(started.deviceCode)));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 400, 400, 400]);
    for (const res of results.filter((r) => r.statusCode === 400)) assert.equal(res.json().error.code, 'expired_token');
    const cliDevices = await t.db.select().from(devices).where(and(eq(devices.userId, owner.userId), eq(devices.kind, 'cli'), eq(devices.name, 'race')));
    assert.equal(cliDevices.length, 1);
  });

  test('a denied request answers access_denied', async () => {
    const owner = await createAccount(t.db, { now: clock() });
    const started = await start();
    const denied = await approve(owner, started.userCode, false);
    assert.equal(denied.statusCode, 200);
    assert.equal(denied.json().data.approved, false);
    await expectPollError(started.deviceCode, 'access_denied');
    assert.equal((await approve(owner, started.userCode)).statusCode, 404, 'a decided request cannot be re-decided');
  });

  test('an expired request answers expired_token and cannot be approved', async () => {
    const owner = await createAccount(t.db, { now: clock() });
    const started = await start();
    clock.advance(DEVICE_CODE_TTL_SECONDS * 1000 + 1000);
    await expectPollError(started.deviceCode, 'expired_token');
    const res = await approve(owner, started.userCode);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
  });

  test('an approved request that expires before the poll is expired_token', async () => {
    const owner = await createAccount(t.db, { now: clock() });
    const started = await start();
    await approve(owner, started.userCode);
    clock.advance(DEVICE_CODE_TTL_SECONDS * 1000 + 1000);
    await expectPollError(started.deviceCode, 'expired_token');
  });

  test('approve: unknown, malformed or already approved codes are 404', async () => {
    const owner = await createAccount(t.db, { now: clock() });
    const other = await createAccount(t.db, { now: clock() });
    const started = await start();
    assert.equal((await approve(owner, started.userCode)).statusCode, 200);
    assert.equal((await approve(other, started.userCode)).statusCode, 404, 'cannot hijack an approved request');

    const pending = new Set((await t.db.select({ code: deviceAuthRequests.userCode }).from(deviceAuthRequests)).map((r) => r.code));
    const unknown = ['000000', '999999', '123456'].find((code) => !pending.has(code))!;
    for (const userCode of [unknown, 'abc', '12345', '1234567']) {
      const res = await approve(owner, userCode);
      assert.equal(res.statusCode, 404, userCode);
      assert.equal(res.json().error.code, 'NOT_FOUND');
    }
  });

  test('approve requires authentication and an active account', async () => {
    const started = await start();
    const anonymous = await app.inject({ method: 'POST', url: '/v1/auth/device/approve', payload: { userCode: started.userCode, approve: true } });
    assert.equal(anonymous.statusCode, 401);

    const deleted = await createAccount(t.db, { now: clock() });
    await softDeleteUser(t.db, deleted.userId, clock());
    assert.equal((await approve(deleted, started.userCode)).statusCode, 401);
    const [row] = await t.db.select().from(deviceAuthRequests).where(eq(deviceAuthRequests.userCode, started.userCode));
    assert.equal(row?.status, 'pending');
  });

  test('an unknown device code is expired_token', async () => {
    await expectPollError('A'.repeat(43), 'expired_token');
    const empty = await poll('');
    assert.equal(empty.json().error.code, 'VALIDATION_FAILED');
  });

  test(`approve is limited to ${DEVICE_APPROVE_LIMIT_PER_MINUTE} attempts per account per minute`, async () => {
    const guesser = await createAccount(t.db, { now: clock() });
    const bystander = await createAccount(t.db, { now: clock() });
    for (let i = 0; i < DEVICE_APPROVE_LIMIT_PER_MINUTE; i += 1) {
      assert.equal((await approve(guesser, '000001')).statusCode, 404);
    }
    const limited = await approve(guesser, '000001');
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
    assert.ok(limited.json().error.details.retryAfterSeconds > 0);
    assert.equal((await approve(bystander, '000001')).statusCode, 404, 'other accounts are unaffected');
    clock.advance(60_000);
    assert.equal((await approve(guesser, '000001')).statusCode, 404);
  });

  test('start and token are rate limited per client IP', async () => {
    const ip = nextIp();
    for (let i = 0; i < AUTH_IP_LIMIT_PER_MINUTE; i += 1) await start('limit', ip);
    const limitedStart = await app.inject({ method: 'POST', url: '/v1/auth/device/start', payload: { deviceName: 'x' }, remoteAddress: ip });
    assert.equal(limitedStart.statusCode, 429);

    const pollIp = nextIp();
    for (let i = 0; i < AUTH_IP_LIMIT_PER_MINUTE; i += 1) assert.equal((await poll('B'.repeat(43), pollIp)).statusCode, 400);
    const limitedPoll = await poll('B'.repeat(43), pollIp);
    assert.equal(limitedPoll.statusCode, 429);
    assert.equal(limitedPoll.json().error.code, 'RATE_LIMITED');
  });

  test('requests long past their expiry are purged when new ones start', async () => {
    const old = await start('stale');
    clock.advance(DEVICE_CODE_TTL_SECONDS * 1000 + 2 * 60 * 60 * 1000);
    await start('fresh');
    const stale = await t.db.select().from(deviceAuthRequests).where(eq(deviceAuthRequests.userCode, old.userCode));
    assert.ok(stale.every((row) => row.deviceName !== 'stale'));
  });
});
