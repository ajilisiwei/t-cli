import { performance } from 'node:perf_hooks';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from '../../deps.ts';
import { AppError, loggableError, unauthorized } from '../../http/errors.ts';
import type { ChatMessage, LlmClient, LlmUsage } from '../../ports.ts';
import { consumeDailyQuota, isMissingAccount, localDay, recordTokens, type QuotaKind, type QuotaResult } from '../ai/quota.ts';
import { totalTokens } from '../ai/usage.ts';
import type { ExplanationLang } from '../pipeline/schemas.ts';
import { lemmaCandidates, listsInflection, mayStore } from './lemma.ts';
import {
  LEARNING_LANG,
  LEXICON_VERSION,
  LexiconEntrySchema,
  lexiconKey,
  LookupContextSchema,
  type LexiconEntry,
  type LookupContext,
} from './lexicon.ts';
import { contextMessages, lexiconMessages } from './prompts.ts';
import { countHit, exhaustedQuota, explanationLangOf, latestUtcOffset, readLexicon, storeLexicon, type LexiconScope } from './repo.ts';

/**
 * `POST /v1/lookup` after the request checks (docs/api-v1.md, "v2 → Lookup"):
 * read the shared lexicon, and only when the model is needed (a miss, or a
 * sentence) count one AI request, then generate the entry and/or the
 * sentence context in parallel under one deadline. Model answers are
 * JSON-mode completions validated with zod and asked once more when invalid
 * (as the pipeline's llmJson helper does); their tokens count against the
 * account's interactive budget (AI_TOKENS_PER_DAY), not the pipeline's.
 */

/** The first try plus one retry (contract: "validated (LexiconEntrySchema, one retry)"). */
export const LOOKUP_MAX_ATTEMPTS = 2;
/**
 * The model answers without reasoning. With deepseek-v4-flash's default
 * thinking, about 70% of an entry's completion tokens were reasoning and a
 * miss took 8–16 s; without it, 3–6 s with answers that pass the same checks.
 */
export const LOOKUP_THINKING = false;
/**
 * Completion caps per call. Typical answers are far smaller (an entry about
 * 450–650 tokens, a context under 50), but the longest answer the schema
 * accepts (six senses, eight collocations, four examples, Chinese glosses)
 * can pass 2048; a cap only bounds the call, it does not slow it.
 */
export const LEXICON_MAX_TOKENS = 4096;
export const CONTEXT_MAX_TOKENS = 2048;

export type LookupDeps = Pick<AppDeps, 'config' | 'db' | 'llm' | 'clock'>;

export interface LookupInput {
  userId: string;
  /** Normalized by LookupBody (trimmed, collapsed, straight quotes). */
  word: string;
  sentence?: string | undefined;
}

export interface LookupResult {
  lemma: string;
  lang: typeof LEARNING_LANG;
  entry: LexiconEntry;
  context: LookupContext | null;
  cached: boolean;
}

/** What a lookup did, for the request's log line: counts, sizes and timings only. */
export interface LookupStats {
  candidates: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  modelMs: number | null;
  /** A generated entry went into the lexicon (null: nothing was generated). */
  stored: boolean | null;
}

export interface LookupMeter {
  stats(): LookupStats;
  candidates(count: number): void;
  usage(usage: LlmUsage): void;
  modelMs(ms: number): void;
  stored(stored: boolean): void;
}

export function createLookupMeter(): LookupMeter {
  let current: LookupStats = { candidates: 0, modelCalls: 0, promptTokens: 0, completionTokens: 0, modelMs: null, stored: null };
  return {
    stats: () => current,
    candidates: (count) => {
      current = { ...current, candidates: count };
    },
    usage: (usage) => {
      current = {
        ...current,
        modelCalls: current.modelCalls + 1,
        promptTokens: current.promptTokens + usage.promptTokens,
        completionTokens: current.completionTokens + usage.completionTokens,
      };
    },
    modelMs: (ms) => {
      current = { ...current, modelMs: Math.round(ms) };
    },
    stored: (stored) => {
      current = { ...current, stored };
    },
  };
}

// ------------------------------------------------------------ model answers

type Parsed<T> = { ok: true; value: T } | { ok: false };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const normalized = (text: string): string => lexiconKey(text);

/** `{"entry": LexiconEntry}`, or `{"entry": null}` when the text is no English word or phrase (value null). */
export function parseLexiconAnswer(raw: unknown): Parsed<LexiconEntry | null> {
  if (!isRecord(raw) || !('entry' in raw)) return { ok: false };
  if (raw.entry === null) return { ok: true, value: null };
  const parsed = LexiconEntrySchema.safeParse(raw.entry);
  return parsed.success && /\p{Script=Latin}/u.test(parsed.data.lemma) ? { ok: true, value: parsed.data } : { ok: false };
}

