import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/lib/rateLimit.ts';

test('allows up to the limit within the window, then reports when to retry', () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.hit('u1', 0).allowed, true);
  assert.equal(limiter.hit('u1', 100).allowed, true);
  assert.deepEqual(limiter.hit('u1', 200), { allowed: false, retryAfterMs: 800 });
  assert.equal(limiter.hit('u1', 1001).allowed, true, 'the first hit has left the window');
});

test('keys are independent', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.hit('a', 0).allowed, true);
  assert.equal(limiter.hit('b', 0).allowed, true);
  assert.equal(limiter.hit('a', 1).allowed, false);
});

test('memory is bounded by evicting the least recently used key', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2 });
  limiter.hit('a', 0);
  limiter.hit('b', 1);
  limiter.hit('c', 2); // evicts 'a'
  assert.equal(limiter.hit('a', 3).allowed, true, "'a' was forgotten");
  assert.equal(limiter.hit('c', 4).allowed, false, "'c' is still tracked");
});
