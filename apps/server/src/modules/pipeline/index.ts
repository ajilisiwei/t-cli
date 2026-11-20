import type { Config } from '../../config.ts';
import type { AppDeps } from '../../deps.ts';
import type { Scheduler } from '../../lib/scheduler.ts';
import type { Alerter, ItemRegenerator } from '../../ports.ts';
import { createAlerter as createMailAlerter, type AlertLogger } from './alerts.ts';
import { DEFAULT_UTC_OFFSET_MINUTES } from './dates.ts';
import { createRegenerator } from './regenerate.ts';
import { runPipeline, type PipelineLogger } from './run.ts';

/**
 * M3 AI pipeline (docs/api-v1.md, "Learning": content shapes, nightly
 * pipeline, alerts). Entry points wired by main.ts and the admin script.
 */

export type { AlertLogger } from './alerts.ts';
export { runPipeline, type AccountRunSummary, type PipelineDeps, type PipelineLogger } from './run.ts';

export const PIPELINE_JOB = 'pipeline-nightly';
/** 05:00 Asia/Shanghai: records of the previous local day are complete by then. */
export const PIPELINE_SCHEDULE = { hour: 5, minute: 0, utcOffsetMinutes: DEFAULT_UTC_OFFSET_MINUTES } as const;

/** Registers the nightly job (extraction, content, cards, daily material, weekly report). */
export function registerPipelineJobs(scheduler: Scheduler, deps: AppDeps, log?: PipelineLogger): void {
  scheduler.daily(PIPELINE_JOB, PIPELINE_SCHEDULE, async () => {
    // Per-account failures are alerted and recorded by the run; only a run
    // that cannot start at all (no AI configured) fails the job.
    await runPipeline({ ...deps, log });
  });
}

/** "内容有误" → regenerate one item. */
export function createItemRegenerator(deps: Omit<AppDeps, 'regenerator'>): ItemRegenerator {
  return createRegenerator(deps);
}

/** Operator alerts: e-mail when configured, otherwise a log line. */
export function createAlerter(config: Config, log: AlertLogger): Alerter {
  return createMailAlerter(config, log);
}
