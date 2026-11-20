import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { jobRuns } from '../db/schema.ts';
import { loggableError } from '../http/errors.ts';
import type { Alerter, Clock } from '../ports.ts';

/**
 * In-process job scheduler (no Redis, no external cron; design §11).
 *
 * - A job runs at most once per run key: `daily` → the local date,
 *   `hourly` → the local date + hour. The last run key is stored in
 *   `job_runs`, so a restart does not run a job twice.
 * - Each run holds `pg_try_advisory_xact_lock` for its name inside a
 *   transaction, so two instances never run the same job at once.
 * - Failures are recorded in `job_runs.last_error` (class only, never data)
 *   and reported through the Alerter.
 */
export type JobFn = (runKey: string) => Promise<void>;

export interface Scheduler {
  /** Run once per local day, at or after hour:minute in `utcOffsetMinutes`. */
  daily(name: string, at: { hour: number; minute: number; utcOffsetMinutes: number }, fn: JobFn): void;
  /** Run once per local hour, at or after `minute` past the hour. */
  hourly(name: string, at: { minute: number; utcOffsetMinutes: number }, fn: JobFn): void;
  start(): void;
  stop(): Promise<void>;
  /** Run a registered job now under its lock, with `runKey` (default: "manual-<iso>"). Admin scripts and tests. */
  runNow(name: string, runKey?: string): Promise<'ran' | 'skipped' | 'locked' | 'unknown'>;
  /** Check every job against the clock once (what the timer does). Tests call this instead of waiting. */
  tick(): Promise<void>;
}

export interface SchedulerLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

interface Job {
  name: string;
  /** The run key due at `now`, or null when it is not time yet. */
  keyAt(now: Date): string | null;
  fn: JobFn;
}

const TICK_MS = 30_000;

/** Local wall-clock parts at a fixed UTC offset. */
function localParts(now: Date, utcOffsetMinutes: number): { date: string; hour: number; minute: number } {
  const shifted = new Date(now.getTime() + utcOffsetMinutes * 60_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

export function createScheduler(options: { db: Database; clock: Clock; log: SchedulerLogger; alerter: Alerter }): Scheduler {
  const { db, clock, log, alerter } = options;
  const jobs = new Map<string, Job>();
  const running = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<unknown> = Promise.resolve();

  const register = (job: Job): void => {
    if (jobs.has(job.name)) throw new Error(`job ${job.name} registered twice`);
    jobs.set(job.name, job);
  };

  /** Runs `job` under its advisory lock unless `runKey` already ran. */
  const run = async (job: Job, runKey: string, force: boolean): Promise<'ran' | 'skipped' | 'locked'> => {
    if (running.has(job.name)) return 'locked';
    running.add(job.name);
    try {
      return await db.transaction(async (tx) => {
        const [lock] = await tx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtext(${'tcli-job:' + job.name})) as locked`,
        );
        if (!lock?.locked) return 'locked';
        const [last] = await tx.select().from(jobRuns).where(sql`${jobRuns.name} = ${job.name}`);
        if (!force && last?.lastRunKey === runKey) return 'skipped';

        const startedAt = Date.now();
        let lastError: string | null = null;
        try {
          await job.fn(runKey);
          log.info({ job: job.name, runKey, ms: Date.now() - startedAt }, 'job finished');
        } catch (error: unknown) {
          const logged = loggableError(error);
          lastError = logged.errName;
          log.error({ job: job.name, runKey, ...logged }, 'job failed');
          await alerter.alert('job_failed', `job ${job.name} (${runKey}) failed: ${logged.errName}`).catch(() => undefined);
        }
        await tx
          .insert(jobRuns)
          .values({ name: job.name, lastRunKey: runKey, lastRunAt: clock(), lastError })
          .onConflictDoUpdate({ target: jobRuns.name, set: { lastRunKey: runKey, lastRunAt: clock(), lastError } });
        return 'ran';
      });
    } finally {
      running.delete(job.name);
    }
  };

  const tick = async (): Promise<void> => {
    const now = clock();
    for (const job of jobs.values()) {
      const key = job.keyAt(now);
      if (key !== null) await run(job, key, false);
    }
  };

  return {
    daily(name, at, fn) {
      register({
        name,
        fn,
        keyAt(now) {
          const p = localParts(now, at.utcOffsetMinutes);
          return p.hour > at.hour || (p.hour === at.hour && p.minute >= at.minute) ? p.date : null;
        },
      });
    },
    hourly(name, at, fn) {
      register({
        name,
        fn,
        keyAt(now) {
          const p = localParts(now, at.utcOffsetMinutes);
          return p.minute >= at.minute ? `${p.date}T${String(p.hour).padStart(2, '0')}` : null;
        },
      });
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        inFlight = tick().catch((error: unknown) => log.error(loggableError(error), 'scheduler tick failed'));
      }, TICK_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await inFlight;
    },
    async runNow(name, runKey) {
      const job = jobs.get(name);
      if (!job) return 'unknown';
      return run(job, runKey ?? `manual-${clock().toISOString()}`, true);
    },
    tick,
  };
}
