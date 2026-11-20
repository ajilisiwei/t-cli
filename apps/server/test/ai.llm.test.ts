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
    });
    assert.equal(TEMPERATURE, 0.3, 'same temperature as the CLI');
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
