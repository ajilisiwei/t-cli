import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { devices, users } from '../../db/schema.ts';
import { refreshExpiry, type IssuedSession } from './devices.ts';
import { formatRefreshToken, generateSecret, hashesEqual, parseRefreshToken, sha256Hex } from './tokens.ts';

/**
 * How long after a rotation the previous refresh token is still honoured.
 * Covers a client that retries because the rotation's response was lost; a
 * replay later than this is treated as theft and revokes the device.
 */
export const REFRESH_REPLAY_GRACE_MS = 60_000;

export type RefreshOutcome =
  | { kind: 'invalid'; deviceId?: string }
  | { kind: 'reused'; userId: string; deviceId: string }
  | { kind: 'rotated'; session: IssuedSession; viaGrace: boolean };

/**
 * Exchange a refresh token for a new one (rotation).
 *
 * The device row is locked for the whole exchange, so concurrent refreshes of
 * one device run one at a time. `last_seen_at` doubles as the rotation time:
 * it is only ever written at device creation and here.
 *
 * - current token, not expired          → rotate
 * - previous token, ≤ 60 s after rotation → rotate again (lost-response retry);
 *   the token this replaces becomes the "previous" one, so whoever holds it is
 *   caught if they use it later
 * - previous token, later                → revoke the device ("reused")
 * - anything else                        → invalid
 */
export async function rotateRefreshToken(
  db: Database,
  { token, now, refreshTtlDays }: { token: string; now: Date; refreshTtlDays: number },
): Promise<RefreshOutcome> {
  const parsed = parseRefreshToken(token);
  if (!parsed) return { kind: 'invalid' };
  const presentedHash = sha256Hex(parsed.secret);

  return db.transaction(async (tx): Promise<RefreshOutcome> => {
    const [device] = await tx
      .select({
        id: devices.id,
        userId: devices.userId,
        refreshHash: devices.refreshHash,
        prevRefreshHash: devices.prevRefreshHash,
        refreshExpiresAt: devices.refreshExpiresAt,
        revokedAt: devices.revokedAt,
        lastSeenAt: devices.lastSeenAt,
        createdAt: devices.createdAt,
        role: users.role,
        deletedAt: users.deletedAt,
      })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .where(eq(devices.id, parsed.deviceId))
      .for('update', { of: devices });
    if (!device || device.revokedAt || device.deletedAt) return { kind: 'invalid' };

    const isCurrent = hashesEqual(presentedHash, device.refreshHash);
    const isPrevious = !isCurrent && device.prevRefreshHash !== null && hashesEqual(presentedHash, device.prevRefreshHash);
    if (!isCurrent && !isPrevious) return { kind: 'invalid', deviceId: device.id };

    if (isPrevious) {
      const rotatedAt = device.lastSeenAt ?? device.createdAt;
      if (now.getTime() - rotatedAt.getTime() > REFRESH_REPLAY_GRACE_MS) {
        await tx.update(devices).set({ revokedAt: now }).where(eq(devices.id, device.id));
        return { kind: 'reused', userId: device.userId, deviceId: device.id };
      }
    }
    if (device.refreshExpiresAt.getTime() <= now.getTime()) return { kind: 'invalid', deviceId: device.id };

    const secret = generateSecret();
    await tx
      .update(devices)
      .set({
        refreshHash: sha256Hex(secret),
        prevRefreshHash: device.refreshHash,
        refreshExpiresAt: refreshExpiry(now, refreshTtlDays),
        lastSeenAt: now,
      })
      .where(eq(devices.id, device.id));
    return {
      kind: 'rotated',
      viaGrace: isPrevious,
      session: { userId: device.userId, role: device.role, deviceId: device.id, refreshToken: formatRefreshToken(device.id, secret) },
    };
  });
}
