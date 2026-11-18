import { and, eq, gt, isNull } from 'drizzle-orm';
import { ulid } from '@t-cli/core/ulid';
import type { Database, Executor } from '../../db/client.ts';
import { identities, invites, users } from '../../db/schema.ts';
import type { Role } from '../../http/auth.ts';
import { AppError } from '../../http/errors.ts';
import { createDevice, createDeviceInTx, type IssuedSession } from './devices.ts';
import { toSettings, type Settings } from './settings.ts';

export const DEFAULT_MP_DEVICE_NAME = 'WeChat mini-program';

export const inviteRequired = () => new AppError(403, 'INVITE_REQUIRED', 'an invite code is required to create an account');
export const inviteInvalid = () => new AppError(403, 'INVITE_INVALID', 'the invite code is invalid, used or expired');
export const accountDisabled = () => new AppError(403, 'ACCOUNT_DISABLED', 'this account has been deleted');

/** Thrown inside the sign-up transaction when a concurrent request registered the same identity first. */
class IdentityTakenError extends Error {}

export interface LoginResult {
  session: IssuedSession;
  isNew: boolean;
  revokedDeviceIds: string[];
}

interface LoginParams {
  openid: string;
  inviteCode: string | undefined;
  deviceName: string;
  now: Date;
  refreshTtlDays: number;
}

async function findWechatAccount(db: Executor, openid: string): Promise<{ userId: string; deleted: boolean } | null> {
  const [row] = await db
    .select({ userId: identities.userId, deletedAt: users.deletedAt })
    .from(identities)
    .innerJoin(users, eq(users.id, identities.userId))
    .where(and(eq(identities.provider, 'wechat_mp'), eq(identities.subject, openid)));
  return row ? { userId: row.userId, deleted: row.deletedAt !== null } : null;
}

/**
 * Create the account, bind the identity, consume the invite and create the
 * first device — all or nothing.
 *
 * - The invite is consumed by one conditional UPDATE, so of any number of
 *   concurrent sign-ups with the same code exactly one commits.
 * - The identity insert waits for a concurrent insert of the same openid; if
 *   that one commits, this transaction is abandoned (IdentityTakenError) and
 *   the caller logs in to the account the other request created.
 */
async function signUpWithInvite(db: Database, inviteCode: string, params: LoginParams): Promise<LoginResult | null> {
  const { openid, deviceName, now, refreshTtlDays } = params;
  try {
    return await db.transaction(async (tx) => {
      const userId = ulid();
      await tx.insert(users).values({ id: userId, role: 'member', createdAt: now });

      const bound = await tx
        .insert(identities)
        .values({ provider: 'wechat_mp', subject: openid, userId, createdAt: now })
        .onConflictDoNothing()
        .returning({ userId: identities.userId });
      if (bound.length === 0) throw new IdentityTakenError();

      const consumed = await tx
        .update(invites)
        .set({ usedBy: userId, usedAt: now })
        .where(and(eq(invites.code, inviteCode), isNull(invites.usedBy), isNull(invites.usedAt), gt(invites.expiresAt, now)))
        .returning({ code: invites.code });
      if (consumed.length === 0) throw inviteInvalid();

      const created = await createDeviceInTx(tx, { userId, kind: 'mp', name: deviceName, now, refreshTtlDays });
      if (!created) throw new Error('account vanished inside its own sign-up transaction');
      return { session: created.session, isNew: true, revokedDeviceIds: created.revokedDeviceIds };
    });
  } catch (error) {
    if (error instanceof IdentityTakenError) return null;
    throw error;
  }
}

/**
 * Mini-program login: a known WeChat identity logs in (new `mp` device); an
 * unknown one needs a valid invite and gets a new account.
 */
export async function loginWithWechat(db: Database, params: LoginParams): Promise<LoginResult> {
  // Two rounds at most: the second only runs when a concurrent first login
  // of the same openid won the race, and then the identity exists.
  for (let round = 0; round < 2; round += 1) {
    const existing = await findWechatAccount(db, params.openid);
    if (existing) {
      if (existing.deleted) throw accountDisabled();
      const created = await createDevice(db, {
        userId: existing.userId,
        kind: 'mp',
        name: params.deviceName,
        now: params.now,
        refreshTtlDays: params.refreshTtlDays,
      });
      if (!created) throw accountDisabled();
      return { session: created.session, isNew: false, revokedDeviceIds: created.revokedDeviceIds };
    }
    if (!params.inviteCode) throw inviteRequired();
    const signedUp = await signUpWithInvite(db, params.inviteCode, params);
    if (signedUp) return signedUp;
  }
  throw new Error('wechat login did not settle after a concurrent sign-up');
}

export interface AccountView {
  id: string;
  role: Role;
  createdAt: string;
  settings: Settings;
}

/** The active account, or null when it is missing or deleted. */
export async function getAccount(db: Executor, userId: string): Promise<AccountView | null> {
  const [row] = await db
    .select({ id: users.id, role: users.role, createdAt: users.createdAt, settings: users.settings })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  return row ? { id: row.id, role: row.role, createdAt: row.createdAt.toISOString(), settings: toSettings(row.settings) } : null;
}

/** True when the account exists and is not deleted. */
export async function isActiveAccount(db: Executor, userId: string): Promise<boolean> {
  return (await getAccount(db, userId)) !== null;
}
