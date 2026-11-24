import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RETENTION,
  previewIntervals,
  replayCard,
  retentionFor,
  schedulerFor,
  toSchedule,
  type ReplayLog,
} from '../src/modules/review/fsrs.ts';
import { compareForMaterial } from '../src/modules/pipeline/materials.ts';

const T0 = new Date('2026-11-17T02:00:00Z');
const DAY_MINUTES = 1440;
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const log = (id: string, rating: 1 | 2 | 3 | 4, minutes: number): ReplayLog => ({ id, rating, reviewedAt: at(minutes) });
const HISTORY = [log('01A', 3, 0), log('01B', 3, 10), log('01C', 3, 3 * DAY_MINUTES), log('01D', 1, 12 * DAY_MINUTES), log('01E', 3, 12 * DAY_MINUTES + 10)];

describe('review by importance (pure)', () => {
  test('retention by stars per the contract; importanceReview off → 0.90 for every card', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((stars) => retentionFor(stars, true)), [0.85, 0.9, 0.92, 0.94, 0.95]);
    assert.deepEqual([0, 1, 2, 3, 4].map((stars) => retentionFor(stars, false)), [0.9, 0.9, 0.9, 0.9, 0.9]);
    assert.equal(retentionFor(9, true), 0.95, 'clamped');
    assert.equal(retentionFor(-1, true), 0.85, 'clamped');
    assert.equal(DEFAULT_RETENTION, 0.9);
  });

  test('one cached scheduler per retention, with the shared parameters', () => {
    assert.equal(schedulerFor(0.92), schedulerFor(0.92));
    assert.notEqual(schedulerFor(0.92), schedulerFor(0.94));
    const { parameters } = schedulerFor(0.94);
    assert.equal(parameters.request_retention, 0.94);
    assert.equal(parameters.maximum_interval, 36_500);
    assert.equal(parameters.enable_fuzz, false);
  });

  test('more stars → higher retention → shorter intervals; learning steps are the same', () => {
    const now = at(20 * DAY_MINUTES);
    const good = [0, 1, 2, 3, 4].map((stars) => {
      const retention = retentionFor(stars, true);
      return previewIntervals(replayCard(T0, HISTORY, retention), now, retention)['3'];
    });
    for (let i = 1; i < good.length; i += 1) assert.ok(good[i]! < good[i - 1]!, JSON.stringify(good));

    const fresh = (retention: number) => previewIntervals(replayCard(T0, [], retention), T0, retention);
    const [low, high] = [fresh(0.85), fresh(0.95)];
    assert.deepEqual([low['1'], low['2'], low['3']], [60, 360, 600]);
    assert.deepEqual([high['1'], high['2'], high['3']], [60, 360, 600]);
    assert.ok(high['4'] < low['4'], `Easy: ${high['4']} < ${low['4']}`);
  });

  test('a star change re-derives the schedule from the same logs: progress kept, intervals change', () => {
    const before = toSchedule(replayCard(T0, HISTORY, retentionFor(1, true)), 180);
    const after = toSchedule(replayCard(T0, HISTORY, retentionFor(4, true)), 180);
    assert.deepEqual(
      { state: after.state, reps: after.reps, lapses: after.lapses, lastReview: after.lastReview },
      { state: before.state, reps: before.reps, lapses: before.lapses, lastReview: before.lastReview },
    );
    assert.equal(before.reps, 5);
    assert.equal(before.lapses, 1);
    assert.ok(after.due.getTime() < before.due.getTime(), '4 ★ comes back sooner than 1 ★');
    // Back to 1 ★: exactly the original schedule (nothing was reset or lost).
    assert.deepEqual(toSchedule(replayCard(T0, HISTORY, retentionFor(1, true)), 180), before);
  });

  test('daily material order: 4 ★, then 3 ★, then by weight; 1–2 ★ rank like unsaved items', () => {
    const seen = new Date('2026-11-19T00:00:00Z');
    const rows = [
      { name: 'heavy', stars: 0, errorCount: 3, lookupCount: 2, lastSeenAt: seen },
      { name: 'two', stars: 2, errorCount: 0, lookupCount: 1, lastSeenAt: seen },
      { name: 'three', stars: 3, errorCount: 0, lookupCount: 1, lastSeenAt: seen },
      { name: 'four', stars: 4, errorCount: 0, lookupCount: 0, lastSeenAt: seen },
      { name: 'one', stars: 1, errorCount: 0, lookupCount: 5, lastSeenAt: seen },
    ];
    assert.deepEqual([...rows].sort(compareForMaterial).map((row) => row.name), ['four', 'three', 'heavy', 'one', 'two']);
  });
});
