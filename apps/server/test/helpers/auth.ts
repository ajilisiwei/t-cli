import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Database } from '../../src/db/client.ts';
import { devices, invites, users } from '../../src/db/schema.ts';

const DAY_MS = 86_400_000;

/** Insert an invite; valid for a week from `now` unless overridden. */
export async function createInvite(
  db: Database,
  { now, code = randomBytes(6).toString('hex').toUpperCase(), expiresAt, usedBy = null }: {
    now: Date;
    code?: string;
    expiresAt?: Date;
    usedBy?: string | null;
  },
): Promise<string> {
  await db.insert(invites).values({
    code,
    expiresAt: expiresAt ?? new Date(now.getTime() + 7 * DAY_MS),
    usedBy,
    usedAt: usedBy ? now : null,
  });
  return code;
}

let ipCounter = 0;
/** A distinct client IP, so per-IP rate limits of one test never affect another. */
export function nextIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

let codeCounter = 0;
/** A unique wx.login code / openid pair for the fake WeChat client. */
export function nextWechatCode(): { code: string; openid: string } {
  codeCounter += 1;
  return { code: `wx-code-${codeCounter}-${randomBytes(4).toString('hex')}`, openid: `openid-${codeCounter}-${randomBytes(6).toString('hex')}` };
}

export interface TokenPairBody {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  user: { id: string; role: string; isNew?: boolean };
  deviceId: string;
}

export const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

export async function getDevice(db: Database, id: string) {
  const [row] = await db.select().from(devices).where(eq(devices.id, id));
  return row;
}

export async function softDeleteUser(db: Database, userId: string, now: Date): Promise<void> {
  await db.update(users).set({ deletedAt: now }).where(eq(users.id, userId));
}

/**
 * Capture everything the app logs (as raw text) by swapping the destination
 * stream of its root pino logger; request loggers are children and inherit
 * it. Build the app with LOG_LEVEL=trace to see every line.
 */
export function captureLogs(app: FastifyInstance): { text(): string } {
  const logger = app.log as unknown as Record<symbol, unknown>;
  const streamSym = Object.getOwnPropertySymbols(logger).find((symbol) => symbol.description === 'pino.stream');
  if (!streamSym) throw new Error('pino stream symbol not found; the logger implementation changed');
  const chunks: string[] = [];
  logger[streamSym] = { write: (chunk: string) => void chunks.push(chunk) };
  return { text: () => chunks.join('') };
}
