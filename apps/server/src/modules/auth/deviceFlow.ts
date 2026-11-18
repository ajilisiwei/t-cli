import { and, eq, gt, lt } from 'drizzle-orm';
import type { Database, Executor } from '../../db/client.ts';
import { deviceAuthRequests } from '../../db/schema.ts';
import { AppError } from '../../http/errors.ts';
import { createDeviceInTx, type IssuedSession } from './devices.ts';
import { generateSecret, generateUserCode, sha256Hex } from './tokens.ts';

/**
 * CLI device authorization (RFC 8628 style): the CLI starts a request and
 * polls with a secret device code; the account owner approves it with the
 * 6-digit user code from an already logged-in client.
 */
export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** Network jitter allowance before a poll counts as "too fast". */
const POLL_JITTER_MS = 1000;
const USER_CODE_ATTEMPTS = 10;
/** Finished or abandoned requests are deleted this long after they expire. */
const PURGE_AFTER_EXPIRY_MS = 60 * 60 * 1000;
const USER_CODE_RE = /^\d{6}$/;

export type DevicePollError = 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied';

export type DevicePollOutcome =
  | { kind: 'error'; code: DevicePollError }
  | { kind: 'issued'; session: IssuedSession };

export interface StartedDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

/**
 * Open a request. Only the device code's hash is stored; the user code is
 * unique among pending requests (enforced by a partial unique index, so a
 * collision is detected atomically and retried with a new code).
 */
export async function startDeviceAuthorization(
  db: Database,
  { deviceName, now }: { deviceName: string; now: Date },
): Promise<StartedDeviceAuthorization> {
  await db.delete(deviceAuthRequests).where(lt(deviceAuthRequests.expiresAt, new Date(now.getTime() - PURGE_AFTER_EXPIRY_MS)));

  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000);
  for (let attempt = 0; attempt < USER_CODE_ATTEMPTS; attempt += 1) {
    const deviceCode = generateSecret();
    const userCode = generateUserCode();
    const inserted = await db
      .insert(deviceAuthRequests)
      .values({ deviceCodeHash: sha256Hex(deviceCode), userCode, deviceName, expiresAt, createdAt: now })
      .onConflictDoNothing()
      .returning({ userCode: deviceAuthRequests.userCode });
    if (inserted.length > 0) {
      return { deviceCode, userCode, expiresIn: DEVICE_CODE_TTL_SECONDS, interval: DEVICE_POLL_INTERVAL_SECONDS };
    }
  }
  throw new AppError(503, 'DEVICE_AUTH_BUSY', 'could not allocate a user code, try again');
}

/**
 * Which device a pending, unexpired request is for, and how many seconds it
 * has left — shown before the user approves. Read-only. Null when no such
 * request exists (unknown, malformed, expired or already decided).
 */
export async function lookupDeviceAuthorization(
  db: Executor,
  { userCode, now }: { userCode: string; now: Date },
): Promise<{ deviceName: string; expiresIn: number } | null> {
  if (!USER_CODE_RE.test(userCode)) return null;
  const [pending] = await db
    .select({ deviceName: deviceAuthRequests.deviceName, expiresAt: deviceAuthRequests.expiresAt })
    .from(deviceAuthRequests)
    .where(
      and(
        eq(deviceAuthRequests.userCode, userCode),
        eq(deviceAuthRequests.status, 'pending'),
        gt(deviceAuthRequests.expiresAt, now),
      ),
    );
  if (!pending) return null;
  return { deviceName: pending.deviceName, expiresIn: Math.ceil((pending.expiresAt.getTime() - now.getTime()) / 1000) };
}

/**
 * Approve or deny a pending, unexpired request and bind it to `userId`.
 * Null when no such request exists (unknown, expired or already decided).
 * Shared by the HTTP route and the admin script.
 */
export async function decideDeviceAuthorization(
  db: Executor,
  { userCode, userId, approve, now }: { userCode: string; userId: string; approve: boolean; now: Date },
): Promise<{ deviceName: string } | null> {
  if (!USER_CODE_RE.test(userCode)) return null;
  const [decided] = await db
    .update(deviceAuthRequests)
    .set({ status: approve ? 'approved' : 'denied', userId, approvedAt: now })
    .where(
      and(
        eq(deviceAuthRequests.userCode, userCode),
        eq(deviceAuthRequests.status, 'pending'),
        gt(deviceAuthRequests.expiresAt, now),
      ),
    )
    .returning({ deviceName: deviceAuthRequests.deviceName });
  return decided ?? null;
}

/**
 * One poll. The request row is locked, so of two concurrent polls of an
 * approved request exactly one creates the `cli` device and consumes it; the
 * other then sees `consumed` and gets `expired_token`.
 */
export async function pollDeviceAuthorization(
  db: Database,
  { deviceCode, now, refreshTtlDays }: { deviceCode: string; now: Date; refreshTtlDays: number },
): Promise<DevicePollOutcome> {
  const hash = sha256Hex(deviceCode);
  const fail = (code: DevicePollError): DevicePollOutcome => ({ kind: 'error', code });

  return db.transaction(async (tx): Promise<DevicePollOutcome> => {
    const [request] = await tx
      .select()
      .from(deviceAuthRequests)
      .where(eq(deviceAuthRequests.deviceCodeHash, hash))
      .for('update');
    if (!request || request.status === 'consumed') return fail('expired_token');
    if (request.expiresAt.getTime() <= now.getTime()) return fail('expired_token');
    if (request.status === 'denied') return fail('access_denied');

    if (request.status === 'pending') {
      const sinceLastPoll = request.lastPolledAt ? now.getTime() - request.lastPolledAt.getTime() : Infinity;
      await tx.update(deviceAuthRequests).set({ lastPolledAt: now }).where(eq(deviceAuthRequests.deviceCodeHash, hash));
      return fail(sinceLastPoll < DEVICE_POLL_INTERVAL_SECONDS * 1000 - POLL_JITTER_MS ? 'slow_down' : 'authorization_pending');
    }

    // approved
    await tx
      .update(deviceAuthRequests)
      .set({ status: 'consumed', lastPolledAt: now })
      .where(eq(deviceAuthRequests.deviceCodeHash, hash));
    if (!request.userId) return fail('access_denied');
    const created = await createDeviceInTx(tx, {
      userId: request.userId,
      kind: 'cli',
      name: request.deviceName,
      now,
      refreshTtlDays,
    });
    // The approving account was deleted in the meantime.
    if (!created) return fail('access_denied');
    return { kind: 'issued', session: created.session };
  });
}
