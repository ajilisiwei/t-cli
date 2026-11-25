import type { ServerResponse } from 'node:http';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLlmClient, TEMPERATURE, type DeepSeekConfig, type LlmClientOptions } from '../src/modules/ai/llm.ts';
import { AppError } from '../src/http/errors.ts';
import type { ChatMessage } from '../src/ports.ts';
import { fakeUpstream, sse, sseDelta as delta, sseFinish as finish, startSse } from './helpers/ai.ts';

const API_KEY = 'sk-test-0123456789';
const MESSAGES: readonly ChatMessage[] = [
  { role: 'system', content: 'system prompt' },
  { role: 'user', content: 'user text' },
];

function client(baseUrl: string, options: LlmClientOptions = {}, overrides: Partial<DeepSeekConfig> = {}) {
  return createLlmClient({ DEEPSEEK_API_KEY: API_KEY, DEEPSEEK_MODEL: 'test-model', DEEPSEEK_BASE_URL: baseUrl, ...overrides }, options);
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const isUpstreamError = (pattern?: RegExp) => (error: unknown) =>
  error instanceof AppError && error.statusCode === 502 && error.code === 'AI_UPSTREAM' && (!pattern || pattern.test(error.message));

describe('DeepSeek client', () => {
  test('sends the CLI-equivalent request and yields content deltas in order', async (t) => {
    const upstream = await fakeUpstream(t, async (_req, res) => {
      startSse(res);
      res.write(sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }));
      res.write(': keep-alive\n\n');
      res.write(delta('Hel'));
      await sleep(5);
      res.write(delta('lo 优'));
      res.write(finish);
      res.end(sse('[DONE]'));
    });
    const chunks = await collect(client(`${upstream.baseUrl}/`).streamChat(MESSAGES, { signal: new AbortController().signal }));
    assert.deepEqual(chunks, ['Hel', 'lo 优']);

    const [request] = upstream.requests;
    assert.equal(request?.method, 'POST');
    assert.equal(request?.url, '/chat/completions');
    assert.equal(request?.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(request?.headers.accept, 'text/event-stream');
    assert.deepEqual(JSON.parse(request?.body ?? ''), {
      model: 'test-model',
      messages: MESSAGES,
      temperature: TEMPERATURE,
      stream: true,
      stream_options: { include_usage: true },
    });
    assert.equal(TEMPERATURE, 0.3, 'same temperature as the CLI');
  });

  test('streamChat sends thinking: false as the disabled switch', async (t) => {
    const upstream = await fakeUpstream(t, (_req, res) => {
      startSse(res);
      res.end(delta('ok') + finish + sse('[DONE]'));
    });
    const stream = client(upstream.baseUrl).streamChat(MESSAGES, { signal: new AbortController().signal, thinking: false });
    assert.deepEqual(await collect(stream), ['ok']);
    assert.deepEqual((JSON.parse(upstream.requests[0]?.body ?? '') as Record<string, unknown>)['thinking'], { type: 'disabled' });
  });

  test('a base URL with a path prefix keeps it', async (t) => {
    const upstream = await fakeUpstream(t, (_req, res) => {
      startSse(res);
      res.end(delta('ok') + sse('[DONE]'));
    });
    await collect(client(`${upstream.baseUrl}/v1`).streamChat(MESSAGES, { signal: new AbortController().signal }));
    assert.equal(upstream.requests[0]?.url, '/v1/chat/completions');
  });

  test('byte-by-byte network chunks, split inside multi-byte characters, reassemble exactly', async (t) => {
    const text = 'prioritize /praɪˈɔːr.ə.taɪz/ 优先考虑 🙂';
    const upstream = await fakeUpstream(t, async (_req, res) => {
      startSse(res);
      const bytes = Buffer.from(delta(text.slice(0, 12)) + delta(text.slice(12)) + finish + sse('[DONE]'));
      for (let i = 0; i < bytes.length; i += 3) {
        res.write(bytes.subarray(i, i + 3));
        if (i % 30 === 0) await sleep(1);
      }
      res.end();
    });
    const chunks = await collect(client(upstream.baseUrl).streamChat(MESSAGES, { signal: new AbortController().signal }));
    assert.equal(chunks.join(''), text);
  });

  test('HTTP errors map to 502 AI_UPSTREAM without leaking the key or upstream text', async (t) => {
    for (const status of [400, 401, 402, 429, 500, 503]) {
      const upstream = await fakeUpstream(t, (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `upstream says no (${API_KEY})` } }));
      });
      await assert.rejects(
        collect(client(upstream.baseUrl).streamChat(MESSAGES, { signal: new AbortController().signal })),
        (error: unknown) => {
          const { message } = error as Error;
          return isUpstreamError(new RegExp(`HTTP ${status}`))(error) && !message.includes(API_KEY) && !message.includes('says no');
        },
      );
    }
  });

  test('no API key → 503 AI_UNAVAILABLE without any request', async (t) => {
    const upstream = await fakeUpstream(t, (_req, res) => {
      res.end();
    });
    await assert.rejects(
      collect(client(upstream.baseUrl, {}, { DEEPSEEK_API_KEY: undefined }).streamChat(MESSAGES, { signal: new AbortController().signal })),
      (error: unknown) => error instanceof AppError && error.statusCode === 503 && error.code === 'AI_UNAVAILABLE',
    );
    assert.equal(upstream.requests.length, 0);
  });

  test('connect timeout: no response headers in time → 502', async (t) => {
    const upstream = await fakeUpstream(t, () => {
      /* never answers */
    });
    const startedAt = Date.now();
    await assert.rejects(
      collect(client(upstream.baseUrl, { connectTimeoutMs: 100 }).streamChat(MESSAGES, { signal: new AbortController().signal })),
      isUpstreamError(/timed out/),
    );
    assert.ok(Date.now() - startedAt < 2000);
  });

  test('overall timeout: a stream that stalls after the first delta → 502 after the delta', async (t) => {
    const upstream = await fakeUpstream(t, (_req, res) => {
      startSse(res);
      res.write(delta('partial'));
    });
    const chunks: string[] = [];
    await assert.rejects(
      (async () => {
        const stream = client(upstream.baseUrl, { totalTimeoutMs: 300 }).streamChat(MESSAGES, { signal: new AbortController().signal });
        for await (const chunk of stream) chunks.push(chunk);
      })(),
      isUpstreamError(/timed out/),
    );
    assert.deepEqual(chunks, ['partial']);
  });

  test("the caller's abort cancels the upstream request and rethrows the caller's reason", async (t) => {
    const upstream = await fakeUpstream(t, (_req, res) => {
      startSse(res);
      res.write(delta('first'));
    });
    const controller = new AbortController();
    const reason = new Error('client went away');
    const stream = client(upstream.baseUrl).streamChat(MESSAGES, { signal: controller.signal });
    await assert.rejects(
      (async () => {
        for await (const chunk of stream) {
          assert.equal(chunk, 'first');
          controller.abort(reason);
        }
      })(),
      (error: unknown) => error === reason,
    );
    await upstream.clientWentAway;
  });

  test('a clean EOF without [DONE] or finish_reason is a truncated answer → 502; with finish_reason it is fine', async (t) => {
    const truncated = await fakeUpstream(t, (_req, res) => {
      startSse(res);
      res.end(delta('half an ans'));
    });
    await assert.rejects(
      collect(client(truncated.baseUrl).streamChat(MESSAGES, { signal: new AbortController().signal })),
      isUpstreamError(/ended unexpectedly/),
    );

    const finished = await fakeUpstream(t, (_req, res) => {
      startSse(res);
      res.end(delta('whole') + finish);
    });
    assert.deepEqual(await collect(client(finished.baseUrl).streamChat(MESSAGES, { signal: new AbortController().signal })), ['whole']);
  });

  test('an in-band error event and a dropped connection are 502', async (t) => {
    const inBand = await fakeUpstream(t, (_req, res) => {
      startSse(res);
      res.end(delta('a') + sse({ error: { message: 'overloaded' } }));
    });
    await assert.rejects(
      collect(client(inBand.baseUrl).streamChat(MESSAGES, { signal: new AbortController().signal })),
      isUpstreamError(),
    );

    const dropped = await fakeUpstream(t, async (_req, res) => {
      startSse(res);
      res.write(delta('a'));
      await sleep(10);
      res.socket?.destroy();
    });
    await assert.rejects(
      collect(client(dropped.baseUrl).streamChat(MESSAGES, { signal: new AbortController().signal })),
      isUpstreamError(/request failed/),
    );
  });

  test('an unreachable upstream is 502', async (t) => {
    const upstream = await fakeUpstream(t, (_req, res) => {
      res.end();
    });
    const deadUrl = upstream.baseUrl.replace(/:\d+$/, ':1');
    await assert.rejects(
      collect(client(deadUrl).streamChat(MESSAGES, { signal: new AbortController().signal })),
      isUpstreamError(/request failed/),
    );
  });
});

