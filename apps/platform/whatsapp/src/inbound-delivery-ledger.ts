import {
  appendFile,
  chmod,
  open,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir, PRIVATE_FILE_MODE } from "@atlas/core/fs";

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_COMPLETED = 50_000;
const COMPACTION_TARGET_RATIO = 0.8;
const MAX_PERSISTED_RECORD_BYTES = 256;
const MIN_LEDGER_READ_BYTES = 64 * 1024;

interface CompletedDeliveryRecord {
  completedAt: number;
  id: string;
}

interface InboundDeliveryLedgerOptions {
  maxCompleted?: number;
  now?: () => number;
  retentionMs?: number;
}

/**
 * Durable, workspace-local idempotency ledger for successfully handled inbound
 * WhatsApp messages. In-flight claims stay in memory so a failed handler can be
 * retried, while completed claims survive worker restarts.
 */
export class InboundDeliveryLedger {
  private readonly completed = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly maxCompleted: number;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private persistedRecordCount = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    options: InboundDeliveryLedgerOptions = {}
  ) {
    this.maxCompleted = options.maxCompleted ?? DEFAULT_MAX_COMPLETED;
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  async load(): Promise<void> {
    const ledger = await readLedgerTail(
      this.path,
      Math.max(
        MIN_LEDGER_READ_BYTES,
        this.maxCompleted * MAX_PERSISTED_RECORD_BYTES
      )
    );
    if (!ledger) {
      return;
    }

    const cutoff = this.now() - this.retentionMs;
    let needsCompaction = ledger.truncated;
    for (const line of ledger.raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      this.persistedRecordCount += 1;

      try {
        const record = JSON.parse(trimmed) as Partial<CompletedDeliveryRecord>;
        if (
          typeof record.id !== "string" ||
          typeof record.completedAt !== "number" ||
          !Number.isFinite(record.completedAt)
        ) {
          needsCompaction = true;
          continue;
        }
        if (record.completedAt <= cutoff) {
          needsCompaction = true;
          continue;
        }
        this.completed.set(record.id, record.completedAt);
      } catch {
        needsCompaction = true;
      }
    }

    if (this.trimToCapacity()) {
      needsCompaction = true;
    }
    if (this.persistedRecordCount > this.maxCompleted) {
      needsCompaction = true;
    }
    if (needsCompaction) {
      await this.compact();
    }
  }

  claim(id: string): boolean {
    this.pruneExpired();
    if (this.completed.has(id) || this.inFlight.has(id)) {
      return false;
    }
    this.inFlight.add(id);
    return true;
  }

  release(id: string): void {
    this.inFlight.delete(id);
  }

  async complete(id: string): Promise<void> {
    this.inFlight.delete(id);
    const completedAt = this.now();
    this.completed.set(id, completedAt);

    const shouldCompactForCapacity = this.trimToCapacity();
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await ensureDir(dirname(this.path));
        this.persistedRecordCount += 1;
        if (
          shouldCompactForCapacity ||
          this.persistedRecordCount > this.maxCompleted
        ) {
          await this.writeSnapshot();
          return;
        }
        await appendFile(
          this.path,
          `${JSON.stringify({ completedAt, id } satisfies CompletedDeliveryRecord)}\n`,
          { encoding: "utf8", mode: PRIVATE_FILE_MODE }
        );
        await chmod(this.path, PRIVATE_FILE_MODE);
      });
    await this.writeQueue;
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, completedAt] of this.completed) {
      if (completedAt > cutoff) {
        continue;
      }
      this.completed.delete(id);
    }
  }

  private trimToCapacity(): boolean {
    this.pruneExpired();
    if (this.completed.size <= this.maxCompleted) {
      return false;
    }

    const targetSize = Math.max(
      1,
      Math.floor(this.maxCompleted * COMPACTION_TARGET_RATIO)
    );
    const oldest = [...this.completed.entries()].sort(
      ([, left], [, right]) => left - right
    );
    for (const [id] of oldest.slice(0, oldest.length - targetSize)) {
      this.completed.delete(id);
    }
    return true;
  }

  private async compact(): Promise<void> {
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await ensureDir(dirname(this.path));
        await this.writeSnapshot();
      });
    await this.writeQueue;
  }

  private async writeSnapshot(): Promise<void> {
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    const snapshot = [...this.completed.entries()]
      .sort(([, left], [, right]) => left - right)
      .map(([id, completedAt]) =>
        JSON.stringify({ completedAt, id } satisfies CompletedDeliveryRecord)
      )
      .join("\n");
    try {
      await writeFile(temporaryPath, snapshot ? `${snapshot}\n` : "", {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
      });
      await rename(temporaryPath, this.path);
      await chmod(this.path, PRIVATE_FILE_MODE);
      this.persistedRecordCount = this.completed.size;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

async function readLedgerTail(
  path: string,
  maxBytes: number
): Promise<{ raw: string; truncated: boolean } | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }

  const bytesToRead = Math.min(size, maxBytes);
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await file.read(
      buffer,
      0,
      bytesToRead,
      size - bytesToRead
    );
    let raw = buffer.subarray(0, bytesRead).toString("utf8");
    const truncated = size > bytesToRead;
    if (truncated) {
      const firstCompleteRecord = raw.indexOf("\n");
      raw = firstCompleteRecord >= 0 ? raw.slice(firstCompleteRecord + 1) : "";
    }
    return { raw, truncated };
  } finally {
    await file.close();
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === code
  );
}
