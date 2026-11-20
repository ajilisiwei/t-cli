import type { Database } from '../../db/client.ts';
import type { ChatMessage, LlmClient } from '../../ports.ts';
import { recordTokens } from '../ai/quota.ts';
import { estimatePromptTokens, totalTokens } from '../ai/usage.ts';
import type { ExplanationLang } from './schemas.ts';

/**
 * Budgeted JSON calls for one account's run: every call is checked against
 * the run's token cap first, its usage is added to the run's meter and to
 * the account's `ai_usage.pipeline_tokens`, and model answers are validated
 * entry by entry with a bounded number of retries.
 */

/** Completion budget per call; reasoning tokens count against it, so it is generous. */
export const MAX_COMPLETION_TOKENS = 16_384;
/** The first try plus two retries (docs/api-v1.md: "A zod failure is retried twice"). */
export const MAX_ATTEMPTS = 3;

export class TokenBudgetExceeded extends Error {
  readonly limit: number;
  readonly used: number;

  constructor(limit: number, used: number) {
    super('pipeline token budget for this run reached');
    this.name = 'TokenBudgetExceeded';
    this.limit = limit;
    this.used = used;
  }
}

export interface TokenBudget {
  readonly limit: number;
  used(): number;
  /** Throws TokenBudgetExceeded unless `expected` more tokens fit under the cap. */
  ensure(expected: number): void;
  spend(tokens: number): void;
}

export function createTokenBudget(limit: number): TokenBudget {
  let used = 0;
  return {
    limit,
    used: () => used,
    ensure(expected) {
      if (used + expected > limit) throw new TokenBudgetExceeded(limit, used);
    },
    spend(tokens) {
      used += tokens;
    },
  };
}

/** Everything one account's run needs; built once per account. */
export interface RunContext {
  db: Database;
  llm: LlmClient;
  /** Recorded on items and materials. */
  model: string;
  userId: string;
  lang: ExplanationLang;
  /** The account's UTC offset (its latest entry's). */
  utcOffsetMinutes: number;
  now: Date;
  /** The run's local day: pipeline tokens are booked on it. */
  usageDay: string;
  budget: TokenBudget;
  signal: AbortSignal;
}

export type JsonAnswer = { ok: true; value: unknown } | { ok: false };

/**
 * One JSON-mode call. Refuses (TokenBudgetExceeded) unless the prompt and the
 * whole completion budget still fit under the run's cap, so the cap is never
 * overshot. Upstream failures propagate; an unparsable answer is `ok: false`.
 */
export async function askJson(ctx: RunContext, messages: readonly ChatMessage[], maxTokens = MAX_COMPLETION_TOKENS): Promise<JsonAnswer> {
  ctx.budget.ensure(estimatePromptTokens(messages) + maxTokens);
  const { content, usage } = await ctx.llm.completeJson(messages, { signal: ctx.signal, maxTokens });
  const tokens = totalTokens(usage);
  ctx.budget.spend(tokens);
  await recordTokens(ctx.db, { userId: ctx.userId, day: ctx.usageDay, tokens, kind: 'pipeline' });
  try {
    return { ok: true, value: JSON.parse(content) as unknown };
  } catch {
    return { ok: false };
  }
}

export interface BatchResult<Req, Out> {
  done: { request: Req; value: Out }[];
  /** Still invalid after MAX_ATTEMPTS. */
  failed: Req[];
}

export interface BatchSpec<Req extends { ref: string }, Out> {
  requests: readonly Req[];
  batchSize: number;
  messagesFor(batch: readonly Req[]): ChatMessage[];
  /** The answer's entries by ref (empty when the envelope is wrong). */
  entriesOf(answer: unknown): ReadonlyMap<string, unknown>;
  /** A valid value for one request, or null. */
  validate(request: Req, raw: unknown): Out | null;
  /** Called after each batch, so finished work is saved before the next call (which may hit the cap). */
  onBatch(result: BatchResult<Req, Out>): Promise<void>;
}

/**
 * Ask for `requests` in batches. Within a batch, entries that are missing or
 * invalid are asked again on their own, up to MAX_ATTEMPTS calls in total.
 */
export async function askInBatches<Req extends { ref: string }, Out>(ctx: RunContext, spec: BatchSpec<Req, Out>): Promise<void> {
  for (let start = 0; start < spec.requests.length; start += spec.batchSize) {
    let pending = spec.requests.slice(start, start + spec.batchSize);
    const done: BatchResult<Req, Out>['done'] = [];
    for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.length > 0; attempt += 1) {
      const answer = await askJson(ctx, spec.messagesFor(pending));
      const entries = answer.ok ? spec.entriesOf(answer.value) : new Map<string, unknown>();
      const retry: Req[] = [];
      for (const request of pending) {
        const raw = entries.get(request.ref);
        const value = raw === undefined ? null : spec.validate(request, raw);
        if (value === null) retry.push(request);
        else done.push({ request, value });
      }
      pending = retry;
    }
    await spec.onBatch({ done, failed: pending });
  }
}

/** Index a list of `{ ref, ... }` answers by ref (first occurrence wins; entries without a string ref are dropped). */
export function byRef(list: readonly unknown[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const entry of list) {
    if (entry && typeof entry === 'object' && 'ref' in entry && typeof entry.ref === 'string' && !map.has(entry.ref)) {
      map.set(entry.ref, entry);
    }
  }
  return map;
}
