import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/http/errors.ts';
import { createWechatClient } from '../src/modules/auth/wechat.ts';
import { testConfig } from './helpers/app.ts';

const APPID = 'wx-test-appid';
const SECRET = 'wechat-app-secret-never-logged';
const configured = testConfig({ WECHAT_APPID: APPID, WECHAT_SECRET: SECRET });

/** A fetch double that records the requested URL and answers with `respond`. */
function fakeFetch(respond: (url: URL, init?: RequestInit) => Promise<Response> | Response) {
  const calls: URL[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    return respond(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'text/plain' } });

async function expectAppError(promise: Promise<unknown>, statusCode: number, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(SECRET) && !error.message.includes('the-login-code'), 'no secret or code in the message');
    return error;
  }
  assert.fail('expected a rejection');
}

describe('auth: WeChat code2Session client', () => {
  test('without WECHAT_APPID / WECHAT_SECRET it is unavailable and never calls out', async () => {
    const { impl, calls } = fakeFetch(() => json({ openid: 'o' }));
    const partial: Record<string, string>[] = [{}, { WECHAT_APPID: APPID }, { WECHAT_SECRET: SECRET }];
    for (const overrides of partial) {
      const client = createWechatClient(testConfig(overrides), { fetch: impl });
      await expectAppError(client.code2Session('the-login-code'), 503, 'WECHAT_UNAVAILABLE');
    }
    assert.equal(calls.length, 0);
  });

  test('calls jscode2session with the app credentials and returns only the ids', async () => {
    const { impl, calls } = fakeFetch(() => json({ openid: 'o-123', session_key: 'sk-secret', unionid: 'u-9' }));
    const session = await createWechatClient(configured, { fetch: impl }).code2Session('the-login-code');
    assert.deepEqual(session, { openid: 'o-123', unionid: 'u-9' }, 'session_key is dropped');

    const [url] = calls;
    assert.equal(url?.origin + url!.pathname, 'https://api.weixin.qq.com/sns/jscode2session');
    assert.deepEqual(Object.fromEntries(url!.searchParams), {
      appid: APPID,
      secret: SECRET,
      js_code: 'the-login-code',
      grant_type: 'authorization_code',
    });

    const { impl: noUnion } = fakeFetch(() => json({ openid: 'o-1', session_key: 'sk' }));
    assert.deepEqual(await createWechatClient(configured, { fetch: noUnion }).code2Session('c'), { openid: 'o-1' });
  });

  test('errcodes about the code map to WECHAT_CODE_INVALID, the rest to WECHAT_UNAVAILABLE', async () => {
    for (const errcode of [40029, 40163, 40226, 41008]) {
      const { impl } = fakeFetch(() => json({ errcode, errmsg: 'invalid code' }));
      const error = await expectAppError(createWechatClient(configured, { fetch: impl }).code2Session('the-login-code'), 401, 'WECHAT_CODE_INVALID');
      assert.equal((error as AppError & { errcode?: number }).errcode, errcode);
    }
    for (const errcode of [-1, 40013, 40125, 45011]) {
      const { impl } = fakeFetch(() => json({ errcode, errmsg: 'system error' }));
      await expectAppError(createWechatClient(configured, { fetch: impl }).code2Session('the-login-code'), 503, 'WECHAT_UNAVAILABLE');
    }
    const { impl: zero } = fakeFetch(() => json({ errcode: 0, openid: 'o-0' }));
    assert.deepEqual(await createWechatClient(configured, { fetch: zero }).code2Session('c'), { openid: 'o-0' });
  });

  test('transport failures and odd answers are WECHAT_UNAVAILABLE', async () => {
    const failures: ((url: URL) => Response | Promise<Response>)[] = [
      () => json({ errmsg: 'boom' }, 500),
      () => new Response('<html>gateway</html>', { status: 200 }),
      () => json({ session_key: 'sk' }),
      () => json({ openid: 42 }),
      (url) => Promise.reject(new TypeError(`fetch failed for ${url.toString()}`)),
    ];
    for (const respond of failures) {
      const { impl } = fakeFetch(respond);
      await expectAppError(createWechatClient(configured, { fetch: impl }).code2Session('the-login-code'), 503, 'WECHAT_UNAVAILABLE');
    }
  });

  test('a slow WeChat is cut off by the timeout', async () => {
    const { impl } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    await expectAppError(createWechatClient(configured, { fetch: impl, timeoutMs: 30 }).code2Session('the-login-code'), 503, 'WECHAT_UNAVAILABLE');
    assert.ok(Date.now() - started < 2000);
  });
});
