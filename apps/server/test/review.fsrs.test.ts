import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RETENTION,
  FSRS_PARAMETERS,
  previewIntervals,
  replayCard,
  stateName,
  toSchedule,
  type ReplayLog,
} from '../src/modules/review/fsrs.ts';

const T0 = new Date('2026-11-17T02:00:00Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const log = (id: string, rating: 1 | 2 | 3 | 4, minutes: number): ReplayLog => ({ id, rating, reviewedAt: at(minutes) });
const R = DEFAULT_RETENTION;

describe('FSRS scheduling (pure)', () => {
  test('parameters per the contract: retention 0.9, max interval 36500, no fuzz', () => {
    assert.equal(FSRS_PARAMETERS.request_retention, 0.9);
    assert.equal(FSRS_PARAMETERS.maximum_interval, 36_500);
    assert.equal(FSRS_PARAMETERS.enable_fuzz, false);
  });

  test('a new card previews the learning steps and an 8-day Easy', () => {
    assert.deepEqual(previewIntervals(replayCard(T0, [], R), T0, R), { '1': 60, '2': 360, '3': 600, '4': 8 * 86_400 });
  });

  test('replay is deterministic and independent of the order logs arrive in', () => {
    const logs = [log('01A', 3, 0), log('01B', 3, 10), log('01C', 1, 3 * 1440), log('01D', 3, 10 * 1440), log('01E', 4, 30 * 1440)];
    const forward = toSchedule(replayCard(T0, logs, R), 180);
    const shuffled = toSchedule(replayCard(T0, [logs[3]!, logs[0]!, logs[4]!, logs[2]!, logs[1]!], R), 180);
    assert.deepEqual(shuffled, forward);
    assert.equal(forward.reps, 5);
    assert.equal(forward.lapses, 1);
    assert.equal(stateName(forward.state), 'review');
  });

  test('logs at the same instant are ordered by id', () => {
    const a = log('01A', 1, 0);
    const b = log('01B', 4, 0);
    assert.deepEqual(toSchedule(replayCard(T0, [b, a], R), 180), toSchedule(replayCard(T0, [a, b], R), 180));
    assert.notDeepEqual(toSchedule(replayCard(T0, [a, b], R), 180), toSchedule(replayCard(T0, [{ ...a, id: '01C' }, b], R), 180));
  });

  test('mastered once the scheduled interval exceeds the threshold', () => {
    let logs: ReplayLog[] = [log('01A', 4, 0)];
    let schedule = toSchedule(replayCard(T0, logs, R), 30);
    for (let i = 0; i < 6 && !schedule.mastered; i += 1) {
      const next = (schedule.due.getTime() - T0.getTime()) / 60_000;
      logs = [...logs, log(`01B${i}`, 4, next)];
      schedule = toSchedule(replayCard(T0, logs, R), 30);
    }
    assert.equal(schedule.mastered, true);
    assert.ok(schedule.scheduledDays > 30);
    assert.equal(toSchedule(replayCard(T0, logs, R), 36_500).mastered, false, 'the threshold is configurable');
  });
});
