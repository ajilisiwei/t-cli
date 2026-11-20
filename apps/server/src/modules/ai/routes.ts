import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { classifyKind, normalizeText } from '@t-cli/core/entry';
import { z } from 'zod';
import { insertEntries } from '../../db/entriesRepo.ts';
import type { AppDeps } from '../../deps.ts';
import { authOf, requireAuth } from '../../http/auth.ts';
import { AppError, loggableError, unauthorized } from '../../http/errors.ts';
import { createRateLimiter } from '../../lib/rateLimit.ts';
import type { LlmUsage } from '../../ports.ts';
import { isActiveAccount } from '../auth/accounts.ts';
import { buildMpEntry } from './entry.ts';
import { buildAiPrompt } from './prompt.ts';
import { consumeDailyQuota, isMissingAccount, localDay, recordTokens, type QuotaResult } from './quota.ts';
import { proxyStream, type DoneEntry, type StreamResult } from './stream.ts';
import { estimatePromptTokens, totalTokens } from './usage.ts';

/** Default client offset (Asia/Shanghai) when the client does not send one. */
export const DEFAULT_UTC_OFFSET_MINUTES = 480;
// 2000 chars of JSON-escaped text fit comfortably; nothing legitimate is larger.
const BODY_LIMIT_BYTES = 64 * 1024;

const codePoints = (text: string): number => [...text].length;

/** Request body; `maxChars` counts Unicode code points after trimming. */
export function translateBodySchema(maxChars: number) {
  return z.object({
    text: z
      .string()
      .trim()
      .min(1, 'must not be empty')
      .refine((text) => codePoints(text) <= maxChars, `must be at most ${maxChars} characters`),
    task: z.enum(['translate', 'check']),
    mode: z.enum(['simple', 'detail']).default('simple'),
    lang: z.enum(['zh', 'en']).default('zh'),
    utcOffsetMinutes: z.number().int().min(-720).max(840).default(DEFAULT_UTC_OFFSET_MINUTES),
    // Overrides the detected direction for `translate`; ignored for `check`.
    direction: z.enum(['toEn', 'toZh']).optional(),
  });
}

/**
 * Streaming AI proxy for the mini-program (docs/api-v1.md, "AI proxy").
 *
 *   POST /v1/ai/translate  → application/x-ndjson stream of meta / delta / done / error lines
 *
 * Order of checks: auth → validation → per-minute limit → the account still
 * exists (401 otherwise) → daily request quota and token budget (counted when
 * the request starts) → upstream. After the
 * request, its tokens (reported, or estimated as code points / 2) are added
 * to the day's budget. Logs one line per request with sizes, timings and
 * token counts only — never the user's text or the model's output.
 */
