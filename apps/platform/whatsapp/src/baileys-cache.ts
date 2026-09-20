import type { CacheStore } from "@whiskeysockets/baileys";

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

/** The protocol can supply null stanza IDs despite CacheStore's string types. */
export class WhatsAppProtocolCache implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly options: {
      maxEntries?: number;
      now?: () => number;
      retainAtRetryLimit?: number;
      ttlMs: number;
    }
  ) {}

  get<T>(key: unknown): T | undefined {
    if (typeof key !== "string" || !key) {
      return;
    }
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return;
    }
    return entry.value as T;
  }

  set<T>(key: unknown, value: T): void {
    if (typeof key !== "string" || !key) {
      return;
    }
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
      }
    }
    if (!this.entries.has(key)) {
      while (this.entries.size >= (this.options.maxEntries ?? 2048)) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { expiresAt: now + this.options.ttlMs, value });
  }

  del(key: unknown): void {
    if (typeof key !== "string") {
      return;
    }
    const value = this.get<unknown>(key);
    if (
      this.options.retainAtRetryLimit !== undefined &&
      typeof value === "number" &&
      value >= this.options.retainAtRetryLimit
    ) {
      // Baileys deletes an exhausted counter. Keep its TTL tombstone so the
      // next replay cannot start another full batch of failed decrypt retries.
      return;
    }
    this.entries.delete(key);
  }

  flushAll(): void {
    this.entries.clear();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
