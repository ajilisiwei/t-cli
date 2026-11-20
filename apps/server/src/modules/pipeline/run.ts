import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import type { Config } from '../../config.ts';
import type { Database } from '../../db/client.ts';
import { AppError, loggableError } from '../../http/errors.ts';
import type { Alerter, Clock, LlmClient } from '../../ports.ts';
import { addDays, localDateOf, weekdayOf } from './dates.ts';
import { extractBatch, sliceBatches } from './extract.ts';
import { generateItems } from './generate.ts';
import { createTokenBudget, MAX_ATTEMPTS, TokenBudgetExceeded, type RunContext } from './llmJson.ts';
import { buildDailyMaterial, buildWeeklyReport, type MaterialOutcome } from './materials.ts';
import {
  accountSettings,
  accountsWithRecords,
  entriesAfter,
  finishRun,
  itemsToGenerate,
  knownGrammarSlugs,
  readCursor,
  storeUnits,
} from './repo.ts';

/**
 * The nightly pipeline (docs/api-v1.md, "Nightly pipeline"), one account at a
 * time: extract → generate → daily material → weekly report. An account's
 * failure is alerted and recorded in pipeline_state and does not stop the
 * others; its cursor only ever moves past batches that were stored.
 */

export type PipelineConfig = Pick<Config, 'DEEPSEEK_MODEL' | 'AI_PIPELINE_TOKENS_PER_RUN'>;

export interface PipelineLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface PipelineDeps {
  config: PipelineConfig;
  db: Database;
  clock: Clock;
  llm: LlmClient;
  alerter: Alerter;
  /** Run summaries (ids and counts only). */
  log?: PipelineLogger | undefined;
}

export type AccountStatus = 'ok' | 'budget_exceeded' | 'failed' | 'locked';

/** What one account's run did. Ids, counts and error classes only — safe to log and print. */
export interface AccountRunSummary {
  userId: string;
  status: AccountStatus;
  error: string | null;
  entriesProcessed: number;
  /** Records whose extraction answer stayed invalid (skipped, alerted). */
  recordsSkipped: number;
  itemsCreated: number;
  sourcesAdded: number;
  itemsGenerated: number;
  itemsNeedsRegen: number;
  cardsCreated: number;
  cardsUpdated: number;
  rejected: Record<string, number>;
  daily: { date: string; outcome: MaterialOutcome } | null;
  weekly: { date: string; outcome: MaterialOutcome } | null;
  tokens: number;
  ms: number;
}

/** Bounds per account and run, so a large backlog (e.g. the first run after a backfill) spreads over several nights. */
export const MAX_ENTRIES_PER_RUN = 300;
export const MAX_ITEMS_PER_RUN = 150;

export class PipelineUnavailable extends Error {
  constructor() {
    super('AI is not configured (DEEPSEEK_API_KEY)');
    this.name = 'PipelineUnavailable';
  }
}

const errorClass = (error: unknown): string => (error instanceof AppError ? `AppError:${error.code}` : loggableError(error).errName);

const emptySummary = (userId: string): AccountRunSummary => ({
  userId,
  status: 'ok',
  error: null,
  entriesProcessed: 0,
  recordsSkipped: 0,
  itemsCreated: 0,
  sourcesAdded: 0,
  itemsGenerated: 0,
  itemsNeedsRegen: 0,
  cardsCreated: 0,
  cardsUpdated: 0,
  rejected: {},
  daily: null,
  weekly: null,
  tokens: 0,
  ms: 0,
});

/**
 * Hold a transaction-scoped advisory lock for the account while `fn` runs (on
 * other connections), so the nightly job and an admin run never process the
 * same account at once. Resolves to 'locked' when another run holds it.
 */