describe('DeepSeek client: token usage', () => {
  test('streamChat reports the usage chunk sent after the finish chunk', async (t) => {
    const upstream = await fakeUpstream(t, (_req, res) => {
      startSse(res);
      res.write(delta('Hello'));
      res.write(finish);
      res.write(sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 } }));
      res.end(sse('[DONE]'));
    });
    const reports: unknown[] = [];
    const chunks = await collect(
      client(upstream.baseUrl).streamChat(MESSAGES, { signal: new AbortController().signal, onUsage: (usage) => reports.push(usage) }),
    );
    assert.deepEqual(chunks, ['Hello']);
    assert.deepEqual(reports, [{ promptTokens: 12, completionTokens: 30 }]);
  });

  test('a stream without (or with a malformed) usage chunk reports nothing and still succeeds', async (t) => {
    const upstream = await fakeUpstream(t, (_req, res) => {
      startSse(res);
      res.end(delta('ok') + sse({ choices: [], usage: { total_tokens: 3 } }) + finish + sse('[DONE]'));
    });
    const reports: unknown[] = [];
    const chunks = await collect(
      client(upstream.baseUrl).streamChat(MESSAGES, { signal: new AbortController().signal, onUsage: (usage) => reports.push(usage) }),
    );
    assert.deepEqual(chunks, ['ok']);
    assert.deepEqual(reports, []);
  });
});

