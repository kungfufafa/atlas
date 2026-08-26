import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ErrorReport } from "./error-tracking";
import { getErrorTrackingConfigDir } from "./error-tracking-config";
import { scrubText } from "./error-tracking-scrub";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./fs";

/**
 * Crash reports use one file per event so simultaneous server/worker failures
 * cannot overwrite each other through a shared read-modify-write queue.
 */
export const MAX_PENDING_ERROR_REPORTS = 5;
const MAX_PENDING_ERROR_REPORT_BYTES = 32 * 1024;
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;
const NONBLOCK_FLAG = constants.O_NONBLOCK ?? 0;
const READ_DIRECTORY_FLAGS =
  constants.O_RDONLY + DIRECTORY_FLAG + NO_FOLLOW_FLAG;
const READ_FILE_FLAGS = constants.O_RDONLY + NONBLOCK_FLAG + NO_FOLLOW_FLAG;
const CREATE_FILE_FLAGS =
  constants.O_WRONLY + constants.O_CREAT + constants.O_EXCL + NO_FOLLOW_FLAG;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/i;

interface PendingErrorReportEntry {
  device: number;
  inode: number;
  path: string;
  report: ErrorReport;
  sequence: string;
}

interface PendingPathEntry {
  createdAtMs: number;
  monotonicNs: bigint;
  path: string;
  sequence: string;
}

interface PendingFileIdentity {
  device: number;
  inode: number;
}

export function getPendingErrorReportsPath(): string {
  return join(getErrorTrackingConfigDir(), "pending");
}

function pendingReportPath(): string {
  const sequence = `${Date.now()}-${process.hrtime
    .bigint()
    .toString()
    .padStart(20, "0")}-${randomUUID()}`;
  return join(getPendingErrorReportsPath(), `${sequence}.json`);
}

