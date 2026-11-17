import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, fakeWechat, fixedClock, testConfig, type TestClock } from './helpers/app.ts';
import { bearer, captureLogs, createInvite, type TokenPairBody } from './helpers/auth.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount } from './helpers/fixtures.ts';

describe('auth: logs carry ids and outcomes, never credentials', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let clock: TestClock;
  let logs: { text(): string };
  const OPENID = 'oPENID-must-not-be-logged-7f3a';
  const WX_CODE = 'wx-login-code-must-not-be-logged-91c2';

  before(async () => {
    t = await createTestDatabase();
    clock = fixedClock();
    app = await buildTestApp(t.db, { clock, config: testConfig({ LOG_LEVEL: 'trace' }), wechat: fakeWechat({ [WX_CODE]: OPENID }) });
    logs = captureLogs(app);
  });
  after(async () => {
    await app?.close();
    await t?.drop();
  });

  test('a full session lifecycle leaks nothing secret into the logs', async () => {
    const secrets: string[] = [OPENID, WX_CODE];
    const inviteCode = await createInvite(t.db, { now: clock() });
    secrets.push(inviteCode);

    // Refused sign-up, then sign-up, then login again.
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/wechat', payload: { code: WX_CODE } })).statusCode, 403);
    const signUp = await app.inject({ method: 'POST', url: '/v1/auth/wechat', payload: { code: WX_CODE, inviteCode } });
    const first: TokenPairBody = signUp.json().data;
    const second: TokenPairBody = (await app.inject({ method: 'POST', url: '/v1/auth/wechat', payload: { code: WX_CODE } })).json().data;
    secrets.push(first.accessToken, first.refreshToken, second.accessToken, second.refreshToken);

    // Rotation, a replay after the grace window (revokes), and an invalid token.
    const rotated: TokenPairBody = (await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: second.refreshToken } })).json().data;
    secrets.push(rotated.accessToken, rotated.refreshToken);
    clock.advance(120_000);
    const reused = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: second.refreshToken } });
    assert.equal(reused.json().error.code, 'REFRESH_REUSED');
    await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: 'garbage.token' } });

    // CLI device flow.
    const owner = await createAccount(t.db, { now: clock() });
    secrets.push(owner.headers.authorization.slice('Bearer '.length));
    const started = (await app.inject({ method: 'POST', url: '/v1/auth/device/start', payload: { deviceName: 'laptop' } })).json().data;
    secrets.push(started.deviceCode);
    await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode: started.deviceCode } });
    await app.inject({ method: 'POST', url: '/v1/auth/device/approve', headers: owner.headers, payload: { userCode: started.userCode, approve: true } });
    clock.advance(5000);
    const cli: TokenPairBody = (await app.inject({ method: 'POST', url: '/v1/auth/device/token', payload: { deviceCode: started.deviceCode } })).json().data;
    secrets.push(cli.accessToken, cli.refreshToken);

    await app.inject({ method: 'GET', url: '/v1/devices', headers: bearer(first.accessToken) });
    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(first.accessToken) });

    const text = logs.text();
    assert.ok(text.length > 0, 'logs were captured');
    for (const secret of secrets) {
      assert.ok(!text.includes(secret), `a credential leaked into the logs: ${secret.slice(0, 6)}…`);
      // The secret half of a refresh token alone must not appear either.
      const tail = secret.split('.').at(-1)!;
      if (tail.length >= 20) assert.ok(!text.includes(tail));
    }
    assert.ok(!text.includes(`"${started.userCode}"`) && !text.includes(`=${started.userCode}`), 'user code not logged');

    // ...while the outcomes are traceable by id.
    assert.ok(text.includes('"wechat login"') && text.includes(first.user.id));
    assert.ok(text.includes('"REFRESH_REUSED"') && text.includes(second.deviceId));
    assert.ok(text.includes('"INVITE_REQUIRED"'));
    assert.ok(text.includes('"cli device authorized"') && text.includes(cli.deviceId));
  });

  // Runs last: it closes the connection pool. Database errors embed the query
  // parameters (here the openid) in their message; they must be redacted
  // before the app's error handler logs them.
  test('a database failure is logged without the query parameters', async () => {
    const before = logs.text().length;
    await t.sql.end({ timeout: 1 });
    const res = await app.inject({ method: 'POST', url: '/v1/auth/wechat', payload: { code: WX_CODE } });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error.code, 'INTERNAL');
    const text = logs.text().slice(before);
    // The global error handler logs the error class, SQLSTATE and stack frames — never a message.
    assert.ok(text.includes('unhandled error'), 'the failure itself is logged');
    assert.ok(!text.includes(OPENID) && !text.includes(WX_CODE));
    assert.ok(!res.body.includes(OPENID));
  });
});
