/**
 * Operator commands (no admin UI exists). Reads DATABASE_URL.
 *
 *   npm run admin -w @t-cli/server -- invite [--days N]
 *   npm run admin -w @t-cli/server -- set-role <userId> <admin|member>
 *   npm run admin -w @t-cli/server -- approve-device <userCode> <userId>
 *   npm run admin -w @t-cli/server -- list-users
 *   npm run admin -w @t-cli/server -- run-pipeline [userId]
 *
 * `run-pipeline` runs the nightly AI pipeline now (every account with
 * records, or one) and prints a summary of counts. It also reads the
 * DEEPSEEK_*, AI_PIPELINE_TOKENS_PER_RUN and ALERT_* variables.
 *
 * `approve-device` lets an account owner log the CLI in before the
 * mini-program exists: run `t-cli login`, then approve the 6-digit code here.
 */
import { parseArgs } from 'node:util';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { loadConfig } from '../src/config.ts';
import { createDb, type Database } from '../src/db/client.ts';
import { devices, invites, users } from '../src/db/schema.ts';
import { createLlmClient } from '../src/modules/ai/llm.ts';
import { isActiveAccount } from '../src/modules/auth/accounts.ts';
import { decideDeviceAuthorization } from '../src/modules/auth/deviceFlow.ts';
import { generateInviteCode } from '../src/modules/auth/tokens.ts';
import { createAlerter, runPipeline, type AccountRunSummary } from '../src/modules/pipeline/index.ts';

const DAY_MS = 86_400_000;
const MAX_INVITE_DAYS = 365;
type Role = 'admin' | 'member';
const isRole = (value: string | undefined): value is Role => value === 'admin' || value === 'member';

const USAGE = `usage: admin.ts <command>
  invite [--days N]                    create an invite code (default 7 days)
  set-role <userId> <admin|member>     change an account's role
  approve-device <userCode> <userId>   approve a pending CLI login for an account
  list-users                           list accounts
  run-pipeline [userId]                run the nightly AI pipeline now (all accounts, or one)`;
const COMMANDS = ['invite', 'set-role', 'approve-device', 'list-users', 'run-pipeline'];

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

/** One row per account: ids, counts and error classes only (never user text). */
function summaryRow(summary: AccountRunSummary): Record<string, string | number> {
  return {
    userId: summary.userId,
    status: summary.status,
    error: summary.error ?? '',
    entries: summary.entriesProcessed,
    skipped: summary.recordsSkipped,
    newItems: summary.itemsCreated,
    sources: summary.sourcesAdded,
    generated: summary.itemsGenerated,
    needsRegen: summary.itemsNeedsRegen,
    newCards: summary.cardsCreated,
    updatedCards: summary.cardsUpdated,
    lookups: summary.lookups ? `${summary.lookups.events} ev / ${summary.lookups.unitsCreated} new` : '',
    active: summary.active === null ? '' : String(summary.active),
    daily: summary.daily ? `${summary.daily.date} ${summary.daily.outcome}` : '',
    digest: summary.digest ? `${summary.digest.date} ${summary.digest.outcome}` : '',
    weekly: summary.weekly ? `${summary.weekly.date} ${summary.weekly.outcome}` : '',
    extend: summary.extend ? `${summary.extend.date} ${summary.extend.outcome}` : '',
    tokens: summary.tokens,
    seconds: Math.round(summary.ms / 100) / 10,
  };
}

async function runPipelineNow(db: Database, [userId, ...rest]: string[]): Promise<void> {
  if (rest.length > 0) throw new UsageError('run-pipeline [userId]');
  if (userId !== undefined && !(await isActiveAccount(db, userId))) throw new Error(`no active account ${userId}`);
  // Only the AI, pipeline and alert settings matter here; the server's JWT secret does not.
  const config = loadConfig({ ...process.env, JWT_SECRET: process.env.JWT_SECRET ?? 'unused-by-admin-run-pipeline-0123456789' });
  const log = {
    info: (obj: object, msg: string) => console.error(msg, JSON.stringify(obj)),
    warn: (obj: object, msg: string) => console.error(msg, JSON.stringify(obj)),
  };
  const summaries = await runPipeline(
    { config, db, clock: () => new Date(), llm: createLlmClient(config), alerter: createAlerter(config, log) },
    { userId },
  );
  if (summaries.length === 0) console.log('no accounts with records');
  else console.table(summaries.map(summaryRow));
  for (const summary of summaries) {
    if (Object.keys(summary.rejected).length > 0) console.log(`${summary.userId} rejected answers: ${JSON.stringify(summary.rejected)}`);
  }
  if (summaries.some((summary) => summary.status === 'failed')) process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  if (!command || !COMMANDS.includes(command)) throw new UsageError(USAGE);

  // The pipeline holds an account lock on one connection while it works on others.
  const { db, sql: client } = createDb(url, { max: command === 'run-pipeline' ? 3 : 1 });
  try {
    if (command === 'invite') await createInvite(db, args);
    else if (command === 'set-role') await setRole(db, args);
    else if (command === 'approve-device') await approveDevice(db, args);
    else if (command === 'run-pipeline') await runPipelineNow(db, args);
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
