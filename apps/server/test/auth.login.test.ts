import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { and, count, eq, isNull } from 'drizzle-orm';
import { devices, identities, invites, users } from '../src/db/schema.ts';
import { AUTH_IP_LIMIT_PER_MINUTE } from '../src/modules/auth/routes.ts';
import { MAX_ACTIVE_MP_DEVICES } from '../src/modules/auth/devices.ts';
import { buildTestApp, fakeWechat, fixedClock, type TestClock } from './helpers/app.ts';
import { bearer, createInvite, getDevice, nextIp, nextWechatCode, softDeleteUser, type TokenPairBody } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount } from './helpers/fixtures.ts';

describe('auth: WeChat login', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let clock: TestClock;
  const codes: Record<string, string> = {};

  /** Register a fresh wx.login code with the fake WeChat client. */
  const wechatUser = () => {
    const { code, openid } = nextWechatCode();
    codes[code] = openid;
    return { code, openid };
  };

  const login = (payload: Record<string, unknown>, ip = nextIp()) =>
    app.inject({ method: 'POST', url: '/v1/auth/wechat', payload, remoteAddress: ip });

  const userCount = async () => (await t.db.select({ n: count() }).from(users))[0]!.n;

  before(async () => {
    t = await createTestDatabase();
    clock = fixedClock();
    app = await buildTestApp(t.db, { clock, wechat: fakeWechat(codes) });
  });
  after(async () => {
    await app?.close();
    await t?.drop();
  });

  test('an unknown identity with a valid invite creates a member account', async () => {
    const { code, openid } = wechatUser();
    const invite = await createInvite(t.db, { now: clock() });

    const res = await login({ code, inviteCode: invite, deviceName: 'My iPhone' });
    assert.equal(res.statusCode, 200);
    const pair: TokenPairBody = res.json().data;
    assert.equal(pair.user.isNew, true);
    assert.equal(pair.user.role, 'member');
    assert.equal(pair.accessTokenExpiresIn, 900);
    assert.ok(pair.refreshToken.startsWith(`${pair.deviceId}.`));

    const [identity] = await t.db.select().from(identities).where(eq(identities.subject, openid));
    assert.equal(identity?.userId, pair.user.id);
    const [usedInvite] = await t.db.select().from(invites).where(eq(invites.code, invite));
    assert.equal(usedInvite?.usedBy, pair.user.id);
    assert.ok(usedInvite?.usedAt);
    const device = await getDevice(t.db, pair.deviceId);
    assert.equal(device?.kind, 'mp');
    assert.equal(device?.name, 'My iPhone');
    assert.notEqual(device?.refreshHash, pair.refreshToken.split('.')[1], 'only a hash is stored');

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(pair.accessToken) });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json().data, { id: pair.user.id, role: 'member', createdAt: clock().toISOString(), settings: {} });
  });

  test('invite codes are matched case-insensitively and trimmed', async () => {
    const { code } = wechatUser();
    const invite = await createInvite(t.db, { now: clock(), code: 'ABCD2345EFGH' });
    const res = await login({ code, inviteCode: '  abcd2345efgh ' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.user.isNew, true);
    const [row] = await t.db.select().from(invites).where(eq(invites.code, invite));
    assert.ok(row?.usedBy);
  });

  test('an unknown identity without an invite gets INVITE_REQUIRED and nothing is created', async () => {
    const before = await userCount();
    for (const payload of [{ code: wechatUser().code }, { code: wechatUser().code, inviteCode: '   ' }]) {
      const res = await login(payload);
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'INVITE_REQUIRED');
    }
    assert.equal(await userCount(), before);
  });

  test('a used, expired or unknown invite gets INVITE_INVALID and nothing is created', async () => {
    const owner = await createAccount(t.db);
    const used = await createInvite(t.db, { now: clock(), usedBy: owner.userId });
    const expired = await createInvite(t.db, { now: clock(), expiresAt: new Date(clock().getTime() - 1000) });
    const before = await userCount();
    for (const inviteCode of [used, expired, 'NO-SUCH-INVITE']) {
      const { code, openid } = wechatUser();
      const res = await login({ code, inviteCode });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'INVITE_INVALID');
      const bound = await t.db.select().from(identities).where(eq(identities.subject, openid));
      assert.equal(bound.length, 0);
    }
    assert.equal(await userCount(), before, 'the rolled-back sign-up left no account behind');
  });

  test('a known identity logs in without an invite and gets a new mp device', async () => {
    const { code, openid } = wechatUser();
    const first = (await login({ code, inviteCode: await createInvite(t.db, { now: clock() }) })).json().data as TokenPairBody;

    codes['second-code-' + openid] = openid;
    const res = await login({ code: 'second-code-' + openid });
    assert.equal(res.statusCode, 200);
    const second: TokenPairBody = res.json().data;
    assert.equal(second.user.id, first.user.id);
    assert.equal(second.user.isNew, false);
    assert.notEqual(second.deviceId, first.deviceId);
    assert.equal((await getDevice(t.db, second.deviceId))?.name, 'WeChat mini-program');
  });

  test('a code WeChat rejects gets WECHAT_CODE_INVALID', async () => {
    const res = await login({ code: 'not-a-known-code' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'WECHAT_CODE_INVALID');
  });

  test('malformed bodies get VALIDATION_FAILED', async () => {
    for (const payload of [{}, { code: '' }, { code: 'x', deviceName: 'n'.repeat(65) }, { code: 5 }]) {
      const res = await login(payload);
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'VALIDATION_FAILED');
    }
  });

  test('concurrent sign-ups with one invite create exactly one account', async () => {
    const invite = await createInvite(t.db, { now: clock() });
    const people = Array.from({ length: 6 }, wechatUser);
    const before = await userCount();

    const results = await Promise.all(people.map(({ code }) => login({ code, inviteCode: invite })));
    const statuses = results.map((res) => res.statusCode).sort();
    assert.deepEqual(statuses, [200, 403, 403, 403, 403, 403]);
    for (const res of results.filter((r) => r.statusCode === 403)) assert.equal(res.json().error.code, 'INVITE_INVALID');
    assert.equal(await userCount(), before + 1);

    const winner = results.find((r) => r.statusCode === 200)!.json().data as TokenPairBody;
    const [row] = await t.db.select().from(invites).where(eq(invites.code, invite));
    assert.equal(row?.usedBy, winner.user.id);
  });

  test('a concurrent first login of the same openid creates one account', async () => {
    const { openid } = wechatUser();
    const loginCodes = ['a', 'b', 'c'].map((suffix) => {
      codes[`${openid}-${suffix}`] = openid;
      return `${openid}-${suffix}`;
    });
    const inviteCodes = await Promise.all(loginCodes.map(() => createInvite(t.db, { now: clock() })));
    const before = await userCount();

    const results = await Promise.all(loginCodes.map((code, i) => login({ code, inviteCode: inviteCodes[i] })));
    assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200]);
    const pairs = results.map((r) => r.json().data as TokenPairBody);
    assert.equal(new Set(pairs.map((p) => p.user.id)).size, 1, 'everyone landed in the same account');
    assert.equal(pairs.filter((p) => p.user.isNew).length, 1);
    assert.equal(await userCount(), before + 1);

    const consumed = await t.db.select().from(invites).where(and(eq(invites.usedBy, pairs[0]!.user.id)));
    assert.equal(consumed.length, 1, 'only the winning sign-up consumed its invite');
  });

  test(`at most ${MAX_ACTIVE_MP_DEVICES} mp devices stay active; the least recently active are revoked`, async () => {
    const { code, openid } = wechatUser();
    const first = (await login({ code, inviteCode: await createInvite(t.db, { now: clock() }) })).json().data as TokenPairBody;
    const cli = await createAccount(t.db); // unrelated account: never touched
    const deviceIds = [first.deviceId];
    for (let i = 0; i < MAX_ACTIVE_MP_DEVICES + 1; i += 1) {
      clock.advance(1000);
      codes[`${openid}-again-${i}`] = openid;
      deviceIds.push(((await login({ code: `${openid}-again-${i}` })).json().data as TokenPairBody).deviceId);
    }

    const active = await t.db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.userId, first.user.id), eq(devices.kind, 'mp'), isNull(devices.revokedAt)));
    assert.deepEqual(new Set(active.map((d) => d.id)), new Set(deviceIds.slice(-MAX_ACTIVE_MP_DEVICES)));
    assert.ok((await getDevice(t.db, deviceIds[0]!))?.revokedAt);
    assert.equal((await getDevice(t.db, cli.deviceId))?.revokedAt, null);

    const refresh = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: first.refreshToken } });
    assert.equal(refresh.statusCode, 401);
    assert.equal(refresh.json().error.code, 'REFRESH_INVALID');
  });

  test('a deleted account cannot log in', async () => {
    const { code, openid } = wechatUser();
    const pair = (await login({ code, inviteCode: await createInvite(t.db, { now: clock() }) })).json().data as TokenPairBody;
    await softDeleteUser(t.db, pair.user.id, clock());

    codes[`${openid}-after-delete`] = openid;
    const res = await login({ code: `${openid}-after-delete`, inviteCode: await createInvite(t.db, { now: clock() }) });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'ACCOUNT_DISABLED');
  });

  test('login is rate limited per client IP', async () => {
    const ip = nextIp();
    for (let i = 0; i < AUTH_IP_LIMIT_PER_MINUTE; i += 1) {
      assert.notEqual((await login({ code: 'unknown' }, ip)).statusCode, 429);
    }
    const limited = await login({ code: 'unknown' }, ip);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'RATE_LIMITED');
    assert.ok(limited.json().error.details.retryAfterSeconds >= 1);
    assert.equal(limited.headers['retry-after'], String(limited.json().error.details.retryAfterSeconds));

    assert.notEqual((await login({ code: 'unknown' }, nextIp())).statusCode, 429, 'other clients are unaffected');
    clock.advance(60_000);
    assert.notEqual((await login({ code: 'unknown' }, ip)).statusCode, 429, 'the window slides');
  });
});