/**
 * `{"meaning", "phrase"}`. The meaning is required; a phrase that is invalid,
 * not a multi-word part of the sentence, or does not contain the tapped text
 * is dropped (null) rather than failing the answer.
 */
export function parseContextAnswer(raw: unknown, text: string, sentence: string): Parsed<LookupContext> {
  if (!isRecord(raw)) return { ok: false };
  const meaning = LookupContextSchema.shape.meaning.safeParse(raw.meaning);
  if (!meaning.success) return { ok: false };
  const phrase = LookupContextSchema.shape.phrase.safeParse(raw.phrase ?? null);
  const value = phrase.success ? phrase.data : null;
  const key = value ? normalized(value.text) : '';
  const fits = value !== null && key.includes(' ') && key !== normalized(text) && key.includes(normalized(text)) && normalized(sentence).includes(key);
  return { ok: true, value: { meaning: meaning.data, phrase: fits ? value : null } };
}

const parseJson = (content: string): unknown => {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
};

/** One lookup's model access: a shared signal (deadline or abort) and per-call token charging. */
interface ModelCall {
  llm: LlmClient;
  signal: AbortSignal;
  charge(usage: LlmUsage): Promise<void>;
  /** Stop the other in-flight call (one already decided the outcome). */
  abort(): void;
  /** The error to answer with: a timeout becomes 502 AI_UPSTREAM. */
  failure(error: unknown): unknown;
}

/** A JSON-mode call validated by `parse`, asked again once when the answer is invalid; still invalid → 502. */
async function askValidated<T>(call: ModelCall, messages: readonly ChatMessage[], maxTokens: number, parse: (raw: unknown) => Parsed<T>): Promise<T> {
  for (let attempt = 1; attempt <= LOOKUP_MAX_ATTEMPTS; attempt += 1) {
    const { content, usage } = await call.llm.completeJson(messages, { signal: call.signal, maxTokens, thinking: LOOKUP_THINKING });
    await call.charge(usage);
    const parsed = parse(parseJson(content));
    if (parsed.ok) return parsed.value;
  }
  throw new AppError(502, 'AI_UPSTREAM', 'AI answer failed validation');
}

async function generateEntry(call: ModelCall, word: string, lang: ExplanationLang): Promise<LexiconEntry> {
  const entry = await askValidated(call, lexiconMessages(word, lang), LEXICON_MAX_TOKENS, parseLexiconAnswer);
  if (entry !== null) return entry;
  call.abort();
  throw new AppError(422, 'NOT_A_WORD', 'no English word or phrase recognized');
}

const generateContext = (call: ModelCall, word: string, sentence: string, lang: ExplanationLang): Promise<LookupContext> =>
  askValidated(call, contextMessages(word, sentence, lang), CONTEXT_MAX_TOKENS, (raw) => parseContextAnswer(raw, word, sentence));

// ------------------------------------------------------------ quota

function quotaExceeded(config: LookupDeps['config'], kind: QuotaKind): AppError {
  return kind === 'tokens'
    ? new AppError(429, 'QUOTA_EXCEEDED', 'daily AI token budget exhausted', { limit: config.AI_TOKENS_PER_DAY, kind: 'tokens' })
    : new AppError(429, 'QUOTA_EXCEEDED', 'daily AI quota exhausted', { limit: config.AI_REQUESTS_PER_DAY, kind: 'requests' });
}

/**
 * Count this lookup as one AI request on the account's local day. Error
 * order per the contract: QUOTA_EXCEEDED before AI_UNAVAILABLE; a request
 * that cannot reach the model is never counted.
 */
async function chargeRequest(deps: LookupDeps, userId: string, day: string): Promise<void> {
  const { config } = deps;
  const limits = { userId, day, limit: config.AI_REQUESTS_PER_DAY, tokenLimit: config.AI_TOKENS_PER_DAY };
  if (deps.llm.isAvailable && !deps.llm.isAvailable()) {
    const exhausted = await exhaustedQuota(deps.db, limits);
    throw exhausted ? quotaExceeded(config, exhausted) : new AppError(503, 'AI_UNAVAILABLE', 'AI service is not configured');
  }
  let quota: QuotaResult;
  try {
    quota = await consumeDailyQuota(deps.db, limits);
  } catch (error) {
    // The account was deleted since the auth check (the usage row's foreign key).
    if (isMissingAccount(error)) throw unauthorized('account not found');
    throw error;
  }
  if (!quota.allowed) throw quotaExceeded(config, quota.kind);
}

