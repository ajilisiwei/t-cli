import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { containsCJK } from '@t-cli/core/detect';
import { splitSpeechParts } from '@t-cli/core/speechParts';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { AppError, loggableError, notFound } from '../../http/errors.ts';
import { createByteLruCache } from '../../lib/byteLruCache.ts';
import { createRateLimiter } from '../../lib/rateLimit.ts';
import { loggableTarget, speakableText, targetOf, TtsBody } from './targets.ts';

/** Same neural voices as the CLI's `/say` (apps/cli/src/tts.js). */
export const TTS_VOICES = Object.freeze({ zh: 'zh-CN-XiaoxiaoNeural', en: 'en-US-AriaNeural' });

/** Text containing CJK → the Chinese voice, otherwise American English. */
export function voiceFor(text: string): string {
  return containsCJK(text) ? TTS_VOICES.zh : TTS_VOICES.en;
}

const sinceMs = (startedAt: number): number => Math.round(performance.now() - startedAt);

/**
 * Speech (docs/api-v1.md, "Speech", "Speech (extended)" and "v2 → Speech in
 * parts"):
 *
 *   POST /v1/tts  → audio/mpeg for one part of the text of one of the
 *                   caller's entries, cards, items or daily stories, or of a
 *                   cached lexicon entry
 *
 * The client names a target, never free text: the server picks what to read
 * (targets.ts), so the endpoint cannot be used as a general TTS proxy. The
 * text is split into parts of at most 1000 code points (splitSpeechParts);
 * the voice is chosen from the whole text so every part sounds the same, and
 * audio is cached per voice and part text.
 * Order of checks: auth → validation → enabled → per-minute limit → target →
 * text → part → cache → upstream. Logs sizes, timings and outcomes only —
 * never the text.
 */
export async function registerTtsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { config } = deps;
  const authenticate = requireAuth(config.JWT_SECRET, deps.clock, deps.db);
  const perMinute = createRateLimiter({ limit: config.TTS_REQUESTS_PER_MINUTE, windowMs: 60_000 });
  const cache = createByteLruCache({ maxBytes: config.TTS_CACHE_MAX_BYTES });

  app.post('/v1/tts', { preHandler: authenticate, bodyLimit: 4 * 1024 }, async (request, reply) => {
    const startedAt = performance.now();
    const { userId } = authOf(request);
    const body = TtsBody.parse(request.body);
    const target = targetOf(body);
    const log = (level: 'info' | 'warn', outcome: string, extra: Record<string, unknown> = {}): void => {
      request.log[level]({ userId, ...loggableTarget(target), part: body.part, ...extra, totalMs: sinceMs(startedAt), outcome }, 'tts request');
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
    const parts = splitSpeechParts(text);
    const textChars = [...text].length;
    if (parts.length === 0) {
      log('info', 'nothing_to_speak');
      throw new AppError(422, 'NOTHING_TO_SPEAK', `the ${target.kind} has no text to read aloud`);
    }
    const partText = parts[body.part];
    if (partText === undefined) {
      log('info', 'part_out_of_range', { textChars, parts: parts.length });
      throw new AppError(422, 'PART_OUT_OF_RANGE', `the text has ${parts.length} part(s)`, { parts: parts.length });
    }

    // One voice for the whole text, so every part sounds the same.
    const voice = voiceFor(text);
    const partChars = [...partText].length;
    const cacheKey = `${voice}\n${partText}`;
    let audio = cache.get(cacheKey);
    const cacheHit = audio !== undefined;
    if (audio === undefined) {
      const synthStartedAt = performance.now();
      const signal = AbortSignal.timeout(config.TTS_TIMEOUT_MS);
      try {
        audio = await deps.tts.synthesize(partText, voice, { signal });
        if (audio.byteLength === 0) throw new Error('empty audio');
      } catch (error) {
        log('warn', 'upstream_error', { voice, textChars, parts: parts.length, partChars, timedOut: signal.aborted, synthMs: sinceMs(synthStartedAt), ...loggableError(error) });
        throw new AppError(502, 'TTS_UPSTREAM', 'text to speech failed');
      }
      cache.set(cacheKey, audio);
    }

    log('info', 'ok', { voice, textChars, parts: parts.length, partChars, bytes: audio.byteLength, cacheHit, cacheBytes: cache.bytes });
    return reply
      .header('content-type', 'audio/mpeg')
      .header('cache-control', 'private, max-age=86400')
      .header('x-speech-part', String(body.part))
      .header('x-speech-parts', String(parts.length))
      .send(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
  });
}
