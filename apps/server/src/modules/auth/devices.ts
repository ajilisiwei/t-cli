import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import type { Database, Executor } from '../../db/client.ts';
import { devices, users } from '../../db/schema.ts';
import type { Role } from '../../http/auth.ts';
import { formatRefreshToken, generateSecret, sha256Hex } from './tokens.ts';

/** A mini-program login creates a device; older ones beyond this are revoked. */
export const MAX_ACTIVE_MP_DEVICES = 5;
const DAY_MS = 86_400_000;
const LIST_LIMIT = 100;

export type DeviceKind = 'cli' | 'mp' | 'h5';
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** A freshly issued refresh token and the identity it belongs to. */
export interface IssuedSession {
  userId: string;
  role: Role;
  deviceId: string;
  refreshToken: string;
}

export function refreshExpiry(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * DAY_MS);
}

/**
 * Lock an active account row for the rest of the transaction. The lock
 * serialises device creation per account (so the mp-device cap is exact) and
 * guarantees the account is not deleted underneath us. Null when missing or
 * deleted.
 */
export async function lockActiveAccount(tx: Transaction, userId: string): Promise<{ role: Role } | null> {
  const [account] = await tx
    .select({ role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .for('no key update');
  return account ?? null;
}

/**
 * Create a device with a new refresh token. Must run inside a transaction.
 * Returns null when the account is missing or deleted.
 */
export async function createDeviceInTx(
  tx: Transaction,
  { userId, kind, name, now, refreshTtlDays }: { userId: string; kind: DeviceKind; name: string; now: Date; refreshTtlDays: number },
): Promise<{ session: IssuedSession; revokedDeviceIds: string[] } | null> {
  const account = await lockActiveAccount(tx, userId);
  if (!account) return null;

  const deviceId = ulid();
  const secret = generateSecret();
  await tx.insert(devices).values({
    id: deviceId,
    userId,
    kind,
    name,
    refreshHash: sha256Hex(secret),
    refreshExpiresAt: refreshExpiry(now, refreshTtlDays),
    lastSeenAt: now,
    createdAt: now,
  });
  const revokedDeviceIds = kind === 'mp' ? await revokeExcessMpDevices(tx, userId, now) : [];
  return {
    session: { userId, role: account.role, deviceId, refreshToken: formatRefreshToken(deviceId, secret) },
    revokedDeviceIds,
  };
}

/** Keep the most recently active mini-program devices; revoke the rest. */
async function revokeExcessMpDevices(tx: Transaction, userId: string, now: Date): Promise<string[]> {
  const excess = tx
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.userId, userId), eq(devices.kind, 'mp'), isNull(devices.revokedAt)))
    .orderBy(desc(sql`coalesce(${devices.lastSeenAt}, ${devices.createdAt})`), desc(devices.createdAt), desc(devices.id))
    .offset(MAX_ACTIVE_MP_DEVICES);
  const revoked = await tx
    .update(devices)
    .set({ revokedAt: now })
    .where(inArray(devices.id, excess))
    .returning({ id: devices.id });
  return revoked.map((row) => row.id);
}

export async function createDevice(
  db: Database,
  params: Parameters<typeof createDeviceInTx>[1],
): Promise<{ session: IssuedSession; revokedDeviceIds: string[] } | null> {
  return db.transaction((tx) => createDeviceInTx(tx, params));
}

export interface DeviceView {
  id: string;
  kind: DeviceKind;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  current: boolean;
}

/** An account's devices: active ones first, then the most recent revoked ones. */
export async function listDevices(db: Executor, userId: string, currentDeviceId: string): Promise<DeviceView[]> {
  const rows = await db
    .select({
      id: devices.id,
      kind: devices.kind,
      name: devices.name,
      createdAt: devices.createdAt,
      lastSeenAt: devices.lastSeenAt,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .where(eq(devices.userId, userId))
    .orderBy(sql`${devices.revokedAt} is null desc`, desc(devices.createdAt), desc(devices.id))
    .limit(LIST_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    current: row.id === currentDeviceId,
  }));
}

/**
 * Revoke one of the account's devices (idempotent: an earlier revocation time
 * is kept). False when the device does not exist or belongs to someone else.
 */
export async function revokeDevice(db: Executor, { userId, deviceId, now }: { userId: string; deviceId: string; now: Date }): Promise<boolean> {
  const rows = await db
    .update(devices)
    .set({ revokedAt: sql`coalesce(${devices.revokedAt}, ${now.toISOString()}::timestamptz)` })
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
    .returning({ id: devices.id });
  return rows.length > 0;
}
