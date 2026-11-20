// End to end: the CLI's push code (apps/cli/src/sync) against the real
// server app on a throwaway database. The CLI's config dir (auth.json,
// outbox.jsonl) lives in a temp XDG_CONFIG_HOME, never ~/.config/t-cli.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { appendEntries, countRejected, getRejectedPath, readOutbox } from '../../cli/src/entryLog.js';
import { authFromTokenPair, writeAuth } from '../../cli/src/sync/authStore.js';
import { createSyncClient } from '../../cli/src/sync/client.js';
import { LOGIN_IDLE, loginReducer } from '../../cli/src/sync/deviceFlow.js';
import { pollDeviceLogin } from '../../cli/src/sync/login.js';
import { pushOutbox } from '../../cli/src/sync/push.js';
import { buildTestApp, fixedClock } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount, makeEntry, type TestAccount } from './helpers/fixtures.ts';

describe('CLI sync push against the real server', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let serverUrl: string;
  let configHome: string;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const clock = fixedClock();

  before(async () => {
    configHome = fs.mkdtempSync(path.join(os.tmpdir(), 't-cli-e2e-'));
    process.env.XDG_CONFIG_HOME = configHome;
    t = await createTestDatabase();
    app = await buildTestApp(t.db, { clock });
    await app.listen({ port: 0, host: '127.0.0.1' });
    serverUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await app?.close();
    await t?.drop();
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    if (configHome) fs.rmSync(configHome, { recursive: true, force: true });
  });

  /** Log the CLI in as `account` by writing auth.json the way /login would. */
  function loginCli(account: TestAccount): void {
    const accessToken = account.headers.authorization.replace(/^Bearer /, '');
    const auth = authFromTokenPair(
      { accessToken, refreshToken: `${account.deviceId}.unused`, accessTokenExpiresIn: 900, user: { id: account.userId, role: account.role }, deviceId: account.deviceId },
      { serverUrl, now: Date.now() },
    );
    assert.deepEqual(writeAuth(auth), { ok: true });
  }

  async function pullIds(account: TestAccount): Promise<string[]> {
    const res = await app.inject({ method: 'GET', url: '/v1/entries?after=0&limit=500', headers: account.headers });
    assert.equal(res.statusCode, 200);
    return res.json().data.entries.map((e: { id: string }) => e.id);
  }

  test('outbox entries reach the server, acked ones leave the outbox, re-push sends nothing', async () => {
    const account = await createAccount(t.db, { now: clock() });
    loginCli(account);
    const entries = Array.from({ length: 205 }, () => makeEntry()); // two batches
    const tooLong = makeEntry({ input: 'x'.repeat(20_001) }); // valid locally, rejected by the server
    assert.deepEqual(appendEntries([...entries.slice(0, 100), tooLong, ...entries.slice(100)]), { ok: true });

    const client = createSyncClient({ serverUrl });
    const first = await pushOutbox({ client });
    assert.equal(first.error, null);
    assert.equal(first.batches, 2);
    assert.equal(first.accepted, 205);
    assert.equal(first.rejected, 1);
    assert.equal(first.remaining, 0);

    assert.deepEqual(await pullIds(account), entries.map((e) => e.id));
    const outbox = readOutbox();
    assert.equal(outbox.error, null);
    assert.deepEqual(outbox.entries, []);
    assert.equal(countRejected(), 1);
    assert.equal(JSON.parse(fs.readFileSync(getRejectedPath(), 'utf8').trim()).entry.id, tooLong.id);

    const second = await pushOutbox({ client });
    assert.equal(second.attempted, false, 'nothing left to send');
    assert.equal(second.error, null);
    assert.deepEqual(await pullIds(account), entries.map((e) => e.id));
  });

  test('entries recorded after a push are sent by the next push only', async () => {
    const account = await createAccount(t.db, { now: clock() });
    loginCli(account);
    const client = createSyncClient({ serverUrl });
    const batch1 = [makeEntry(), makeEntry()];
    appendEntries(batch1);
    assert.equal((await pushOutbox({ client })).accepted, 2);

    const batch2 = [makeEntry()];
    appendEntries(batch2);
    const next = await pushOutbox({ client });
    assert.equal(next.accepted, 1);
    assert.deepEqual(await pullIds(account), [...batch1, ...batch2].map((e) => e.id));
    assert.deepEqual(readOutbox().entries, []);
  });

  test('device login, push, token refresh and logout through the CLI client', async () => {
    const approver = await createAccount(t.db, { kind: 'mp', now: clock() });
    const client = createSyncClient({ serverUrl });

    const started = await client.startDeviceAuth({ deviceName: 't-cli e2e' });
    assert.match(started.userCode, /^\d{6}$/);
    let state = loginReducer(loginReducer(LOGIN_IDLE, { type: 'start' }), { type: 'started', response: started, now: clock().getTime() });

    clock.advance(state.status === 'polling' ? state.intervalMs : 0);
    state = loginReducer(state, await pollDeviceLogin({ client, deviceCode: started.deviceCode, now: () => clock().getTime() }));
    assert.equal(state.status, 'polling', 'authorization_pending keeps polling');

    const approve = await app.inject({ method: 'POST', url: '/v1/auth/device/approve', headers: approver.headers, payload: { userCode: started.userCode, approve: true } });
    assert.equal(approve.statusCode, 200);

    clock.advance(state.status === 'polling' ? state.intervalMs : 0);
    state = loginReducer(state, await pollDeviceLogin({ client, deviceCode: started.deviceCode, now: () => clock().getTime() }));
    assert.equal(state.status, 'done');
    assert.equal(state.status === 'done' && state.outcome, 'approved');
    const auth = client.getAuth();
    assert.ok(auth, 'credentials saved');
    assert.equal(auth.user.id, approver.userId);
    assert.equal(fs.statSync(path.join(configHome, 't-cli', 'auth.json')).mode & 0o777, 0o600);

    const entries = [makeEntry(), makeEntry()];
    appendEntries(entries);
    assert.equal((await pushOutbox({ client })).accepted, 2);
    assert.deepEqual(await pullIds({ ...approver, headers: { authorization: `Bearer ${auth.accessToken}` } }), entries.map((e) => e.id));

    // A client whose clock says the access token is about to expire refreshes first (rotation).
    const later = createSyncClient({ serverUrl, now: () => Date.now() + 20 * 60_000 });
    appendEntries([makeEntry()]);
    assert.equal((await pushOutbox({ client: later })).accepted, 1);
    const rotated = later.getAuth();
    assert.ok(rotated);
    assert.notEqual(rotated.refreshToken, auth.refreshToken, 'refresh token rotated');

    assert.deepEqual(await client.logout(), { revoked: true });
    // Access tokens are stateless, so revocation bites at the next refresh: a
    // client clock past the (skewed) expiry forces one, and the revoked
    // device's refresh token is refused; the CLI drops its credentials.
    const lost: string[] = [];
    const afterLogout = createSyncClient({ serverUrl, now: () => Date.now() + 60 * 60_000, onAuthLost: (code) => lost.push(code) });
    appendEntries([makeEntry()]);
    const refused = await pushOutbox({ client: afterLogout });
    assert.equal(refused.error?.kind, 'auth');
    assert.deepEqual(lost, ['REFRESH_INVALID']);
    assert.equal(afterLogout.getAuth(), null);
    assert.equal(readOutbox().entries.length, 1, 'nothing removed when the push failed');
  });
});