export async function registerAiRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { config } = deps;
  const authenticate = requireAuth(config.JWT_SECRET, deps.clock);
  const perMinute = createRateLimiter({ limit: config.AI_REQUESTS_PER_MINUTE, windowMs: 60_000 });
  const Body = translateBodySchema(config.AI_INPUT_MAX_CHARS);

  app.post('/v1/ai/translate', { preHandler: authenticate, bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
    const startedAt = performance.now();
    const { userId } = authOf(request);
    const body = Body.parse(request.body);
    const text = normalizeText(body.text);
    const { task, mode, utcOffsetMinutes } = body;
    // One source of truth for the meta line and the stored entry.
    const kind = classifyKind(text);
    const { messages, srcLang } = buildAiPrompt({ text, task, mode, lang: body.lang, direction: body.direction });

    const logFields = { userId, task, kind, mode, srcLang, direction: body.direction ?? null, inputChars: codePoints(text) };
    const logOutcome = (level: 'info' | 'warn' | 'error', outcome: string, extra: Record<string, unknown> = {}): void => {
      request.log[level]({ ...logFields, ...extra, totalMs: Math.round(performance.now() - startedAt), outcome }, 'ai request');
    };

    const now = deps.clock();
    const minute = perMinute.hit(userId, now.getTime());
    if (!minute.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(minute.retryAfterMs / 1000));
      logOutcome('info', 'rate_limited');
      reply.header('retry-after', String(retryAfterSeconds));
      throw new AppError(429, 'RATE_LIMITED', 'too many AI requests, slow down', { retryAfterSeconds });
    }

    // Refuse before charging the daily quota when the upstream cannot work.
    if (deps.llm.isAvailable && !deps.llm.isAvailable()) {
      logOutcome('error', 'ai_unavailable');
      throw new AppError(503, 'AI_UNAVAILABLE', 'AI service is not configured');
    }

    // A deleted account's access token stays valid until it expires: refuse it
    // before charging anything (the usage row's foreign key would fail anyway).
    const accountGone = (): AppError => {
      logOutcome('info', 'account_gone');
      return unauthorized('account not found');
    };
    if (!(await isActiveAccount(deps.db, userId))) throw accountGone();

    const day = localDay(now, utcOffsetMinutes);
    let quota: QuotaResult;
    try {
      quota = await consumeDailyQuota(deps.db, {
        userId,
        day,
        limit: config.AI_REQUESTS_PER_DAY,
        tokenLimit: config.AI_TOKENS_PER_DAY,
      });
    } catch (error) {
      // Deleted between the check above and the upsert.
      if (isMissingAccount(error)) throw accountGone();
      throw error;
    }
    if (!quota.allowed) {
      logOutcome('info', 'quota_exceeded', { quotaKind: quota.kind });
      throw quota.kind === 'tokens'
        ? new AppError(429, 'QUOTA_EXCEEDED', 'daily AI token budget exhausted', { limit: config.AI_TOKENS_PER_DAY, kind: 'tokens' })
        : new AppError(429, 'QUOTA_EXCEEDED', 'daily AI quota exhausted', { limit: config.AI_REQUESTS_PER_DAY, kind: 'requests' });
    }

    const persist = async (output: string): Promise<DoneEntry> => {
      const entry = buildMpEntry({ text, output, task, mode, srcLang, kind, now: deps.clock(), utcOffsetMinutes });
      const { inserted, lastSeq } = await insertEntries(deps.db, userId, [entry]);
      if (inserted !== 1) throw new Error('entry id collision');
      return { id: entry.id, seq: lastSeq, kind: entry.kind, correctedInput: entry.correctedInput };
    };

    let reported: LlmUsage | null = null;
    const onUsage = (usage: LlmUsage): void => {
      reported = usage;
    };
    /** Charge the day's token budget; never fails the (already answered) request. */
    const chargeTokens = async (usage: LlmUsage, estimated: boolean): Promise<Record<string, unknown>> => {
      try {
        await recordTokens(deps.db, { userId, day, tokens: totalTokens(usage), kind: 'interactive' });
      } catch (error) {
        request.log.error({ userId, ...loggableError(error) }, 'recording AI token usage failed');
      }
      return { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, usageEstimated: estimated };
    };

    let result: StreamResult;
    try {
      result = await proxyStream({ reply, llm: deps.llm, messages, meta: { srcLang, kind }, persist, startedAt, onUsage });
    } catch (error) {
      // Failed before any output: only what the upstream reported was spent.
      const usage: LlmUsage | null = reported;
      const tokens = usage ? await chargeTokens(usage, false) : {};
      const errorCode = error instanceof AppError ? error.code : 'INTERNAL';
      logOutcome('warn', 'upstream_error', { errorCode, outputChars: 0, firstDeltaMs: null, streamed: false, ...tokens });
      throw error;
    }

    const { outcome, outputChars, outputCodePoints, firstDeltaMs, errorCode, storeError } = result;
    const usage: LlmUsage | null = reported;
    const tokens = usage
      ? await chargeTokens(usage, false)
      : await chargeTokens({ promptTokens: estimatePromptTokens(messages), completionTokens: Math.ceil(outputCodePoints / 2) }, true);
    const timings = { outputChars, firstDeltaMs: firstDeltaMs === null ? null : Math.round(firstDeltaMs), ...tokens };
    if (outcome === 'store_failed') {
      // Only the error's class and SQLSTATE: a database error's detail can quote row values.
      const err = storeError instanceof Error ? { name: storeError.name, code: (storeError as { code?: unknown }).code } : {};
      logOutcome('error', outcome, { ...timings, errorCode, storeError: err });
    } else {
      logOutcome(outcome === 'upstream_error' ? 'warn' : 'info', outcome, { ...timings, errorCode, streamed: true });
    }
    return reply;
  });
}
