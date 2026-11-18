import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ChatMessage, LlmClient } from '../../src/ports.ts';

type QueueItem = { kind: 'chunk'; value: string } | { kind: 'error'; error: unknown } | { kind: 'end' };

/** A fake LLM driven step by step from the test; records the abort signal it was given. */
export interface ControllableLlm extends LlmClient {
  calls: (readonly ChatMessage[])[];
  signals: AbortSignal[];
  /** Resolves when streamChat started. */
  started: Promise<void>;
  /** Resolves with the abort reason once the request's signal fires. */
  aborted: Promise<unknown>;
  /** Resolves when the stream was closed (finished, failed, or closed by the consumer). */
  closed: Promise<void>;
  push(chunk: string): void;
  fail(error: unknown): void;
  finish(): void;
}

export function controllableLlm(): ControllableLlm {
  const queue: QueueItem[] = [];
  const calls: (readonly ChatMessage[])[] = [];
  const signals: AbortSignal[] = [];
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<unknown>();
  const closed = Promise.withResolvers<void>();
  let wake: (() => void) | null = null;
  const enqueue = (item: QueueItem): void => {
    queue.push(item);
    wake?.();
  };

  return {
    calls,
    signals,
    started: started.promise,
    aborted: aborted.promise,
    closed: closed.promise,
    push: (value) => enqueue({ kind: 'chunk', value }),
    fail: (error) => enqueue({ kind: 'error', error }),
    finish: () => enqueue({ kind: 'end' }),
    async *streamChat(messages, { signal }) {
      calls.push(messages);
      signals.push(signal);
      signal.addEventListener('abort', () => {
        aborted.resolve(signal.reason);
        wake?.();
      });
      started.resolve();
      try {
        for (;;) {
          signal.throwIfAborted();
          const item = queue.shift();
          if (!item) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
            continue;
          }
          if (item.kind === 'end') return;
          if (item.kind === 'error') throw item.error;
          yield item.value;
        }
      } finally {
        closed.resolve();
      }
    },
  };
}

/** Start the app on an ephemeral loopback port; returns its base URL. */
export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export interface NdjsonLine {
  type: 'meta' | 'delta' | 'done' | 'error';
  srcLang?: string;
  kind?: string;
  text?: string;
  entry?: { id: string; seq: number; kind: string; correctedInput: string | null };
  code?: string;
  message?: string;
}

/** Parse a complete NDJSON body strictly: every line is terminated and is one JSON object. */
export function parseNdjson(body: string): NdjsonLine[] {
  if (body !== '' && !body.endsWith('\n')) throw new Error('NDJSON body must end with a newline');
  return body
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line) as NdjsonLine);
}

/** Read NDJSON lines from a streaming fetch response as they arrive. */
export async function* readNdjsonLines(response: Response): AsyncGenerator<NdjsonLine> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      yield JSON.parse(buffer.slice(0, newline)) as NdjsonLine;
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer.trim() !== '') throw new Error('unterminated NDJSON line');
}

/** Reject if `promise` does not settle within `ms`. */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface FakeUpstream {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Resolves when a client closed its connection before the response finished. */
  clientWentAway: Promise<void>;
}

/** A fake DeepSeek endpoint on an ephemeral loopback port, closed after the test. */
export async function fakeUpstream(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  const wentAway = Promise.withResolvers<void>();
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      void handler(req, res);
    });
    res.on('close', () => {
      if (!res.writableFinished) wentAway.resolve();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests, clientWentAway: wentAway.promise };
}

/** One SSE event carrying `payload` (a string is sent verbatim, e.g. "[DONE]"). */
export const sse = (payload: unknown): string => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
export const sseDelta = (content: string): string => sse({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
export const sseFinish = sse({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] });

export function startSse(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.flushHeaders();
}
