import type { Config } from '../../config.ts';
import type { AppDeps } from '../../deps.ts';
import type { Scheduler } from '../../lib/scheduler.ts';
import type { Alerter, ItemRegenerator } from '../../ports.ts';

/**
 * M3 AI pipeline (owner: the pipeline module). Phase-0 stubs; see
 * docs/api-v1.md "Learning" for the behavior to implement.
 */

/** Registers the nightly extraction / materials / weekly-report jobs. */
export function registerPipelineJobs(_scheduler: Scheduler, _deps: AppDeps): void {}

/** "内容有误" → regenerate one item. */
export function createItemRegenerator(_deps: Omit<AppDeps, 'regenerator'>): ItemRegenerator {
  return {
    async regenerate() {
      throw new Error('item regeneration is not implemented yet');
    },
  };
}

export interface AlertLogger {
  warn(obj: object, msg: string): void;
}

/** Operator alerts: e-mail when configured, otherwise a log line. */
export function createAlerter(_config: Config, log: AlertLogger): Alerter {
  return {
    async alert(kind, message) {
      log.warn({ alertKind: kind, alertMessage: message }, 'alert');
    },
  };
}
