export interface BoundedCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
}

interface CacheEntry<V> {
  expiresAt: number;
  lastAccessedAt: number;
  value: V;
}

export class BoundedCache<K, V> {
  private entries = new Map<K, CacheEntry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: BoundedCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.ttlMs = options.ttlMs ?? 15 * 60 * 1000; // 15 minutes
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }

    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return;
    }

    entry.lastAccessedAt = Date.now();
    return entry.value;
  }

  set(key: K, value: V, customTtlMs?: number): void {
    this.evictExpired();

    if (this.entries.size >= this.maxEntries) {
      this.evictOldest();
    }

    const now = Date.now();
    this.entries.set(key, {
      expiresAt: now + (customTtlMs ?? this.ttlMs),
      lastAccessedAt: now,
      value,
    });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      if (now > entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: K | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;

    for (const [key, entry] of this.entries.entries()) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }
}
