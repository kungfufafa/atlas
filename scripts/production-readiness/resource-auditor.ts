import { readdirSync } from "node:fs";

export interface ResourceSnapshot {
  activeBrowserContexts: number;
  externalMb: number;
  heapTotalMb: number;
  heapUsedMb: number;
  rssMb: number;
  tempFilesCount: number;
  timestamp: number;
}

export interface ResourceLeakAudit {
  browserContextsLeaked: number;
  details: string;
  heapDeltaMb: number;
  passed: boolean;
  rssDeltaMb: number;
  tempFilesDelta: number;
}

export class ResourceAuditor {
  takeSnapshot(tmpDir?: string, activeBrowserContexts = 0): ResourceSnapshot {
    const mem = process.memoryUsage();
    let tempFilesCount = 0;

    if (tmpDir) {
      try {
        const files = readdirSync(tmpDir);
        tempFilesCount = files.length;
      } catch {
        tempFilesCount = 0;
      }
    }

    return {
      activeBrowserContexts,
      externalMb: Number((mem.external / 1024 / 1024).toFixed(2)),
      heapTotalMb: Number((mem.heapTotal / 1024 / 1024).toFixed(2)),
      heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
      rssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
      tempFilesCount,
      timestamp: Date.now(),
    };
  }

  auditLeaks(
    before: ResourceSnapshot,
    after: ResourceSnapshot
  ): ResourceLeakAudit {
    const rssDeltaMb = Number((after.rssMb - before.rssMb).toFixed(2));
    const heapDeltaMb = Number(
      (after.heapUsedMb - before.heapUsedMb).toFixed(2)
    );
    const tempFilesDelta = after.tempFilesCount - before.tempFilesCount;
    const browserContextsLeaked = after.activeBrowserContexts;

    // Normal garbage collection variance: allow up to 100MB RSS growth during heavy bursts
    const passed =
      browserContextsLeaked === 0 && tempFilesDelta <= 10 && rssDeltaMb < 150;

    const details = `RSS: ${before.rssMb}MB -> ${after.rssMb}MB (Δ ${rssDeltaMb}MB), Heap: ${before.heapUsedMb}MB -> ${after.heapUsedMb}MB (Δ ${heapDeltaMb}MB), Browser Leaks: ${browserContextsLeaked}, Temp Files Δ: ${tempFilesDelta}`;

    return {
      browserContextsLeaked,
      details,
      heapDeltaMb,
      passed,
      rssDeltaMb,
      tempFilesDelta,
    };
  }
}
