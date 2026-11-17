/**
 * In-memory sliding-window rate limiter.
 *
 * The service runs as a single process, so in-memory state is enough and
 * avoids a Redis dependency. Limits reset on restart, which is acceptable for
 * abuse protection; the durable daily AI quota lives in the database instead.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the next hit would be allowed (0 when allowed). */
  retryAfterMs: number;
}

export interface RateLimiter {
  hit(key: string, nowMs: number): RateLimitResult;
}

export function createRateLimiter({
  limit,
  windowMs,
  maxKeys = 10_000,
}: {
  limit: number;
  windowMs: number;
  /** Bound memory: the least recently used key is evicted beyond this. */
  maxKeys?: number;
}): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    hit(key, nowMs) {
      const windowStart = nowMs - windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);
      hits.delete(key);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return { allowed: false, retryAfterMs: Math.max(0, recent[0]! + windowMs - nowMs) };
      }
      hits.set(key, [...recent, nowMs]);
      if (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}
