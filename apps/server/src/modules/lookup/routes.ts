import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { AppError, loggableError, notFound, ok } from '../../http/errors.ts';
import { createRateLimiter } from '../../lib/rateLimit.ts';
import { LookupBody } from './lexicon.ts';
import { ownsEntry } from './repo.ts';
import { createLookupMeter, lookupWord } from './service.ts';

// 64 + 2000 code points of JSON-escaped text fit comfortably.
const BODY_LIMIT_BYTES = 64 * 1024;

const codePoints = (text: string): number => [...text].length;

/**
 * 点词查词 (docs/api-v1.md, "v2 → Lookup"):
 *
 *   POST /v1/lookup  → { lemma, lang, entry, context, cached }
 *
 * Order of checks: auth → validation → enabled → per-minute limit →
 * `entryId` → (service) lexicon → daily quota → model → NOT_A_WORD. One log
 * line per request with sizes, timings, token counts, `cached` and the
 * outcome — never the word, the sentence or the lemma.
 */
export async function registerLookupRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { config } = deps;
  const authenticate = requireAuth(config.JWT_SECRET, deps.clock, deps.db);
  const perMinute = createRateLimiter({ limit: config.LOOKUP_REQUESTS_PER_MINUTE, windowMs: 60_000 });

  app.post('/v1/lookup', { preHandler: authenticate, bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
    const startedAt = performance.now();
    const { userId } = authOf(request);
    const body = LookupBody.parse(request.body);
    const meter = createLookupMeter();
    const fields = {
      userId,
      entryId: body.entryId ?? null,
      wordChars: codePoints(body.word),
      wordTokens: body.word.split(' ').length,
      sentenceChars: body.sentence === undefined ? 0 : codePoints(body.sentence),
    };
    const log = (level: 'info' | 'warn' | 'error', outcome: string, extra: Record<string, unknown> = {}): void => {
      request.log[level]({ ...fields, ...meter.stats(), ...extra, totalMs: Math.round(performance.now() - startedAt), outcome }, 'lookup request');
    };

    if (!config.LOOKUP_ENABLED) {
      log('info', 'disabled');
      throw new AppError(503, 'LOOKUP_DISABLED', 'word lookup is disabled');
    }

    const minute = perMinute.hit(userId, deps.clock().getTime());
    if (!minute.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(minute.retryAfterMs / 1000));
      log('info', 'rate_limited');
      reply.header('retry-after', String(retryAfterSeconds));
      throw new AppError(429, 'RATE_LIMITED', 'too many lookups, slow down', { retryAfterSeconds });
    }

    if (body.entryId !== undefined && !(await ownsEntry(deps.db, userId, body.entryId))) {
      log('info', 'entry_not_found');
      throw notFound('entry');
    }

    try {
      const result = await lookupWord(deps, { userId, word: body.word, sentence: body.sentence }, meter, request.log);
      log('info', 'ok', { cached: result.cached, withContext: result.context !== null, withPhrase: result.context?.phrase != null });
      return ok(result);
    } catch (error) {
      if (error instanceof AppError) {
        log(error.statusCode >= 500 ? 'warn' : 'info', error.code.toLowerCase(), { errorCode: error.code });
      } else {
        log('error', 'internal', loggableError(error));
      }
      throw error;
    }
  });
}
