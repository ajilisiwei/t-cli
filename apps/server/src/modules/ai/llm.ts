import { z } from 'zod';
import type { Config } from '../../config.ts';
import { AppError } from '../../http/errors.ts';
import type { ChatMessage, LlmClient } from '../../ports.ts';
import { createSseParser } from './sse.ts';

/** The configuration the DeepSeek client needs (a subset, so scripts can build it from env). */
export type DeepSeekConfig = Pick<Config, 'DEEPSEEK_API_KEY' | 'DEEPSEEK_MODEL' | 'DEEPSEEK_BASE_URL'>;

export interface LlmClientOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Time allowed until the upstream response headers arrive. */
  connectTimeoutMs?: number;
  /** Time allowed for the whole request, streaming included. */
  totalTimeoutMs?: number;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 90_000;
/** Same sampling temperature as the CLI (apps/cli/src/api.js). */
export const TEMPERATURE = 0.3;

const ChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().nullish() }).nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  error: z.unknown().optional(),
});

const upstreamError = (message: string) => new AppError(502, 'AI_UPSTREAM', message);

type StreamEvent = { kind: 'done' } | { kind: 'chunk'; content: string; finished: boolean };

/** Interpret one SSE `data` payload of a chat-completion stream. */
export function parseStreamEvent(data: string): StreamEvent {
  if (data === '[DONE]') return { kind: 'done' };
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    // With line buffering a broken payload means the upstream misbehaved;
    // skipping it could silently drop part of the answer.
    throw upstreamError('AI upstream sent a malformed event');
  }
  const parsed = ChunkSchema.safeParse(json);
  if (!parsed.success) throw upstreamError('AI upstream sent an unexpected event');
  if (parsed.data.error !== undefined) throw upstreamError('AI upstream reported an error mid-stream');
  const choices = parsed.data.choices ?? [];
  return {
    kind: 'chunk',
    content: choices.map((choice) => choice.delta?.content ?? '').join(''),
    finished: choices.some((choice) => Boolean(choice.finish_reason)),
  };
}

function chatCompletionsUrl(baseUrl: string): string {
  return new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

/**
 * DeepSeek streaming chat client (OpenAI-compatible SSE).
 *
 * Errors: no API key → 503 AI_UNAVAILABLE; HTTP, network, timeout and protocol
 * failures → 502 AI_UPSTREAM. When the caller's signal fires, the upstream
 * request is aborted and the caller's abort reason is rethrown unchanged, so
 * the caller can tell "client went away" from "upstream failed".
 * Nothing here logs: messages carry user text, headers carry the API key.
 */
export function createLlmClient(config: DeepSeekConfig, options: LlmClientOptions = {}): LlmClient {
  const fetchImpl = options.fetch ?? fetch;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const url = chatCompletionsUrl(config.DEEPSEEK_BASE_URL);

  return {
    isAvailable: () => Boolean(config.DEEPSEEK_API_KEY),
    async *streamChat(messages: readonly ChatMessage[], { signal }: { signal: AbortSignal }) {
      const apiKey = config.DEEPSEEK_API_KEY;
      if (!apiKey) throw new AppError(503, 'AI_UNAVAILABLE', 'AI service is not configured');
      signal.throwIfAborted();

      const connectTimeout = new AbortController();
      const connectTimer = setTimeout(() => connectTimeout.abort(), connectTimeoutMs);
      const totalTimeout = AbortSignal.timeout(totalTimeoutMs);
      const combined = AbortSignal.any([signal, connectTimeout.signal, totalTimeout]);

      const mapError = (error: unknown): unknown => {
        if (signal.aborted) return error; // the caller's own abort
        if (error instanceof AppError) return error;
        if (connectTimeout.signal.aborted || totalTimeout.aborted) return upstreamError('AI upstream timed out');
        return upstreamError('AI upstream request failed');
      };

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: config.DEEPSEEK_MODEL,
            messages,
            temperature: TEMPERATURE,
            stream: true,
          }),
          signal: combined,
        });
      } catch (error) {
        throw mapError(error);
      } finally {
        clearTimeout(connectTimer);
      }

      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw upstreamError(`AI upstream returned HTTP ${response.status}`);
      }

      const parser = createSseParser();
      let finished = false;
      try {
        for await (const chunk of response.body) {
          for (const data of parser.push(chunk)) {
            const event = parseStreamEvent(data);
            if (event.kind === 'done') return;
            finished ||= event.finished;
            if (event.content) yield event.content;
          }
        }
        for (const data of parser.end()) {
          const event = parseStreamEvent(data);
          if (event.kind === 'done') return;
          finished ||= event.finished;
          if (event.content) yield event.content;
        }
      } catch (error) {
        throw mapError(error);
      }
      // A clean EOF without [DONE] or a finish_reason means a truncated answer.
      if (!finished) throw upstreamError('AI upstream stream ended unexpectedly');
    },
  };
}
