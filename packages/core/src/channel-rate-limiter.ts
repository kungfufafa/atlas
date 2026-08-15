export interface RateLimiterOptions {
  /** Cooldown notification throttle window in milliseconds. Defaults to 60,000. */
  cooldownThrottleMs?: number;
  /** Maximum number of allowed requests in the sliding window. Defaults to 10. */
  maxRequests?: number;
  /** Sliding window duration in milliseconds. Defaults to 60,000 (1 minute). */
  windowMs?: number;
}

export class ChannelRateLimiter {
  private readonly defaultMaxRequests: number;
  private readonly defaultWindowMs: number;
  private readonly defaultCooldownThrottleMs: number;

  private timestamps = new Map<string, number[]>();
  private lastNotified = new Map<string, number>();

  constructor(options?: RateLimiterOptions) {
    this.defaultMaxRequests = options?.maxRequests ?? 10;
    this.defaultWindowMs = options?.windowMs ?? 60_000;
    this.defaultCooldownThrottleMs = options?.cooldownThrottleMs ?? 60_000;
  }

  /**
   * Evaluates if a request from the given key (e.g. phone number, user ID) is allowed.
   */
  isAllowed(
    key: string,
    override?: { maxRequests?: number; windowMs?: number }
  ): boolean {
    const now = Date.now();
    const windowMs = override?.windowMs ?? this.defaultWindowMs;
    const maxRequests = override?.maxRequests ?? this.defaultMaxRequests;
    const cutoff = now - windowMs;

    const list = this.timestamps.get(key);
    if (!list) {
      this.timestamps.set(key, [now]);
      this.pruneOldEntries(now);
      return true;
    }

    const filtered = list.filter((t) => t > cutoff);
    if (filtered.length >= maxRequests) {
      this.timestamps.set(key, filtered);
      return false;
    }

    filtered.push(now);
    this.timestamps.set(key, filtered);
    return true;
  }

  /**
   * Determines whether a cooldown / rate-limit exceeded notice should be sent.
   * Throttles sending to at most once per cooldownThrottleMs window.
   */
  shouldSendCooldownNotice(key: string, customThrottleMs?: number): boolean {
    const now = Date.now();
    const throttleMs = customThrottleMs ?? this.defaultCooldownThrottleMs;
    const last = this.lastNotified.get(key);

    if (last && now - last < throttleMs) {
      return false;
    }

    this.lastNotified.set(key, now);
    return true;
  }

  /**
   * Resets all internal states. Useful for unit testing.
   */
  reset(): void {
    this.timestamps.clear();
    this.lastNotified.clear();
  }

  /**
   * Prunes keys that have no recent timestamps to prevent memory leaks over time.
   */
  private pruneOldEntries(now: number): void {
    if (this.timestamps.size < 1000) {
      return;
    }

    const cutoff = now - this.defaultWindowMs;
    for (const [k, list] of this.timestamps.entries()) {
      const active = list.filter((t) => t > cutoff);
      if (active.length === 0) {
        this.timestamps.delete(k);
        this.lastNotified.delete(k);
      } else {
        this.timestamps.set(k, active);
      }
    }
  }
}
