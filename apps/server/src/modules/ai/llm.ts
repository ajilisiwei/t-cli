import { z } from 'zod';
import type { Config } from '../../config.ts';
import { AppError } from '../../http/errors.ts';
import type { ChatMessage, JsonCompletion, LlmClient, LlmUsage } from '../../ports.ts';
import { createSseParser } from './sse.ts';
import { estimatePromptTokens, estimateTokens, parseUsage } from './usage.ts';

/** The configuration the DeepSeek client needs (a subset, so scripts can build it from env). */
export type DeepSeekConfig = Pick<Config, 'DEEPSEEK_API_KEY' | 'DEEPSEEK_MODEL' | 'DEEPSEEK_BASE_URL'>;

export interface LlmClientOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Time allowed until the upstream response headers arrive. */
  connectTimeoutMs?: number;
  /** Time allowed for the whole request, streaming included. */
  totalTimeoutMs?: number;
  /** Time allowed for one JSON completion (no streaming, so no separate connect timeout). */
  jsonTimeoutMs?: number;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 90_000;
/** A nightly batch answer can take minutes with reasoning tokens. */
export const DEFAULT_JSON_TIMEOUT_MS = 300_000;
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
  // With stream_options.include_usage the last chunk (choices: []) carries the usage.
  usage: z.unknown().optional(),
  error: z.unknown().optional(),
});

const CompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish() }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z.unknown().optional(),
});

const upstreamError = (message: string) => new AppError(502, 'AI_UPSTREAM', message);

type StreamEvent = { kind: 'done' } | { kind: 'chunk'; content: string; finished: boolean; usage?: LlmUsage };

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
  const usage = parseUsage(parsed.data.usage);
  return {
    kind: 'chunk',
    content: choices.map((choice) => choice.delta?.content ?? '').join(''),
    finished: choices.some((choice) => Boolean(choice.finish_reason)),
    ...(usage ? { usage } : {}),
  };
}

/** DeepSeek's reasoning switch; nothing when the caller leaves the model's default. */
function thinkingField(thinking: boolean | undefined): { thinking?: { type: 'enabled' | 'disabled' } } {
  return thinking === undefined ? {} : { thinking: { type: thinking ? 'enabled' : 'disabled' } };
}

function chatCompletionsUrl(baseUrl: string): string {
  return new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

/**
 * DeepSeek chat client (OpenAI-compatible): SSE streaming for the AI proxy,
 * JSON mode for the nightly pipeline.
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
  const jsonTimeoutMs = options.jsonTimeoutMs ?? DEFAULT_JSON_TIMEOUT_MS;
  const url = chatCompletionsUrl(config.DEEPSEEK_BASE_URL);

  const requireKey = (): string => {
    const apiKey = config.DEEPSEEK_API_KEY;
    if (!apiKey) throw new AppError(503, 'AI_UNAVAILABLE', 'AI service is not configured');
    return apiKey;
  };

  return {
    isAvailable: () => Boolean(config.DEEPSEEK_API_KEY),

    async *streamChat(messages, { signal, onUsage, thinking }) {
      const apiKey = requireKey();
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
            stream_options: { include_usage: true },
            ...thinkingField(thinking),
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
      /** The content of one event; null at [DONE]. */
      const contentOf = (data: string): string | null => {
        const event = parseStreamEvent(data);
        if (event.kind === 'done') return null;
        finished ||= event.finished;
        if (event.usage) onUsage?.(event.usage);
        return event.content;
      };
      try {
        for await (const chunk of response.body) {
          for (const data of parser.push(chunk)) {
            const content = contentOf(data);
            if (content === null) return;
            if (content) yield content;
          }
        }
        for (const data of parser.end()) {
          const content = contentOf(data);
          if (content === null) return;
          if (content) yield content;
        }
      } catch (error) {
        throw mapError(error);
      }
      // A clean EOF without [DONE] or a finish_reason means a truncated answer.
      if (!finished) throw upstreamError('AI upstream stream ended unexpectedly');
    },

    // The content is returned as sent: when the model hit `maxTokens` it may be
    // truncated or empty, which the caller's JSON validation then rejects.
    async completeJson(messages, { signal, maxTokens, thinking }): Promise<JsonCompletion> {
      const apiKey = requireKey();
      signal.throwIfAborted();
      const timeout = AbortSignal.timeout(jsonTimeoutMs);
      const combined = AbortSignal.any([signal, timeout]);
      const mapError = (error: unknown): unknown => {
        if (signal.aborted) return error;
        if (error instanceof AppError) return error;
        if (timeout.aborted) return upstreamError('AI upstream timed out');
        return upstreamError('AI upstream request failed');
      };

      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: config.DEEPSEEK_MODEL,
            messages,
            temperature: TEMPERATURE,
            response_format: { type: 'json_object' },
            max_tokens: maxTokens,
            stream: false,
            ...thinkingField(thinking),
          }),
          signal: combined,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw upstreamError(`AI upstream returned HTTP ${response.status}`);
        }
        // DeepSeek keeps a slow non-streaming request alive with blank lines before the JSON.
        let json: unknown;
        try {
          json = JSON.parse(await response.text());
        } catch (error) {
          if (combined.aborted) throw error;
          throw upstreamError('AI upstream sent a malformed response');
        }
        const parsed = CompletionSchema.safeParse(json);
        if (!parsed.success) throw upstreamError('AI upstream sent an unexpected response');
        const content = parsed.data.choices[0]?.message.content ?? '';
        const usage = parseUsage(parsed.data.usage) ?? {
          promptTokens: estimatePromptTokens(messages),
          completionTokens: estimateTokens(content),
        };
        return { content, usage };
      } catch (error) {
        throw mapError(error);
      }
    },
  };
}
