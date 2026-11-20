import type { AppDeps } from '../../deps.ts';
import type { Scheduler } from '../../lib/scheduler.ts';
import { reminderConfig } from './config.ts';
import { runReminders } from './reminders.ts';
import { createWechatReminderSender, type ReminderSender } from './sender.ts';

export { registerNotifyRoutes } from './routes.ts';
export { runReminders, REMINDER_PAGE, type ReminderRunResult } from './reminders.ts';
export { createWechatReminderSender, ReminderSendError, type ReminderMessage, type ReminderSender } from './sender.ts';

export const REMINDER_JOB = 'review-reminders';

/**
 * Review reminders via WeChat subscribe messages (docs/api-v1.md,
 * "Reminders"): an hourly job, registered only when the reminder template is
 * configured. `sender` defaults to the real WeChat client; tests pass a fake.
 */
export function registerNotifyJobs(scheduler: Scheduler, deps: AppDeps, sender?: ReminderSender): void {
  const reminder = reminderConfig(deps.config);
  if (!reminder) return;
  const send = sender ?? createWechatReminderSender(deps.config, { clock: deps.clock });
  const limits = { newPerDay: deps.config.REVIEW_NEW_PER_DAY, reviewsPerDay: deps.config.REVIEW_MAX_PER_DAY };
  // On the hour, by UTC+8's clock; each account's own local hour is checked inside.
  scheduler.hourly(REMINDER_JOB, { minute: 0, utcOffsetMinutes: 480 }, async () => {
    await runReminders(deps, { sender: send, reminder, limits, now: deps.clock() });
  });
}
