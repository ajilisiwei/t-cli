import type { Config } from '../../config.ts';
import { signAccessToken, type Role } from '../../http/auth.ts';
import type { IssuedSession } from './devices.ts';

/** The `TokenPair` response of docs/api-v1.md. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  user: { id: string; role: Role; isNew?: boolean };
  deviceId: string;
}

export async function toTokenPair(
  config: Config,
  session: IssuedSession,
  now: Date,
  extra: { isNew?: boolean } = {},
): Promise<TokenPair> {
  const accessToken = await signAccessToken(
    config.JWT_SECRET,
    { userId: session.userId, deviceId: session.deviceId, role: session.role },
    { now, ttlSeconds: config.ACCESS_TOKEN_TTL_SECONDS },
  );
  return {
    accessToken,
    refreshToken: session.refreshToken,
    accessTokenExpiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    user: extra.isNew === undefined ? { id: session.userId, role: session.role } : { id: session.userId, role: session.role, isNew: extra.isNew },
    deviceId: session.deviceId,
  };
}
