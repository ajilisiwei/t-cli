import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { z, ZodError } from 'zod';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { AppError, notFound, ok, unauthorized } from '../../http/errors.ts';
import { createRateLimiter, type RateLimiter } from '../../lib/rateLimit.ts';
import type { WechatClient } from '../../ports.ts';
import { DEFAULT_MP_DEVICE_NAME, getAccount, isActiveAccount, loginWithWechat } from './accounts.ts';
import {
  decideDeviceAuthorization,
  lookupDeviceAuthorization,
  pollDeviceAuthorization,
  startDeviceAuthorization,
  type DevicePollError,
} from './deviceFlow.ts';
import { listDevices, revokeDevice } from './devices.ts';
import { rotateRefreshToken } from './refresh.ts';
import { mergeSettings, SettingsPatch } from './settings.ts';
import { toTokenPair } from './tokenPair.ts';
import { normalizeInviteCode } from './tokens.ts';
import { WechatLoginError } from './wechat.ts';
import { rescheduleAccount } from '../review/cards.ts';

/** Per client IP, per endpoint, for the unauthenticated auth endpoints. */
export const AUTH_IP_LIMIT_PER_MINUTE = 30;
/** Per account, shared by device lookup and approve: bounds guessing of 6-digit user codes. */
export const DEVICE_APPROVE_LIMIT_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

const WechatLoginBody = z.object({
  code: z.string().min(1).max(256),
  // An empty invite field counts as "no invite".
  inviteCode: z.string().trim().max(64).optional(),
  deviceName: z.string().trim().min(1).max(64).optional(),
});
const RefreshBody = z.object({ refreshToken: z.string().min(1).max(1024) });
const DeviceStartBody = z.object({ deviceName: z.string().trim().min(1).max(64) });
const DeviceLookupBody = z.object({ userCode: z.string().trim().max(16) });
const DeviceApproveBody = z.object({ userCode: z.string().trim().max(16), approve: z.boolean() });
const DeviceTokenBody = z.object({ deviceCode: z.string().min(1).max(1024) });
const DeviceParams = z.object({ id: z.string().min(1).max(64) });

const POLL_MESSAGES: Record<DevicePollError, string> = {
  authorization_pending: 'waiting for the user to approve',
  slow_down: 'polling too fast; increase the interval by 5 seconds',
  expired_token: 'the device code is expired, consumed or unknown; start again',
  access_denied: 'the request was denied',
};

const refreshInvalid = () => new AppError(401, 'REFRESH_INVALID', 'refresh token is invalid, expired or revoked');
const refreshReused = () => new AppError(401, 'REFRESH_REUSED', 'refresh token was already used; the device has been signed out');

function enforceLimit(limiter: RateLimiter, key: string, now: Date, reply: FastifyReply): void {
  const result = limiter.hit(key, now.getTime());
  if (result.allowed) return;
  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
  reply.header('retry-after', String(retryAfterSeconds));
  throw new AppError(429, 'RATE_LIMITED', 'too many requests', { retryAfterSeconds });
}

/**
 * Replace unexpected errors before they reach the app's error logger.
 * Database errors carry the query parameters in their message (openids,
 * invite and user codes, token hashes), so only the error class and the
 * SQLSTATE survive.
 */
function redactInternalError(error: unknown): unknown {
  if (error instanceof AppError || error instanceof ZodError) return error;
  const root = error instanceof DrizzleQueryError ? error.cause : error;
  const name = root instanceof Error ? root.name : typeof root;
  const sqlState = root && typeof root === 'object' && 'code' in root && typeof root.code === 'string' ? `, sqlstate ${root.code}` : '';
  return new Error(`auth module internal error (${name}${sqlState})`);
}

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function guarded(handler: Handler): Handler {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      throw redactInternalError(error);
    }
  };
}

async function exchangeWechatCode(wechat: WechatClient, code: string, request: FastifyRequest): Promise<string> {
  try {
    return (await wechat.code2Session(code)).openid;
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError(503, 'WECHAT_UNAVAILABLE', 'WeChat is unavailable');
    const errcode = error instanceof WechatLoginError ? error.errcode : undefined;
    request.log.warn({ outcome: appError.code, wechatErrcode: errcode }, 'wechat code2Session failed');
    throw appError;
  }
}

