import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { containsCJK } from '@t-cli/core/detect';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { AppError, loggableError, notFound } from '../../http/errors.ts';
import { createByteLruCache } from '../../lib/byteLruCache.ts';
import { createRateLimiter } from '../../lib/rateLimit.ts';
import { speakableText, targetOf, TtsBody } from './targets.ts';

/** Longest text read aloud, in code points. */
export const TTS_TEXT_MAX_CHARS = 1000;
/** Same neural voices as the CLI's `/say` (apps/cli/src/tts.js). */
export const TTS_VOICES = Object.freeze({ zh: 'zh-CN-XiaoxiaoNeural', en: 'en-US-AriaNeural' });

/** Text containing CJK → the Chinese voice, otherwise American English. */
export function voiceFor(text: string): string {
  return containsCJK(text) ? TTS_VOICES.zh : TTS_VOICES.en;
}

const sinceMs = (startedAt: number): number => Math.round(performance.now() - startedAt);

/**
 * Speech (docs/api-v1.md, "Speech" and "Speech (extended)"):
 *
 *   POST /v1/tts  → audio/mpeg for one of the caller's entries, cards, items
 *                   or daily stories
 *
 * The client names a target, never free text: the server picks what to read
 * (targets.ts), so the endpoint cannot be used as a general TTS proxy.
 * Order of checks: auth → validation → enabled → per-minute limit → target →
 * text → cache → upstream. Logs sizes, timings and outcomes only — never the
 * text.
 */
export async function registerTtsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { config } = deps;
  const authenticate = requireAuth(config.JWT_SECRET, deps.clock, deps.db);
  const perMinute = createRateLimiter({ limit: config.TTS_REQUESTS_PER_MINUTE, windowMs: 60_000 });
  const cache = createByteLruCache({ maxBytes: config.TTS_CACHE_MAX_BYTES });

  app.post('/v1/tts', { preHandler: authenticate, bodyLimit: 4 * 1024 }, async (request, reply) => {
    const startedAt = performance.now();
    const { userId } = authOf(request);
    const target = targetOf(TtsBody.parse(request.body));
    const log = (level: 'info' | 'warn', outcome: string, extra: Record<string, unknown> = {}): void => {
      request.log[level]({ userId, target: target.kind, targetId: target.id, ...extra, totalMs: sinceMs(startedAt), outcome }, 'tts request');
    };

    if (!config.TTS_ENABLED) {
      log('info', 'disabled');
      throw new AppError(503, 'TTS_UNAVAILABLE', 'text to speech is disabled');
    }

    const limit = perMinute.hit(userId, deps.clock().getTime());
    if (!limit.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
      log('info', 'rate_limited');
      reply.header('retry-after', String(retryAfterSeconds));
      throw new AppError(429, 'RATE_LIMITED', 'too many speech requests, slow down', { retryAfterSeconds });
    }

    const text = await speakableText(deps.db, userId, target);
    if (text === null) {
      log('info', 'not_found');
      throw notFound(target.kind);
    }
    const textChars = [...text].length;
    if (textChars === 0) {
      log('info', 'nothing_to_speak');
      throw new AppError(422, 'NOTHING_TO_SPEAK', `the ${target.kind} has no text to read aloud`);
    }
    if (textChars > TTS_TEXT_MAX_CHARS) {
      log('info', 'text_too_long', { textChars });
      throw new AppError(422, 'TEXT_TOO_LONG', `the text to read aloud exceeds ${TTS_TEXT_MAX_CHARS} characters`);
    }

    const voice = voiceFor(text);
    const cacheKey = `${voice}\n${text}`;
    let audio = cache.get(cacheKey);
    const cacheHit = audio !== undefined;
    if (audio === undefined) {
      const synthStartedAt = performance.now();
      const signal = AbortSignal.timeout(config.TTS_TIMEOUT_MS);
      try {
        audio = await deps.tts.synthesize(text, voice, { signal });
        if (audio.byteLength === 0) throw new Error('empty audio');
      } catch (error) {
        log('warn', 'upstream_error', { voice, textChars, timedOut: signal.aborted, synthMs: sinceMs(synthStartedAt), ...loggableError(error) });
        throw new AppError(502, 'TTS_UPSTREAM', 'text to speech failed');
      }
      cache.set(cacheKey, audio);
    }

    log('info', 'ok', { voice, textChars, bytes: audio.byteLength, cacheHit, cacheBytes: cache.bytes });
    return reply
      .header('content-type', 'audio/mpeg')
      .header('cache-control', 'private, max-age=86400')
      .send(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
  });
}
