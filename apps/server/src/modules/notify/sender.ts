import { z } from 'zod';
import type { Config } from '../../config.ts';
import type { Clock } from '../../ports.ts';

/**
 * Sends one WeChat subscribe message. The job talks to this interface only,
 * so tests use a fake and never reach WeChat.
 */
export interface ReminderMessage {
  openid: string;
  templateId: string;
  /** Mini-program page the message opens. */
  page: string;
  data: Record<string, { value: string }>;
}

export interface ReminderSender {
  /** Resolves once WeChat accepted the message; rejects with ReminderSendError otherwise. */
  send(message: ReminderMessage): Promise<void>;
}

/** A failed send. `errcode` is WeChat's (safe to log); `message` never holds secrets or user data. */
export class ReminderSendError extends Error {
  readonly errcode: number | undefined;

  constructor(message: string, errcode?: number) {
    super(message);
    this.name = 'ReminderSendError';
    this.errcode = errcode;
  }
}

/** The user has no subscription left for the template (refused, or used up on WeChat's side). */
export const ERRCODE_NO_SUBSCRIPTION = 43101;

const STABLE_TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/stable_token';
const SUBSCRIBE_SEND_URL = 'https://api.weixin.qq.com/cgi-bin/message/subscribe/send';
export const WECHAT_NOTIFY_TIMEOUT_MS = 5000;
/** Refresh the cached access token this long before WeChat says it expires. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;
/** The access token was revoked or expired early: fetch a fresh one and retry once. */
const STALE_TOKEN_ERRCODES: ReadonlySet<number> = new Set([40001, 40014, 42001]);

const StableTokenResponse = z.object({
  access_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  errcode: z.number().int().optional(),
});
const SendResponse = z.object({ errcode: z.number().int().optional() });

export interface WechatSenderOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  clock?: Clock;
}

/**
 * Real sender: `subscribeMessage.send` with an access token from
 * `POST /cgi-bin/stable_token`, cached until shortly before it expires.
 *
 * The AppSecret travels only in the stable_token request body. WeChat takes
 * the (short-lived) access token only as a query parameter of the send URL,
 * so that URL — like every response body — is never logged or put into an
 * error message.
 */
export function createWechatReminderSender(
  config: Config,
  { fetch: fetchImpl = fetch, timeoutMs = WECHAT_NOTIFY_TIMEOUT_MS, clock = () => new Date() }: WechatSenderOptions = {},
): ReminderSender {
  let cached: { token: string; expiresAt: number } | null = null;

  const postJson = async (url: string | URL, body: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new ReminderSendError('WeChat is unreachable');
    }
    if (!response.ok) throw new ReminderSendError(`WeChat answered HTTP ${response.status}`);
    try {
      // WeChat may label JSON as text/plain.
      return await response.json();
    } catch {
      throw new ReminderSendError('unexpected WeChat response');
    }
  };

  const accessToken = async (): Promise<string> => {
    const now = clock().getTime();
    if (cached && now < cached.expiresAt) return cached.token;
    const { WECHAT_APPID: appid, WECHAT_SECRET: secret } = config;
    if (!appid || !secret) throw new ReminderSendError('WeChat app credentials are not configured');
    const parsed = StableTokenResponse.safeParse(
      await postJson(STABLE_TOKEN_URL, { grant_type: 'client_credential', appid, secret, force_refresh: false }),
    );
    if (!parsed.success) throw new ReminderSendError('unexpected WeChat token response');
    const { access_token: token, expires_in: expiresIn, errcode } = parsed.data;
    if (!token || !expiresIn) throw new ReminderSendError('WeChat refused the access token request', errcode);
    cached = { token, expiresAt: now + Math.max(0, expiresIn * 1000 - TOKEN_EXPIRY_MARGIN_MS) };
    return token;
  };

  const sendOnce = async (message: ReminderMessage): Promise<number> => {
    const url = new URL(SUBSCRIBE_SEND_URL);
    url.searchParams.set('access_token', await accessToken());
    const parsed = SendResponse.safeParse(
      await postJson(url, {
        touser: message.openid,
        template_id: message.templateId,
        page: message.page,
        data: message.data,
        lang: 'zh_CN',
      }),
    );
    if (!parsed.success) throw new ReminderSendError('unexpected WeChat send response');
    return parsed.data.errcode ?? 0;
  };

  return {
    async send(message) {
      let errcode = await sendOnce(message);
      if (STALE_TOKEN_ERRCODES.has(errcode)) {
        cached = null;
        errcode = await sendOnce(message);
      }
      if (errcode !== 0) throw new ReminderSendError('WeChat rejected the subscribe message', errcode);
    },
  };
}
