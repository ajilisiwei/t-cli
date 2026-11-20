import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { deviceAuthRequests, invites, users } from '../src/db/schema.ts';
import { startDeviceAuthorization } from '../src/modules/auth/deviceFlow.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';
import { createAccount } from './helpers/fixtures.ts';

const ADMIN_SCRIPT = fileURLToPath(new URL('../scripts/admin.ts', import.meta.url));
const run = promisify(execFile);

describe('admin script', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;

  async function admin(args: string[], env: Record<string, string | undefined> = { DATABASE_URL: t.url }) {
    try {
      const { stdout, stderr } = await run(process.execPath, [ADMIN_SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env } });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  }

  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test('invite prints a new code valid for --days', async () => {
    const res = await admin(['invite', '--days', '3']);
    assert.equal(res.code, 0, res.stderr);
    const code = res.stdout.split('\n')[0]!;
    assert.match(code, /^[A-HJKMNP-Z2-9]{12}$/);
    const [row] = await t.db.select().from(invites).where(eq(invites.code, code));
    assert.ok(row);
    const days = (row.expiresAt.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 2.9 && days <= 3, `expires in ${days} days`);
    assert.equal(row.usedBy, null);

    const bad = await admin(['invite', '--days', '0']);
    assert.equal(bad.code, 1);
  });

  test('set-role changes the role of an active account', async () => {
    const account = await createAccount(t.db);
    assert.equal((await admin(['set-role', account.userId, 'admin'])).code, 0);
    const [row] = await t.db.select({ role: users.role }).from(users).where(eq(users.id, account.userId));
    assert.equal(row?.role, 'admin');

    assert.equal((await admin(['set-role', account.userId, 'owner'])).code, 1);
    assert.equal((await admin(['set-role', '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'member'])).code, 1);
  });

  test('approve-device binds a pending CLI request to an account', async () => {
    const account = await createAccount(t.db);
    const started = await startDeviceAuthorization(t.db, { deviceName: 'owner laptop', now: new Date() });

    const res = await admin(['approve-device', started.userCode, account.userId]);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(res.stdout.includes('owner laptop'));
    const [row] = await t.db.select().from(deviceAuthRequests).where(eq(deviceAuthRequests.userCode, started.userCode));
    assert.equal(row?.status, 'approved');
    assert.equal(row?.userId, account.userId);

    const again = await admin(['approve-device', started.userCode, account.userId]);
    assert.equal(again.code, 1, 'no longer pending');
    const other = await startDeviceAuthorization(t.db, { deviceName: 'x', now: new Date() });
    assert.equal((await admin(['approve-device', other.userCode, '01ARZ3NDEKTSV4RRFFQ69G5FAV'])).code, 1, 'unknown account');
  });

  test('list-users lists accounts; bad usage and missing DATABASE_URL fail', async () => {
    const account = await createAccount(t.db);
    const res = await admin(['list-users']);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(res.stdout.includes(account.userId));

    const usage = await admin(['frobnicate']);
    assert.equal(usage.code, 1);
    assert.ok(usage.stderr.includes('usage:'));
    const noDb = await admin(['list-users'], {});
    assert.equal(noDb.code, 1);
    assert.ok(noDb.stderr.includes('DATABASE_URL'));
  });
});
