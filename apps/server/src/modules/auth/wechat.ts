import { z } from 'zod';
import type { Config } from '../../config.ts';
import { AppError } from '../../http/errors.ts';
import type { WechatClient } from '../../ports.ts';

const CODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session';
export const WECHAT_TIMEOUT_MS = 5000;

/**
 * code2Session errcodes caused by the login code itself (or the user behind
 * it) rather than by our configuration or WeChat's availability:
 * 40029 invalid code, 40163 code already used, 40226 high-risk user blocked,
 * 41008 missing code.
 */
const CODE_REJECTED_ERRCODES: ReadonlySet<number> = new Set([40029, 40163, 40226, 41008]);

/** A failed code2Session call; `errcode` is WeChat's (safe to log). */
export class WechatLoginError extends AppError {
  readonly errcode: number | undefined;

  constructor(statusCode: number, code: string, message: string, errcode?: number) {
    super(statusCode, code, message);
    this.name = 'WechatLoginError';
    this.errcode = errcode;
  }
}

const unavailable = (message: string, errcode?: number) => new WechatLoginError(503, 'WECHAT_UNAVAILABLE', message, errcode);

// `session_key` is deliberately not part of the schema: it is dropped on parse
// and never stored or logged.
const Code2SessionResponse = z.object({
  openid: z.string().min(1).optional(),
  unionid: z.string().min(1).optional(),
  errcode: z.number().int().optional(),
});

export interface WechatClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Real WeChat `code2Session` client. The URL carries the app secret and the
 * login code, so neither the URL nor upstream error messages are ever put into
 * errors or logs.
 */
export function createWechatClient(config: Config, { fetch: fetchImpl = fetch, timeoutMs = WECHAT_TIMEOUT_MS }: WechatClientOptions = {}): WechatClient {
  return {
    async code2Session(code) {
      const { WECHAT_APPID: appid, WECHAT_SECRET: secret } = config;
      if (!appid || !secret) throw unavailable('WeChat login is not configured');

      const url = new URL(CODE2SESSION_URL);
      url.searchParams.set('appid', appid);
      url.searchParams.set('secret', secret);
      url.searchParams.set('js_code', code);
      url.searchParams.set('grant_type', 'authorization_code');

      let raw: unknown;
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw unavailable(`WeChat answered HTTP ${response.status}`);
        // WeChat may label the JSON body text/plain, so parse it regardless.
        raw = await response.json();
      } catch (error) {
        if (error instanceof WechatLoginError) throw error;
        throw unavailable('WeChat is unreachable');
      }

      const parsed = Code2SessionResponse.safeParse(raw);
      if (!parsed.success) throw unavailable('unexpected WeChat response');
      const { openid, unionid, errcode } = parsed.data;
      if (errcode !== undefined && errcode !== 0) {
        if (CODE_REJECTED_ERRCODES.has(errcode)) {
          throw new WechatLoginError(401, 'WECHAT_CODE_INVALID', 'WeChat rejected the login code', errcode);
        }
        throw unavailable('WeChat login failed', errcode);
      }
      if (!openid) throw unavailable('WeChat response has no openid');
      return unionid ? { openid, unionid } : { openid };
    },
  };
}
