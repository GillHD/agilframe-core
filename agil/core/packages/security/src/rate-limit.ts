/**
 * Fixed-window in-memory rate limiter with bounded memory.
 *
 * Used for join (300/min per IP+room, enough to fill a 200-seat room from one
 * NAT), files/STT (30/min per tenant) and admin (120/min) limits. Memory is
 * bounded by `maxKeys`; the least-recently-used key is evicted when the map
 * grows past the limit.
 */

export interface RateLimiterOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum number of allowed hits per window and key. */
  max: number;
  /** Maximum number of tracked keys (default 10_000). */
  maxKeys?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 0 when allowed; otherwise milliseconds until the window resets. */
  retryAfterMs: number;
  /** Hits left in the current window (0 when rejected). */
  remaining: number;
}

export interface RateLimiter {
  check(key: string): RateLimitDecision;
  /** Clears the bucket for one key (e.g. after a successful password join). */
  reset(key: string): void;
  /** Number of tracked keys (for tests/health endpoints). */
  readonly size: number;
  /** Drops all buckets. */
  clear(): void;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_KEYS = 10_000;

/** Creates a bounded, fixed-window rate limiter. */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? Math.floor(opts.windowMs) : 60_000;
  const max = Number.isFinite(opts.max) && opts.max >= 1 ? Math.floor(opts.max) : 1;
  const maxKeys =
    Number.isFinite(opts.maxKeys) && (opts.maxKeys as number) >= 1 ? Math.floor(opts.maxKeys as number) : DEFAULT_MAX_KEYS;

  const buckets = new Map<string, Bucket>();

  function evict(): void {
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }
  }

  function check(key: string): RateLimitDecision {
    const bucketKey = typeof key === 'string' ? key : String(key);
    const now = Date.now();
    let bucket = buckets.get(bucketKey);

    if (bucket && now >= bucket.resetAt) {
      // Window elapsed: start a fresh one, keep insertion order so this key
      // counts as recently used.
      buckets.delete(bucketKey);
      bucket = undefined;
    }

    if (!bucket) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
      evict();
    } else {
      // Refresh LRU position.
      buckets.delete(bucketKey);
      buckets.set(bucketKey, bucket);
    }

    if (bucket.count >= max) {
      return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - now), remaining: 0 };
    }

    bucket.count += 1;
    return { allowed: true, retryAfterMs: 0, remaining: Math.max(0, max - bucket.count) };
  }

  return {
    check,
    reset(key: string): void {
      buckets.delete(typeof key === 'string' ? key : String(key));
    },
    get size(): number {
      return buckets.size;
    },
    clear(): void {
      buckets.clear();
    },
  };
}