function openPrivatePendingDirectory(create: boolean): number {
  const directory = getPendingErrorReportsPath();
  if (create) {
    mkdirSync(directory, {
      mode: PRIVATE_DIR_MODE,
      recursive: true,
    });
  }

  const pathStats = lstatSync(directory);
  if (pathStats.isSymbolicLink() || !pathStats.isDirectory()) {
    throw new Error("The error-report queue path is not a directory.");
  }

  const descriptor = openSync(directory, READ_DIRECTORY_FLAGS);

  try {
    const descriptorStats = fstatSync(descriptor);
    const pathWasReplaced =
      descriptorStats.dev !== pathStats.dev ||
      descriptorStats.ino !== pathStats.ino;
    if (!descriptorStats.isDirectory() || pathWasReplaced) {
      throw new Error(
        "The error-report queue directory changed while opening."
      );
    }
    fchmodSync(descriptor, PRIVATE_DIR_MODE);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function sequenceParts(
  filename: string,
  fallbackCreatedAtMs: number
): { createdAtMs: number; monotonicNs: bigint } {
  const match = /^(\d+)-(\d+)-/.exec(filename);
  if (!match) {
    return { createdAtMs: fallbackCreatedAtMs, monotonicNs: 0n };
  }

  const createdAtMs = Number(match[1]);
  try {
    return {
      createdAtMs: Number.isSafeInteger(createdAtMs)
        ? createdAtMs
        : fallbackCreatedAtMs,
      monotonicNs: BigInt(match[2] ?? "0"),
    };
  } catch {
    return { createdAtMs: fallbackCreatedAtMs, monotonicNs: 0n };
  }
}

function comparePendingPaths(
  left: PendingPathEntry,
  right: PendingPathEntry
): number {
  if (left.createdAtMs !== right.createdAtMs) {
    return left.createdAtMs - right.createdAtMs;
  }
  if (left.monotonicNs !== right.monotonicNs) {
    return left.monotonicNs < right.monotonicNs ? -1 : 1;
  }
  return left.sequence.localeCompare(right.sequence);
}

function listPendingPaths(): PendingPathEntry[] {
  const directory = getPendingErrorReportsPath();
  const directoryDescriptor = openPrivatePendingDirectory(false);

  try {
    const entries: PendingPathEntry[] = [];
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (!(item.isFile() && item.name.endsWith(".json"))) {
        continue;
      }

      const path = join(directory, item.name);
      try {
        const stats = lstatSync(path);
        if (stats.isSymbolicLink() || !stats.isFile()) {
          continue;
        }
        entries.push({
          path,
          sequence: item.name,
          ...sequenceParts(item.name, Math.trunc(stats.mtimeMs)),
        });
      } catch {
        // Another process may have drained it after the directory scan.
      }
    }

    return entries.sort(comparePendingPaths);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function isErrorReport(value: unknown): value is ErrorReport {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const report = value as Partial<ErrorReport>;
  const runtime = report.runtime;

  return (
    typeof report.at === "string" &&
    new Date(report.at).toISOString() === report.at &&
    typeof report.fingerprint === "string" &&
    FINGERPRINT_PATTERN.test(report.fingerprint) &&
    typeof report.id === "string" &&
    UUID_PATTERN.test(report.id) &&
    (report.kind === "crash" || report.kind === "test") &&
    typeof report.message === "string" &&
    typeof report.name === "string" &&
    typeof report.source === "string" &&
    (report.stack === undefined || typeof report.stack === "string") &&
    typeof runtime === "object" &&
    runtime !== null &&
    typeof runtime.apiVersion === "number" &&
    Number.isSafeInteger(runtime.apiVersion) &&
    typeof runtime.arch === "string" &&
    typeof runtime.bun === "string" &&
    typeof runtime.platform === "string"
  );
}

function normalizeErrorReport(value: unknown): ErrorReport | null {
  try {
    if (!isErrorReport(value)) {
      return null;
    }

    const message = scrubText(value.message);
    const name = scrubText(value.name) || "Error";
    const source = scrubText(value.source) || "unknown";
    const stack = value.stack ? scrubText(value.stack) : undefined;

    return {
      at: value.at,
      fingerprint: value.fingerprint.toLowerCase(),
      id: value.id.toLowerCase(),
      kind: value.kind,
      message,
      name,
      runtime: {
        apiVersion: value.runtime.apiVersion,
        arch: scrubText(value.runtime.arch),
        bun: scrubText(value.runtime.bun),
        platform: scrubText(value.runtime.platform),
      },
      source,
      ...(stack ? { stack } : {}),
    };
  } catch {
    return null;
  }
}

function samePendingFile(path: string, identity: PendingFileIdentity): boolean {
  try {
    const stats = lstatSync(path);
    return (
      !stats.isSymbolicLink() &&
      stats.isFile() &&
      stats.dev === identity.device &&
      stats.ino === identity.inode
    );
  } catch {
    return false;
  }
}

function unlinkPendingFile(path: string, identity: PendingFileIdentity): void {
  if (!samePendingFile(path, identity)) {
    return;
  }

  try {
    unlinkSync(path);
  } catch {
    // Another process may have drained it after the identity check.
  }
}

function inspectPendingFile(
  entry: PendingPathEntry
): { identity: PendingFileIdentity; report: ErrorReport | null } | null {
  let descriptor: number | null = null;

  try {
    descriptor = openSync(entry.path, READ_FILE_FLAGS);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      return null;
    }

    const identity = { device: stats.dev, inode: stats.ino };
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    if (stats.size <= 0 || stats.size > MAX_PENDING_ERROR_REPORT_BYTES) {
      return { identity, report: null };
    }

    const serialized = readFileSync(descriptor, "utf8");
    try {
      const parsed: unknown = JSON.parse(serialized);
      return { identity, report: normalizeErrorReport(parsed) };
    } catch {
      return { identity, report: null };
    }
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
  }
}

function pendingFileIdentity(path: string): PendingFileIdentity | null {
  let descriptor: number | null = null;

  try {
    descriptor = openSync(path, READ_FILE_FLAGS);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      return null;
    }
    return { device: stats.dev, inode: stats.ino };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
  }
}

function readPendingEntries(): PendingErrorReportEntry[] {
  try {
    const entries: PendingErrorReportEntry[] = [];

    for (const entry of listPendingPaths()) {
      const inspected = inspectPendingFile(entry);
      if (!inspected) {
        continue;
      }
      if (!inspected.report) {
        unlinkPendingFile(entry.path, inspected.identity);
        continue;
      }
      entries.push({
        device: inspected.identity.device,
        inode: inspected.identity.inode,
        path: entry.path,
        report: inspected.report,
        sequence: entry.sequence,
      });
    }

    return entries;
  } catch {
    return [];
  }
}

export function readPendingErrorReports(): ErrorReport[] {
  return readPendingEntries().map((entry) => entry.report);
}

/** Synchronous on purpose so the queue write completes before a crash exits. */
export function appendPendingErrorReport(report: ErrorReport): void {
  let directoryDescriptor: number | null = null;
  let reportDescriptor: number | null = null;
  let reportIdentity: PendingFileIdentity | null = null;
  let reportPath: string | null = null;

  try {
    const normalizedReport = normalizeErrorReport(report);
    if (!normalizedReport) {
      throw new Error("The error report is invalid.");
    }

    directoryDescriptor = openPrivatePendingDirectory(true);
    reportPath = pendingReportPath();
    reportDescriptor = openSync(
      reportPath,
      CREATE_FILE_FLAGS,
      PRIVATE_FILE_MODE
    );
    const stats = fstatSync(reportDescriptor);
    reportIdentity = { device: stats.dev, inode: stats.ino };
    fchmodSync(reportDescriptor, PRIVATE_FILE_MODE);
    writeFileSync(reportDescriptor, JSON.stringify(normalizedReport), "utf8");
    fsyncSync(reportDescriptor);
    closeSync(reportDescriptor);
    reportDescriptor = null;
    try {
      fsyncSync(directoryDescriptor);
    } catch {
      // Some supported filesystems do not allow fsync on a directory.
    }

    const paths = listPendingPaths();
    for (const entry of paths.slice(0, -MAX_PENDING_ERROR_REPORTS)) {
      const identity = pendingFileIdentity(entry.path);
      if (identity) {
        unlinkPendingFile(entry.path, identity);
      }
    }
  } catch (error) {
    if (reportPath && reportIdentity) {
      unlinkPendingFile(reportPath, reportIdentity);
    }
    console.error("[atlas:error-tracking] cannot queue report", error);
  } finally {
    if (reportDescriptor !== null) {
      closeSync(reportDescriptor);
    }
    if (directoryDescriptor !== null) {
      closeSync(directoryDescriptor);
    }
  }
}

export function removePendingErrorReport(id: string): void {
  for (const entry of readPendingEntries()) {
    if (entry.report.id !== id) {
      continue;
    }
    unlinkPendingFile(entry.path, {
      device: entry.device,
      inode: entry.inode,
    });
  }
}
