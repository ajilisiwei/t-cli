import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
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
 * Sign a short-lived access token. Revocation takes effect at the next
 * refresh, so the TTL bounds how long a revoked device keeps access.
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

/** Build a preHandler that requires `Authorization: Bearer <access token>`. */
export function requireAuth(secret: string, clock: () => Date) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match?.[1]) throw unauthorized();
    request.auth = await verifyAccessToken(secret, match[1], clock());
  };
}

/** The authenticated context; only call from routes guarded by requireAuth. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