async function withAccountLock<T>(db: Database, userId: string, fn: () => Promise<T>): Promise<T | 'locked'> {
  return db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${`tcli-pipeline:${userId}`})) as locked`,
    );
    if (!lock?.locked) return 'locked';
    return fn();
  });
}

type Progress = { current: AccountRunSummary };

/** Steps 1–4 for one account; updates `progress` as it goes, so a stop keeps the counts. */
async function processAccount(ctx: RunContext, progress: Progress): Promise<void> {
  const { db, userId } = ctx;
  const update = (patch: Partial<AccountRunSummary>): void => {
    progress.current = { ...progress.current, ...patch };
  };

  // 1. Extract new records, batch by batch; each stored batch moves the cursor.
  const cursor = await readCursor(db, userId);
  const records = await entriesAfter(db, userId, cursor, MAX_ENTRIES_PER_RUN);
  for (const batch of sliceBatches(records)) {
    const last = batch[batch.length - 1];
    if (!last) continue;
    const { links, failed } = await extractBatch(ctx, batch, await knownGrammarSlugs(db, userId));
    const stored = await storeUnits(db, userId, links, last.seq);
    const p = progress.current;
    update({
      entriesProcessed: p.entriesProcessed + batch.length,
      recordsSkipped: p.recordsSkipped + failed,
      itemsCreated: p.itemsCreated + stored.itemsCreated,
      sourcesAdded: p.sourcesAdded + stored.sourcesAdded,
    });
  }

  // 2. Content and cards for new and needs_regen items.
  const generation = await generateItems(ctx, await itemsToGenerate(db, userId, MAX_ITEMS_PER_RUN));
  update({
    itemsGenerated: generation.generated,
    itemsNeedsRegen: generation.failedIds.length,
    cardsCreated: generation.cardsCreated,
    cardsUpdated: generation.cardsUpdated,
    rejected: generation.rejected,
  });

  // 3. The previous local day's material; 4. the weekly report when that day is a Sunday.
  const day = addDays(localDateOf(ctx.now, ctx.utcOffsetMinutes), -1);
  update({ daily: { date: day, outcome: await buildDailyMaterial(ctx, day) } });
  if (weekdayOf(day) === 0) {
    update({ weekly: { date: addDays(day, -6), outcome: await buildWeeklyReport(ctx, day) } });
  }
}

async function alertOutcome(deps: PipelineDeps, summary: AccountRunSummary, limit: number): Promise<void> {
  const { alerter } = deps;
  const { userId } = summary;
  if (summary.status === 'budget_exceeded') {
    await alerter.alert(
      'token_budget_exceeded',
      `pipeline stopped early for account ${userId}: the per-run budget of ${limit} tokens was reached (${summary.tokens} used); the rest waits for the next run`,
    );
  }
  if (summary.status === 'failed') {
    await alerter.alert('pipeline_user_failed', `pipeline failed for account ${userId}: ${summary.error ?? 'unknown error'}`);
  }
  if (summary.recordsSkipped > 0) {
    await alerter.alert(
      'pipeline_user_failed',
      `pipeline skipped ${summary.recordsSkipped} record(s) of account ${userId}: extraction answers failed validation ${MAX_ATTEMPTS} times`,
    );
  }
  if (summary.itemsNeedsRegen > 0) {
    await alerter.alert(
      'item_needs_regen',
      `${summary.itemsNeedsRegen} item(s) of account ${userId} are needs_regen: generated content failed validation ${MAX_ATTEMPTS} times`,
    );
  }
}

/** Run the pipeline for one account now. Never throws for the account's own failures (they are in the summary). */
export async function runAccount(deps: PipelineDeps, userId: string, signal: AbortSignal): Promise<AccountRunSummary> {
  const startedAt = performance.now();
  const settings = await accountSettings(deps.db, userId);
  if (!settings) return { ...emptySummary(userId), status: 'failed', error: 'NoSuchAccount' };
  const now = deps.clock();
  const limit = deps.config.AI_PIPELINE_TOKENS_PER_RUN;
  const ctx: RunContext = {
    db: deps.db,
    llm: deps.llm,
    model: deps.config.DEEPSEEK_MODEL,
    userId,
    lang: settings.lang,
    utcOffsetMinutes: settings.utcOffsetMinutes,
    now,
    usageDay: localDateOf(now, settings.utcOffsetMinutes),
    budget: createTokenBudget(limit),
    signal,
  };
  const progress: Progress = { current: emptySummary(userId) };

  const outcome = await withAccountLock(deps.db, userId, async () => {
    let status: AccountStatus = 'ok';
    let error: string | null = null;
    try {
      await processAccount(ctx, progress);
    } catch (caught) {
      status = caught instanceof TokenBudgetExceeded ? 'budget_exceeded' : 'failed';
      error = errorClass(caught);
    }
    await finishRun(deps.db, userId, { at: deps.clock(), error });
    return { status, error };
  });

  const summary: AccountRunSummary = {
    ...progress.current,
    ...(outcome === 'locked' ? { status: 'locked' as const, error: null } : outcome),
    tokens: ctx.budget.used(),
    ms: Math.round(performance.now() - startedAt),
  };
  await alertOutcome(deps, summary, limit);
  deps.log?.[summary.status === 'ok' ? 'info' : 'warn']({ pipeline: summary }, 'pipeline account finished');
  return summary;
}

/**
 * Run the pipeline now for every account with records (or just `userId`).
 * Accounts run one after another; each is isolated from the others' failures.
 */
export async function runPipeline(
  deps: PipelineDeps,
  { userId, signal = new AbortController().signal }: { userId?: string | undefined; signal?: AbortSignal } = {},
): Promise<AccountRunSummary[]> {
  if (deps.llm.isAvailable?.() === false) throw new PipelineUnavailable();
  const userIds = userId === undefined ? await accountsWithRecords(deps.db) : [userId];
  const summaries: AccountRunSummary[] = [];
  for (const id of userIds) {
    signal.throwIfAborted();
    try {
      summaries.push(await runAccount(deps, id, signal));
    } catch (error) {
      // Bookkeeping itself failed (e.g. the database went away mid-run): record it and go on.
      const summary: AccountRunSummary = { ...emptySummary(id), status: 'failed', error: errorClass(error) };
      await deps.alerter.alert('pipeline_user_failed', `pipeline failed for account ${id}: ${summary.error}`).catch(() => undefined);
      deps.log?.warn({ pipeline: summary }, 'pipeline account finished');
      summaries.push(summary);
    }
  }
  return summaries;
}
