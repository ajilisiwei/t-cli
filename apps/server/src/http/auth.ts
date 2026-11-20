import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import type { Executor } from '../db/client.ts';
import { devices, users } from '../db/schema.ts';
import { unauthorized } from './errors.ts';

export type Role = 'admin' | 'member';

/** Who is calling. Set on the request by `requireAuth`. */
export interface AuthContext {
  userId: string;
  deviceId: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const ISSUER = 't-cli';
const AUDIENCE = 't-cli-api';

const keyFor = (secret: string) => new TextEncoder().encode(secret);

/**
 * Sign a short-lived access token. `requireAuth` also checks the device and
 * account on every request, so revocation and deletion take effect at once.
 */
export async function signAccessToken(
  secret: string,
  ctx: AuthContext,
  { now, ttlSeconds }: { now: Date; ttlSeconds: number },
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ did: ctx.deviceId, role: ctx.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(ctx.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(keyFor(secret));
}

/** Verify an access token; throws a 401 AppError on any problem. */
export async function verifyAccessToken(secret: string, token: string, now: Date): Promise<AuthContext> {
  try {
    const { payload } = await jwtVerify(token, keyFor(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      currentDate: now,
    });
    const { sub, did, role } = payload;
    if (typeof sub !== 'string' || typeof did !== 'string' || (role !== 'admin' && role !== 'member')) {
      throw unauthorized('malformed access token');
    }
    return { userId: sub, deviceId: did, role };
  } catch {
    throw unauthorized('invalid or expired access token');
  }
}

/**
 * Build a preHandler that requires `Authorization: Bearer <access token>`.
 *
 * With `db`, the token must also belong to a device that is not revoked, of
 * an account that still exists (one primary-key lookup). So a revoked device
 * or a deleted account (`POST /v1/me/delete`) loses access at once, instead
 * of keeping it until its access token expires.
 */
export function requireAuth(secret: string, clock: () => Date, db?: Executor) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match?.[1]) throw unauthorized();
    const auth = await verifyAccessToken(secret, match[1], clock());
    if (db) {
      const [active] = await db
        .select({ id: devices.id })
        .from(devices)
        .innerJoin(users, eq(users.id, devices.userId))
        .where(and(eq(devices.id, auth.deviceId), eq(devices.userId, auth.userId), isNull(devices.revokedAt), isNull(users.deletedAt)))
        .limit(1);
      if (!active) throw unauthorized('device revoked or account not found');
    }
    request.auth = auth;
  };
}

/** The authenticated context; only call from routes guarded by requireAuth. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