async function startModelCall(deps: LookupDeps, userId: string, meter: LookupMeter, log: FastifyBaseLogger): Promise<ModelCall> {
  const day = localDay(deps.clock(), await latestUtcOffset(deps.db, userId));
  await chargeRequest(deps, userId, day);
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(deps.config.LOOKUP_TIMEOUT_MS);
  return {
    llm: deps.llm,
    signal: AbortSignal.any([controller.signal, deadline]),
    async charge(usage) {
      meter.usage(usage);
      try {
        await recordTokens(deps.db, { userId, day, tokens: totalTokens(usage), kind: 'interactive' });
      } catch (error) {
        log.error({ userId, ...loggableError(error) }, 'recording lookup token usage failed');
      }
    },
    abort: () => controller.abort(),
    failure: (error) => (error instanceof AppError || !deadline.aborted ? error : new AppError(502, 'AI_UPSTREAM', 'AI upstream timed out')),
  };
}

// ------------------------------------------------------------ lexicon

interface CacheHit {
  key: string;
  entry: LexiconEntry;
}

/**
 * The first candidate key with a stored entry. A key derived by inflection
 * rules only counts when its entry lists the looked-up text as an inflection.
 */
async function findCached(deps: LookupDeps, scope: LexiconScope, word: string, meter: LookupMeter, log: FastifyBaseLogger): Promise<CacheHit | null> {
  const candidates = lemmaCandidates(word);
  meter.candidates(candidates.length);
  const rows = await readLexicon(deps.db, scope, candidates);
  const own = lexiconKey(word);
  for (const key of candidates) {
    const row = rows.find((candidate) => candidate.lemma === key);
    if (!row) continue;
    const parsed = LexiconEntrySchema.safeParse(row.content);
    if (!parsed.success) {
      log.warn({ version: scope.version }, 'lexicon row failed validation; ignored');
      continue;
    }
    if (key === own || listsInflection(parsed.data, own)) return { key, entry: parsed.data };
  }
  return null;
}

/** Bookkeeping after the answer is known; a failure here never fails the (paid) lookup. */
async function settleCache(
  deps: LookupDeps,
  { scope, hit, word, entry }: { scope: LexiconScope; hit: CacheHit | null; word: string; entry: LexiconEntry },
  meter: LookupMeter,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    if (hit) {
      await countHit(deps.db, scope, hit.key);
    } else if (mayStore(word, entry)) {
      meter.stored(await storeLexicon(deps.db, { ...scope, lemma: lexiconKey(entry.lemma), content: entry, model: deps.config.DEEPSEEK_MODEL }));
    } else {
      meter.stored(false);
    }
  } catch (error) {
    log.error(loggableError(error), hit ? 'counting a lexicon hit failed' : 'storing a lexicon entry failed');
  }
}

// ------------------------------------------------------------ the lookup

/** The answer, and the explanation language it was written in (for the lookup event). */
export interface LookupOutcome {
  result: LookupResult;
  explainLang: ExplanationLang;
}

export async function lookupWord(deps: LookupDeps, input: LookupInput, meter: LookupMeter, log: FastifyBaseLogger): Promise<LookupOutcome> {
  const { userId, word, sentence } = input;
  const explainLang = await explanationLangOf(deps.db, userId);
  if (explainLang === null) throw unauthorized('account not found');
  const scope: LexiconScope = { lang: LEARNING_LANG, explainLang, version: LEXICON_VERSION };
  const hit = await findCached(deps, scope, word, meter, log);

  let entry: LexiconEntry;
  let context: LookupContext | null = null;
  if (hit && sentence === undefined) {
    entry = hit.entry;
  } else {
    const call = await startModelCall(deps, userId, meter, log);
    const startedAt = performance.now();
    try {
      [entry, context] = await Promise.all([
        hit ? hit.entry : generateEntry(call, word, explainLang),
        sentence === undefined ? null : generateContext(call, word, sentence, explainLang),
      ]);
    } catch (error) {
      call.abort();
      throw call.failure(error);
    } finally {
      meter.modelMs(performance.now() - startedAt);
    }
  }

  await settleCache(deps, { scope, hit, word, entry }, meter, log);
  return { result: { lemma: entry.lemma, lang: LEARNING_LANG, entry, context, cached: hit !== null }, explainLang };
}
