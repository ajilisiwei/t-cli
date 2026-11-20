import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { jobRuns } from '../src/db/schema.ts';
import { createScheduler } from '../src/lib/scheduler.ts';
import { fakeAlerter, fixedClock } from './helpers/app.ts';
import { createTestDatabase, skipWithoutDb, type TestDatabase } from './helpers/db.ts';

const silentLog = { info: () => undefined, error: () => undefined };
const SHANGHAI = 480;

describe('scheduler', { skip: skipWithoutDb }, () => {
  let t: TestDatabase;
  before(async () => {
    t = await createTestDatabase();
  });
  after(async () => {
    await t?.drop();
  });

  test('a daily job runs once at or after its local time, and not again after a restart', async () => {
    const clock = fixedClock(new Date('2026-11-20T04:59:00+08:00'));
    let runs: string[] = [];
    const make = () => {
      const s = createScheduler({ db: t.db, clock, log: silentLog, alerter: fakeAlerter() });
      s.daily('nightly-a', { hour: 5, minute: 0, utcOffsetMinutes: SHANGHAI }, async (key) => {
        runs.push(key);
      });
      return s;
    };
    const s1 = make();
    await s1.tick();
    assert.deepEqual(runs, [], 'not before 05:00 local');
    clock.set(new Date('2026-11-20T05:00:30+08:00'));
    await s1.tick();
    await s1.tick();
    assert.deepEqual(runs, ['2026-11-20'], 'once for the day');

    runs = [];
    const s2 = make(); // a restart
    await s2.tick();
    assert.deepEqual(runs, [], 'job_runs remembers the run key');
    clock.set(new Date('2026-11-21T06:00:00+08:00'));
    await s2.tick();
    assert.deepEqual(runs, ['2026-11-21']);
  });

  test('two instances ticking at once run the job only once', async () => {
    const clock = fixedClock(new Date('2026-11-20T05:01:00+08:00'));
    let count = 0;
    const make = () => {
      const s = createScheduler({ db: t.db, clock, log: silentLog, alerter: fakeAlerter() });
      s.daily('nightly-b', { hour: 5, minute: 0, utcOffsetMinutes: SHANGHAI }, async () => {
        count += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
      });
      return s;
    };
    await Promise.all([make().tick(), make().tick()]);
    assert.equal(count, 1);
  });

  test('a failing job records only the error class and alerts', async () => {
    const clock = fixedClock(new Date('2026-11-20T05:01:00+08:00'));
    const alerter = fakeAlerter();
    const s = createScheduler({ db: t.db, clock, log: silentLog, alerter });
    s.daily('nightly-c', { hour: 5, minute: 0, utcOffsetMinutes: SHANGHAI }, async () => {
      throw new TypeError('private sentence about the merger');
    });
    await s.tick();
    const [row] = await t.db.select().from(jobRuns).where(eq(jobRuns.name, 'nightly-c'));
    assert.equal(row?.lastError, 'TypeError');
    assert.equal(row?.lastRunKey, '2026-11-20');
    assert.equal(alerter.alerts.length, 1);
    assert.ok(!JSON.stringify(alerter.alerts).includes('merger'), 'alerts never carry error messages');
  });

  test('hourly jobs run once per local hour; runNow forces a run', async () => {
    const clock = fixedClock(new Date('2026-11-20T09:04:00+08:00'));
    const keys: string[] = [];
    const s = createScheduler({ db: t.db, clock, log: silentLog, alerter: fakeAlerter() });
    s.hourly('hourly-a', { minute: 5, utcOffsetMinutes: SHANGHAI }, async (key) => {
      keys.push(key);
    });
    await s.tick();
    clock.set(new Date('2026-11-20T09:06:00+08:00'));
    await s.tick();
    await s.tick();
    clock.set(new Date('2026-11-20T10:05:00+08:00'));
    await s.tick();
    assert.deepEqual(keys, ['2026-11-20T09', '2026-11-20T10']);
    assert.equal(await s.runNow('hourly-a', 'manual-1'), 'ran');
    assert.equal(await s.runNow('missing'), 'unknown');
    assert.deepEqual(keys.at(-1), 'manual-1');
  });
});