/**
 * Accounts and login (docs/api-v1.md, "Auth"):
 *   POST   /v1/auth/wechat          mini-program login / invite sign-up
 *   POST   /v1/auth/refresh         refresh-token rotation
 *   POST   /v1/auth/logout          revoke the calling device
 *   POST   /v1/auth/device/start    CLI device authorization: start
 *   POST   /v1/auth/device/lookup   ... show the pending device to a logged-in client
 *   POST   /v1/auth/device/approve  ... approve from a logged-in client
 *   POST   /v1/auth/device/token    ... CLI polls for its tokens
 *   GET    /v1/me
 *   POST   /v1/me/settings          merge a partial Settings
 *   GET    /v1/devices
 *   DELETE /v1/devices/:id
 *
 * Logs carry ids and outcomes only — never tokens, codes, openids or secrets.
 */
export async function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { config, db, clock } = deps;
  const authenticate = requireAuth(config.JWT_SECRET, clock, deps.db);
  const refreshTtlDays = config.REFRESH_TOKEN_TTL_DAYS;
  const perIp = () => createRateLimiter({ limit: AUTH_IP_LIMIT_PER_MINUTE, windowMs: MINUTE_MS });
  const limits = {
    wechat: perIp(),
    refresh: perIp(),
    deviceStart: perIp(),
    deviceToken: perIp(),
    // One budget for lookup and approve: both test a guessed user code.
    deviceUserCode: createRateLimiter({ limit: DEVICE_APPROVE_LIMIT_PER_MINUTE, windowMs: MINUTE_MS }),
  };

  app.post(
    '/v1/auth/wechat',
    guarded(async (request, reply) => {
      enforceLimit(limits.wechat, request.ip, clock(), reply);
      const body = WechatLoginBody.parse(request.body);
      const openid = await exchangeWechatCode(deps.wechat, body.code, request);
      const now = clock();
      try {
        const result = await loginWithWechat(db, {
          openid,
          inviteCode: body.inviteCode ? normalizeInviteCode(body.inviteCode) : undefined,
          deviceName: body.deviceName ?? DEFAULT_MP_DEVICE_NAME,
          now,
          refreshTtlDays,
        });
        const { userId, deviceId } = result.session;
        request.log.info({ userId, deviceId, isNew: result.isNew, revokedDeviceIds: result.revokedDeviceIds }, 'wechat login');
        return ok(await toTokenPair(config, result.session, now, { isNew: result.isNew }));
      } catch (error) {
        if (error instanceof AppError) request.log.info({ outcome: error.code }, 'wechat login refused');
        throw error;
      }
    }),
  );

  app.post(
    '/v1/auth/refresh',
    guarded(async (request, reply) => {
      enforceLimit(limits.refresh, request.ip, clock(), reply);
      const { refreshToken } = RefreshBody.parse(request.body);
      const now = clock();
      const outcome = await rotateRefreshToken(db, { token: refreshToken, now, refreshTtlDays });
      switch (outcome.kind) {
        case 'invalid':
          request.log.info({ deviceId: outcome.deviceId, outcome: 'REFRESH_INVALID' }, 'refresh refused');
          throw refreshInvalid();
        case 'reused':
          request.log.warn({ userId: outcome.userId, deviceId: outcome.deviceId, outcome: 'REFRESH_REUSED' }, 'refresh token replayed; device revoked');
          throw refreshReused();
        case 'rotated': {
          const { userId, deviceId } = outcome.session;
          request.log.info({ userId, deviceId, retryGrace: outcome.viaGrace }, 'refresh token rotated');
          return ok(await toTokenPair(config, outcome.session, now));
        }
      }
    }),
  );

  app.post(
    '/v1/auth/logout',
    { preHandler: authenticate },
    guarded(async (request) => {
      const { userId, deviceId } = authOf(request);
      await revokeDevice(db, { userId, deviceId, now: clock() });
      request.log.info({ userId, deviceId }, 'logged out');
      return ok({ revoked: true });
    }),
  );

  app.post(
    '/v1/auth/device/start',
    guarded(async (request, reply) => {
      enforceLimit(limits.deviceStart, request.ip, clock(), reply);
      const { deviceName } = DeviceStartBody.parse(request.body);
      const started = await startDeviceAuthorization(db, { deviceName, now: clock() });
      request.log.info({ outcome: 'started' }, 'device authorization started');
      return ok({ ...started, qrPayload: `tcli://device?code=${started.userCode}` });
    }),
  );

  app.post(
    '/v1/auth/device/lookup',
    { preHandler: authenticate },
    guarded(async (request, reply) => {
      const { userId } = authOf(request);
      const now = clock();
      enforceLimit(limits.deviceUserCode, userId, now, reply);
      const { userCode } = DeviceLookupBody.parse(request.body);
      if (!(await isActiveAccount(db, userId))) throw unauthorized('account not found');
      const pending = await lookupDeviceAuthorization(db, { userCode, now });
      if (!pending) {
        request.log.info({ userId, outcome: 'NOT_FOUND' }, 'device authorization lookup refused');
        throw notFound('device authorization request');
      }
      request.log.info({ userId }, 'device authorization looked up');
      return ok(pending);
    }),
  );

  app.post(
    '/v1/auth/device/approve',
    { preHandler: authenticate },
    guarded(async (request, reply) => {
      const { userId } = authOf(request);
      const now = clock();
      enforceLimit(limits.deviceUserCode, userId, now, reply);
      const body = DeviceApproveBody.parse(request.body);
      if (!(await isActiveAccount(db, userId))) throw unauthorized('account not found');
      const decided = await decideDeviceAuthorization(db, { userCode: body.userCode, userId, approve: body.approve, now });
      if (!decided) {
        request.log.info({ userId, outcome: 'NOT_FOUND' }, 'device authorization decision refused');
        throw notFound('device authorization request');
      }
      request.log.info({ userId, approved: body.approve }, 'device authorization decided');
      return ok({ deviceName: decided.deviceName, approved: body.approve });
    }),
  );

  app.post(
    '/v1/auth/device/token',
    guarded(async (request, reply) => {
      enforceLimit(limits.deviceToken, request.ip, clock(), reply);
      const { deviceCode } = DeviceTokenBody.parse(request.body);
      const now = clock();
      const outcome = await pollDeviceAuthorization(db, { deviceCode, now, refreshTtlDays });
      if (outcome.kind === 'error') {
        request.log.debug({ outcome: outcome.code }, 'device token poll');
        throw new AppError(400, outcome.code, POLL_MESSAGES[outcome.code]);
      }
      const { userId, deviceId } = outcome.session;
      request.log.info({ userId, deviceId }, 'cli device authorized');
      return ok(await toTokenPair(config, outcome.session, now));
    }),
  );

  app.get(
    '/v1/me',
    { preHandler: authenticate },
    guarded(async (request) => {
      const account = await getAccount(db, authOf(request).userId);
      if (!account) throw unauthorized('account not found');
      return ok(account);
    }),
  );

  app.post(
    '/v1/me/settings',
    { preHandler: authenticate },
    guarded(async (request) => {
      const { userId } = authOf(request);
      const patch = SettingsPatch.parse(request.body);
      const settings = await mergeSettings(db, userId, patch);
      if (!settings) throw unauthorized('account not found');
      // Review by importance changes every card's retention: re-derive the stored schedules now.
      if (patch.importanceReview !== undefined) {
        const cards = await rescheduleAccount(db, userId, config.MASTERED_DAYS);
        request.log.info({ userId, cards }, 'review schedules re-derived');
      }
      request.log.info({ userId, keys: Object.keys(patch) }, 'settings updated');
      return ok({ settings });
    }),
  );

  app.get(
    '/v1/devices',
    { preHandler: authenticate },
    guarded(async (request) => {
      const { userId, deviceId } = authOf(request);
      return ok({ devices: await listDevices(db, userId, deviceId) });
    }),
  );

  app.delete(
    '/v1/devices/:id',
    { preHandler: authenticate },
    guarded(async (request) => {
      const auth = authOf(request);
      const { id } = DeviceParams.parse(request.params);
      if (!(await revokeDevice(db, { userId: auth.userId, deviceId: id, now: clock() }))) throw notFound('device');
      request.log.info({ userId: auth.userId, deviceId: id, self: id === auth.deviceId }, 'device revoked');
      return ok({ revoked: true });
    }),
  );
}
