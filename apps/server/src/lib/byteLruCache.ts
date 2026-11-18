/**
 * In-memory LRU cache bounded by bytes rather than entries, for binary values
 * of very different sizes (e.g. synthesized audio). Like the rate limiter it
 * is per process and starts empty after a restart.
 */
export interface ByteLruCache {
  /** The value, marked as most recently used; undefined on a miss. */
  get(key: string): Uint8Array | undefined;
  /** Store a value, evicting the least recently used ones beyond the budget. Values larger than the whole budget are not stored. */
  set(key: string, value: Uint8Array): void;
  /** Number of cached values. */
  readonly size: number;
  /** Bytes accounted for: values plus their keys (two bytes per UTF-16 unit). */
  readonly bytes: number;
}

const costOf = (key: string, value: Uint8Array): number => value.byteLength + key.length * 2;

export function createByteLruCache({ maxBytes }: { maxBytes: number }): ByteLruCache {
  // A Map iterates in insertion order: re-inserting on access keeps the least
  // recently used entry first.
  const entries = new Map<string, Uint8Array>();
  let bytes = 0;

  const remove = (key: string): void => {
    const value = entries.get(key);
    if (value === undefined) return;
    entries.delete(key);
    bytes -= costOf(key, value);
  };

  return {
    get(key) {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      remove(key);
      const cost = costOf(key, value);
      if (cost > maxBytes) return;
      entries.set(key, value);
      bytes += cost;
      while (bytes > maxBytes) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        remove(oldest.value);
      }
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}