describe('DeepSeek client: completeJson', () => {
  const completion = (content: string | null, usage?: unknown) =>
    JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: 'thinking' }, finish_reason: 'stop' }], usage });
  const json = (res: ServerResponse, body: string, status = 200): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };
  const ask = (baseUrl: string, options: LlmClientOptions = {}, overrides: Partial<DeepSeekConfig> = {}) =>
    client(baseUrl, options, overrides).completeJson(MESSAGES, { signal: new AbortController().signal, maxTokens: 100 });

  test('sends a JSON-mode request with max_tokens and returns the content with the reported usage', async (t) => {
    const upstream = await fakeUpstream(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // DeepSeek keeps slow requests alive with blank lines before the body.
      res.write('\n\n');
      res.end(completion('{"a":1}', { prompt_tokens: 70, completion_tokens: 900, total_tokens: 970, completion_tokens_details: { reasoning_tokens: 850 } }));
    });
    const result = await client(upstream.baseUrl).completeJson(MESSAGES, { signal: new AbortController().signal, maxTokens: 4096 });
    assert.deepEqual(result, { content: '{"a":1}', usage: { promptTokens: 70, completionTokens: 900 } });
    const [request] = upstream.requests;
    assert.equal(request?.url, '/chat/completions');
    assert.equal(request?.headers.authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(JSON.parse(request?.body ?? ''), {
      model: 'test-model',
      messages: MESSAGES,
      temperature: TEMPERATURE,
      response_format: { type: 'json_object' },
      max_tokens: 4096,
      stream: false,
    });
  });

  test('thinking: false and true are sent as the thinking switch; omitted, the model default applies', async (t) => {
    const upstream = await fakeUpstream(t, (_req, res) => json(res, completion('{}')));
    const signal = new AbortController().signal;
    await client(upstream.baseUrl).completeJson(MESSAGES, { signal, maxTokens: 10, thinking: false });
    await client(upstream.baseUrl).completeJson(MESSAGES, { signal, maxTokens: 10, thinking: true });
    await client(upstream.baseUrl).completeJson(MESSAGES, { signal, maxTokens: 10 });
    const sent = upstream.requests.map((request) => (JSON.parse(request.body) as Record<string, unknown>)['thinking']);
    assert.deepEqual(sent, [{ type: 'disabled' }, { type: 'enabled' }, undefined]);
  });

  test('without usage the tokens are estimated as code points / 2', async (t) => {
    const upstream = await fakeUpstream(t, (_req, res) => json(res, completion('{"word":"苹果"}')));
    // "system prompt" (13) → 7, "user text" (9) → 5; '{"word":"苹果"}' (13 code points) → 7.
    assert.deepEqual((await ask(upstream.baseUrl)).usage, { promptTokens: 12, completionTokens: 7 });
  });

  test('a truncated or empty answer is returned as is, for the caller to reject', async (t) => {
    const upstream = await fakeUpstream(t, (_req, res) =>
      json(res, JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 100 } })),
    );
    assert.deepEqual(await ask(upstream.baseUrl), { content: '', usage: { promptTokens: 5, completionTokens: 100 } });
  });

  test('HTTP errors, malformed bodies and timeouts are 502; no key is 503 without a request', async (t) => {
    const failing = await fakeUpstream(t, (_req, res) => json(res, JSON.stringify({ error: { message: `no (${API_KEY})` } }), 500));
    await assert.rejects(ask(failing.baseUrl), (error: unknown) => isUpstreamError(/HTTP 500/)(error) && !(error as Error).message.includes(API_KEY));

    const malformed = await fakeUpstream(t, (_req, res) => json(res, '{"choices": ['));
    await assert.rejects(ask(malformed.baseUrl), isUpstreamError(/malformed/));

    const unexpected = await fakeUpstream(t, (_req, res) => json(res, '{"choices": []}'));
    await assert.rejects(ask(unexpected.baseUrl), isUpstreamError(/unexpected/));

    const stalled = await fakeUpstream(t, () => {
      /* never answers */
    });
    await assert.rejects(ask(stalled.baseUrl, { jsonTimeoutMs: 100 }), isUpstreamError(/timed out/));
    await assert.rejects(
      ask(stalled.baseUrl, {}, { DEEPSEEK_API_KEY: undefined }),
      (error: unknown) => error instanceof AppError && error.statusCode === 503 && error.code === 'AI_UNAVAILABLE',
    );
    assert.equal(stalled.requests.length, 1, 'the request without a key never left');
  });

  test("the caller's abort rethrows the caller's reason", async (t) => {
    const upstream = await fakeUpstream(t, () => {
      /* never answers */
    });
    const controller = new AbortController();
    const reason = new Error('run stopped');
    const pending = client(upstream.baseUrl).completeJson(MESSAGES, { signal: controller.signal, maxTokens: 10 });
    setTimeout(() => controller.abort(reason), 20);
    await assert.rejects(pending, (error: unknown) => error === reason);
  });
});
