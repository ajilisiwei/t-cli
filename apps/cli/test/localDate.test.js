// Local dates depend on the process time zone. Pin a non-UTC zone (UTC+8, no
// DST) so local and UTC dates differ for eight hours of every day.
process.env.TZ = 'Asia/Shanghai';

import test from 'node:test';
import assert from 'node:assert/strict';
import { localDateString, localDateDaysAgo } from '../src/utils/localDate.js';

/** Run `fn` with another TZ, restoring the pinned one afterwards. */
function withTimeZone(tz, fn) {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = original;
  }
}

test('localDateString: just before and just after local midnight in UTC+8', () => {
  // Local 2026-11-17 23:59:59.999 = 15:59:59.999Z
  assert.equal(localDateString(new Date('2026-11-17T15:59:59.999Z')), '2026-11-17');
  // Local 2026-11-18 00:00:00 = 16:00:00Z (UTC is still on the 17th)
  assert.equal(localDateString(new Date('2026-11-17T16:00:00.000Z')), '2026-11-18');
  assert.equal(localDateString(new Date('2026-11-17T16:00:30.000Z')), '2026-11-18');
});

test('localDateString: 07:30 in Beijing is the local day, not the previous UTC day', () => {
  const morning = new Date('2026-11-17T23:30:00.000Z'); // local 2026-11-18 07:30
  assert.equal(morning.toISOString().slice(0, 10), '2026-11-17', 'the old UTC rule');
  assert.equal(localDateString(morning), '2026-11-18');
});

test('localDateString: negative offset (America/New_York, EST)', () => {
  withTimeZone('America/New_York', () => {
    // Local 2026-11-17 23:59 = 2026-11-18 04:59Z (UTC already on the 18th)
    assert.equal(localDateString(new Date('2026-11-18T04:59:00.000Z')), '2026-11-17');
    // Local 2026-11-18 00:00 = 05:00Z
    assert.equal(localDateString(new Date('2026-11-18T05:00:00.000Z')), '2026-11-18');
  });
});

test('localDateString: pads month and day; rejects invalid dates', () => {
  assert.equal(localDateString(new Date(2026, 0, 5, 12)), '2026-01-05');
  assert.throws(() => localDateString(new Date('nope')), TypeError);
  assert.throws(() => localDateString('2026-11-18'), TypeError);
});

test('localDateDaysAgo: counts local calendar days, also right after midnight', () => {
  const justAfterMidnight = new Date('2026-11-17T16:00:30.000Z'); // local 2026-11-18 00:00:30
  assert.equal(localDateDaysAgo(0, justAfterMidnight), '2026-11-18');
  assert.equal(localDateDaysAgo(1, justAfterMidnight), '2026-11-17');
  assert.equal(localDateDaysAgo(7, justAfterMidnight), '2026-11-11');
  const justBeforeMidnight = new Date('2026-11-17T15:59:59.000Z'); // local 2026-11-17 23:59:59
  assert.equal(localDateDaysAgo(0, justBeforeMidnight), '2026-11-17');
  assert.equal(localDateDaysAgo(7, justBeforeMidnight), '2026-11-10');
});

test('localDateDaysAgo: crosses month/year boundaries and DST changes', () => {
  assert.equal(localDateDaysAgo(3, new Date(2026, 0, 2, 9)), '2025-12-30');
  withTimeZone('America/New_York', () => {
    // DST ended 2026-11-01 (a 25-hour day); calendar arithmetic is unaffected.
    assert.equal(localDateDaysAgo(1, new Date(2026, 10, 2, 0, 30)), '2026-11-01');
    assert.equal(localDateDaysAgo(2, new Date(2026, 10, 2, 0, 30)), '2026-10-31');
  });
});

test('localDateDaysAgo: rejects negative or fractional day counts', () => {
  assert.throws(() => localDateDaysAgo(-1), TypeError);
  assert.throws(() => localDateDaysAgo(1.5), TypeError);
  assert.throws(() => localDateDaysAgo(Number.NaN), TypeError);
});
