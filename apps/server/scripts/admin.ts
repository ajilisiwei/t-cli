/**
 * Operator commands (no admin UI exists). Reads DATABASE_URL.
 *
 *   npm run admin -w @t-cli/server -- invite [--days N]
 *   npm run admin -w @t-cli/server -- set-role <userId> <admin|member>
 *   npm run admin -w @t-cli/server -- approve-device <userCode> <userId>
 *   npm run admin -w @t-cli/server -- list-users
 *
 * `approve-device` lets an account owner log the CLI in before the
 * mini-program exists: run `t-cli login`, then approve the 6-digit code here.
 */
import { parseArgs } from 'node:util';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { createDb, type Database } from '../src/db/client.ts';
import { devices, invites, users } from '../src/db/schema.ts';
import { isActiveAccount } from '../src/modules/auth/accounts.ts';
import { decideDeviceAuthorization } from '../src/modules/auth/deviceFlow.ts';
import { generateInviteCode } from '../src/modules/auth/tokens.ts';

const DAY_MS = 86_400_000;
const MAX_INVITE_DAYS = 365;
type Role = 'admin' | 'member';
const isRole = (value: string | undefined): value is Role => value === 'admin' || value === 'member';

const USAGE = `usage: admin.ts <command>
  invite [--days N]                    create an invite code (default 7 days)
  set-role <userId> <admin|member>     change an account's role
  approve-device <userCode> <userId>   approve a pending CLI login for an account
  list-users                           list accounts`;

class UsageError extends Error {}

async function createInvite(db: Database, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { days: { type: 'string', default: '7' } }, strict: true });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_INVITE_DAYS) {
    throw new UsageError(`--days must be an integer between 1 and ${MAX_INVITE_DAYS}`);
  }
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + days * DAY_MS);
  await db.insert(invites).values({ code, expiresAt });
  console.log(code);
  console.log(`expires ${expiresAt.toISOString()}`);
}

async function setRole(db: Database, [userId, role]: string[]): Promise<void> {
  if (!userId || !isRole(role)) throw new UsageError('set-role <userId> <admin|member>');
  const updated = await db
    .update(users)
    .set({ role })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .returning({ id: users.id });
  if (updated.length === 0) throw new Error(`no active account ${userId}`);
  console.log(`${userId} is now ${role} (takes effect at the next token refresh)`);
}

async function approveDevice(db: Database, [userCode, userId]: string[]): Promise<void> {
  if (!userCode || !userId) throw new UsageError('approve-device <userCode> <userId>');
  if (!(await isActiveAccount(db, userId))) throw new Error(`no active account ${userId}`);
  const decided = await decideDeviceAuthorization(db, { userCode, userId, approve: true, now: new Date() });
  if (!decided) throw new Error('no pending device authorization with that code (unknown, expired or already decided)');
  console.log(`approved "${decided.deviceName}" for ${userId}; the CLI picks up its tokens at its next poll`);
}

async function listUsers(db: Database): Promise<void> {
  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      createdAt: users.createdAt,
      deletedAt: users.deletedAt,
      activeDevices: count(devices.id),
    })
    .from(users)
    .leftJoin(devices, and(eq(devices.userId, users.id), isNull(devices.revokedAt), sql`${devices.refreshExpiresAt} > now()`))
    .groupBy(users.id)
    .orderBy(users.createdAt);
  console.table(
    rows.map((row) => ({
      id: row.id,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
      deleted: row.deletedAt ? row.deletedAt.toISOString() : '',
      activeDevices: row.activeDevices,
    })),
  );
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  if (!command || !['invite', 'set-role', 'approve-device', 'list-users'].includes(command)) throw new UsageError(USAGE);

  const { db, sql: client } = createDb(url, { max: 1 });
  try {
    if (command === 'invite') await createInvite(db, args);
    else if (command === 'set-role') await setRole(db, args);
    else if (command === 'approve-device') await approveDevice(db, args);
    else await listUsers(db);
  } finally {
    await client.end({ timeout: 5 });
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  // A failed query's message embeds its parameters; show the driver's own message instead.
  const root = error instanceof DrizzleQueryError ? error.cause : error;
  console.error(root instanceof Error ? root.message : String(root));
  if (error instanceof UsageError && error.message !== USAGE) console.error(USAGE);
  process.exitCode = 1;
}
