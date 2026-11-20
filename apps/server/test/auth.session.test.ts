import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { REFRESH_REPLAY_GRACE_MS } from '../src/modules/auth/refresh.ts';
import { AUTH_IP_LIMIT_PER_MINUTE } from '../src/modules/auth/routes.ts';
import { buildTestApp, fakeWechat, fixedClock, type TestClock } from './helpers/app.ts';
import { bearer, createInvite, getDevice, nextIp, nextWechatCode, softDeleteUser, type TokenPairBody } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';

const DAY_MS = 86_400_000;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('auth: refresh, logout, me and devices', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let clock: TestClock;
  const codes: Record<string, string> = {};

  /** A brand-new account logged in through the real WeChat flow. */
  async function signUp(): Promise<TokenPairBody & { openid: string }> {
    const { code, openid } = nextWechatCode();
    codes[code] = openid;
    const inviteCode = await createInvite(t.db, { now: clock() });
    const res = await app.inject({ method: 'POST', url: '/v1/auth/wechat', payload: { code, inviteCode }, remoteAddress: nextIp() });
    assert.equal(res.statusCode, 200);
    return { ...(res.json().data as TokenPairBody), openid };
  }

  /** Another mp device of the same account. */
  async function loginAgain(openid: string): Promise<TokenPairBody> {
    const code = `${openid}-${Math.random()}`;
    codes[code] = openid;
    const res = await app.inject({ method: 'POST', url: '/v1/auth/wechat', payload: { code }, remoteAddress: nextIp() });
    return res.json().data as TokenPairBody;
  }

  const refresh = (refreshToken: string, ip = nextIp()) =>
    app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken }, remoteAddress: ip });

  const expectRefreshError = async (refreshToken: string, code: string) => {
    const res = await refresh(refreshToken);
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, code);
  };

  before(async () => {
    t = await createTestDatabase();
    clock = fixedClock();
    app = await buildTestApp(t.db, { clock, wechat: fakeWechat(codes) });
  });
  after(async () => {
    await app?.close();
    await t?.drop();
  });

  test('refresh rotates the token, slides the expiry and stores only hashes', async () => {
    const first = await signUp();
    clock.advance(10 * DAY_MS);

    const res = await refresh(first.refreshToken);
    assert.equal(res.statusCode, 200);
    const second: TokenPairBody = res.json().data;
    assert.equal(second.deviceId, first.deviceId);
    assert.equal(second.user.id, first.user.id);
    assert.equal(second.user.isNew, undefined);
    assert.notEqual(second.refreshToken, first.refreshToken);
    assert.notEqual(second.accessToken, first.accessToken);

    const device = await getDevice(t.db, first.deviceId);
    assert.equal(device?.refreshHash, sha256(second.refreshToken.split('.')[1]!));
    assert.equal(device?.prevRefreshHash, sha256(first.refreshToken.split('.')[1]!));
    assert.equal(device?.refreshExpiresAt.getTime(), clock().getTime() + 60 * DAY_MS);
    assert.equal(device?.lastSeenAt?.getTime(), clock().getTime());

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(second.accessToken) });
    assert.equal(me.statusCode, 200);
  });

  test('replaying a rotated token after the grace window revokes the device', async () => {
    const first = await signUp();
    const second = (await refresh(first.refreshToken)).json().data as TokenPairBody;
    clock.advance(REFRESH_REPLAY_GRACE_MS + 1000);

    await expectRefreshError(first.refreshToken, 'REFRESH_REUSED');
    assert.ok((await getDevice(t.db, first.deviceId))?.revokedAt, 'device revoked');
    await expectRefreshError(second.refreshToken, 'REFRESH_INVALID');
  });

  test('replaying a rotated token within the grace window (lost response) rotates again', async () => {
    const first = await signUp();
    const lost = (await refresh(first.refreshToken)).json().data as TokenPairBody;
    clock.advance(REFRESH_REPLAY_GRACE_MS);

    const retry = await refresh(first.refreshToken);
    assert.equal(retry.statusCode, 200);
    const retried: TokenPairBody = retry.json().data;
    assert.notEqual(retried.refreshToken, lost.refreshToken);
    assert.equal((await getDevice(t.db, first.deviceId))?.revokedAt, null, 'not treated as theft');

    clock.advance(1000);
    const next = await refresh(retried.refreshToken);
    assert.equal(next.statusCode, 200, 'the retried token is the live one');
    assert.equal((await getDevice(t.db, first.deviceId))?.revokedAt, null);
  });

  test('the token a grace retry replaced is still caught if it is used later', async () => {
    const first = await signUp();
    const lost = (await refresh(first.refreshToken)).json().data as TokenPairBody;
    clock.advance(5000);
    await refresh(first.refreshToken); // retry within grace: `lost` becomes the previous token
    clock.advance(REFRESH_REPLAY_GRACE_MS + 1000);

    await expectRefreshError(lost.refreshToken, 'REFRESH_REUSED');
    assert.ok((await getDevice(t.db, first.deviceId))?.revokedAt);
  });

  test('an expired refresh token is invalid', async () => {
    const first = await signUp();
    clock.advance(59 * DAY_MS);
    const second = (await refresh(first.refreshToken)).json().data as TokenPairBody;
    assert.ok(second.refreshToken, 'still valid after 59 days');
    clock.advance(60 * DAY_MS + 1000);
    await expectRefreshError(second.refreshToken, 'REFRESH_INVALID');
  });

  test('unknown, malformed, revoked and deleted-account tokens are invalid', async () => {
    const pair = await signUp();
    const [deviceId, secret] = pair.refreshToken.split('.') as [string, string];
    for (const token of ['nope', `${deviceId}.`, `${deviceId}.${secret.slice(1)}x`, `01ARZ3NDEKTSV4RRFFQ69G5FAV.${secret}`, pair.accessToken]) {
      await expectRefreshError(token, 'REFRESH_INVALID');
    }
    const empty = await refresh('');
    assert.equal(empty.json().error.code, 'VALIDATION_FAILED');

    const other = await loginAgain(pair.openid);
    const revoke = await app.inject({ method: 'DELETE', url: `/v1/devices/${other.deviceId}`, headers: bearer(pair.accessToken) });
    assert.equal(revoke.statusCode, 200);
    await expectRefreshError(other.refreshToken, 'REFRESH_INVALID');

    await softDeleteUser(t.db, pair.user.id, clock());
    await expectRefreshError(pair.refreshToken, 'REFRESH_INVALID');
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(pair.accessToken) });
    assert.equal(me.statusCode, 401);
  });

  test('logout revokes the calling device only', async () => {
    const pair = await signUp();
    const other = await loginAgain(pair.openid);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(pair.accessToken) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data, { revoked: true });
    assert.equal((await getDevice(t.db, pair.deviceId))?.revokedAt?.getTime(), clock().getTime());
    await expectRefreshError(pair.refreshToken, 'REFRESH_INVALID');
    assert.equal((await refresh(other.refreshToken)).statusCode, 200);

    const anonymous = await app.inject({ method: 'POST', url: '/v1/auth/logout' });
    assert.equal(anonymous.statusCode, 401);
  });

  test('devices: list own devices with the current one marked; revoke one', async () => {
    const pair = await signUp();
    clock.advance(1000);
    const other = await loginAgain(pair.openid);

    const list = await app.inject({ method: 'GET', url: '/v1/devices', headers: bearer(pair.accessToken) });
    assert.equal(list.statusCode, 200);
    const listed = list.json().data.devices as { id: string; kind: string; current: boolean; revokedAt: string | null }[];
    assert.deepEqual(listed.map((d) => d.id).sort(), [pair.deviceId, other.deviceId].sort());
    assert.deepEqual(listed.find((d) => d.current)?.id, pair.deviceId);
    const shape = listed[0]!;
    assert.deepEqual(Object.keys(shape).sort(), ['createdAt', 'current', 'id', 'kind', 'lastSeenAt', 'name', 'revokedAt']);

    const revoke = await app.inject({ method: 'DELETE', url: `/v1/devices/${other.deviceId}`, headers: bearer(pair.accessToken) });
    assert.deepEqual(revoke.json().data, { revoked: true });
    const again = await app.inject({ method: 'DELETE', url: `/v1/devices/${other.deviceId}`, headers: bearer(pair.accessToken) });
    assert.equal(again.statusCode, 200, 'revoking twice is idempotent');
    const after = (await app.inject({ method: 'GET', url: '/v1/devices', headers: bearer(pair.accessToken) })).json().data.devices;
    assert.ok(after.find((d: { id: string }) => d.id === other.deviceId).revokedAt);
  });

  test("a revoked device's unexpired access token stops working at once", async () => {
    const pair = await signUp();
    const other = await loginAgain(pair.openid);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(other.accessToken) })).statusCode, 200);

    await app.inject({ method: 'DELETE', url: `/v1/devices/${other.deviceId}`, headers: bearer(pair.accessToken) });
    const revoked = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(other.accessToken) });
    assert.equal(revoked.statusCode, 401);
    assert.equal(revoked.json().error.code, 'UNAUTHORIZED');

    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(pair.accessToken) });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/devices', headers: bearer(pair.accessToken) })).statusCode, 401, 'logout too');
  });

  test("an account can neither list nor revoke another account's devices", async () => {
    const alice = await signUp();
    const bob = await signUp();

    const aliceList = (await app.inject({ method: 'GET', url: '/v1/devices', headers: bearer(alice.accessToken) })).json().data.devices;
    assert.ok(aliceList.every((d: { id: string }) => d.id !== bob.deviceId));

    const res = await app.inject({ method: 'DELETE', url: `/v1/devices/${bob.deviceId}`, headers: bearer(alice.accessToken) });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
    assert.equal((await getDevice(t.db, bob.deviceId))?.revokedAt, null);
    const unknown = await app.inject({ method: 'DELETE', url: '/v1/devices/01ARZ3NDEKTSV4RRFFQ69G5FAV', headers: bearer(alice.accessToken) });
    assert.equal(unknown.statusCode, 404);
  });

  test('me, devices and logout require authentication', async () => {
    for (const [method, url] of [['GET', '/v1/me'], ['GET', '/v1/devices'], ['DELETE', '/v1/devices/x'], ['POST', '/v1/auth/logout']] as const) {
      const res = await app.inject({ method, url, headers: { authorization: 'Bearer nope' } });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
      assert.equal(res.json().error.code, 'UNAUTHORIZED');
    }
  });

  test('refresh is rate limited per client IP', async () => {
    const ip = nextIp();
    for (let i = 0; i < AUTH_IP_LIMIT_PER_MINUTE; i += 1) assert.equal((await refresh('nope', ip)).statusCode, 401);
    const limited = await refresh('nope', ip);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
    assert.equal(typeof limited.json().error.details.retryAfterSeconds, 'number');
  });
});
