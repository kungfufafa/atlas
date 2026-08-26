import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ATLAS_API_VERSION } from "./contract";
import {
  getErrorTrackingConfigDir,
  getErrorTrackingFingerprintKeyPath,
  isErrorTrackingEnabled,
} from "./error-tracking-config";
import {
  appendPendingErrorReport,
  readPendingErrorReports,
  removePendingErrorReport,
} from "./error-tracking-queue";
import { scrubText } from "./error-tracking-scrub";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./fs";

export type ErrorReportKind = "crash" | "test";

export interface ErrorReport {
  at: string;
  fingerprint: string;
  /** Also used as the Sentry event id, so retries collapse into one event. */
  id: string;
  kind: ErrorReportKind;
  message: string;
  name: string;
  runtime: { apiVersion: number; arch: string; bun: string; platform: string };
  source: string;
  stack?: string;
}

export type ErrorSink = (report: ErrorReport) => boolean | Promise<boolean>;

let enabled = false;
let sink: ErrorSink | null = null;

// The transport normally gives up after 3s; lifecycle exit must be bounded too.
const FATAL_REPORT_GRACE_MS = 3500;

export async function refreshErrorTrackingEnabled(): Promise<boolean> {
  enabled = await isErrorTrackingEnabled();
  return enabled;
}

const SAFE_ERROR_NAMES = new Set([
  "AggregateError",
  "AtlasApiError",
  "Error",
  "EvalError",
  "NonError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);
const FINGERPRINT_KEY_BYTES = 32;
const MAX_FINGERPRINT_MESSAGE_LENGTH = 512;
const MAX_FINGERPRINT_FRAME_LENGTH = 256;
const PROCESS_FINGERPRINT_KEY = randomBytes(FINGERPRINT_KEY_BYTES);
const fingerprintKeys = new Map<string, Buffer>();

function normalizeFingerprintMessage(message: string): string {
  return scrubText(message)
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<uuid>"
    )
    .replace(
      /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{8,}\b/g,
      "<id>"
    )
    .replace(/'[^']*'/g, "'<value>'")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FINGERPRINT_MESSAGE_LENGTH);
}

function topApplicationFrame(stack: string | undefined): string {
  if (!stack) {
    return "unknown";
  }

  for (const line of scrubText(stack).split("\n").slice(1)) {
    const trimmed = line.trim();
    if (
      !trimmed.startsWith("at ") ||
      trimmed.includes("node_modules") ||
      trimmed.includes("node:")
    ) {
      continue;
    }
    return trimmed
      .replace(/:\d+:\d+(\)?)$/, "$1")
      .replace(/\s+/g, " ")
      .slice(0, MAX_FINGERPRINT_FRAME_LENGTH);
  }

  return "unknown";
}

function readFingerprintKey(path: string): Buffer | null {
  try {
    const encoded = readFileSync(path, "utf8").trim();
    if (!/^[0-9a-f]{64}$/i.test(encoded)) {
      return null;
    }
    return Buffer.from(encoded, "hex");
  } catch {
    return null;
  }
}

function fingerprintKey(): Buffer {
  const path = getErrorTrackingFingerprintKeyPath();
  const cached = fingerprintKeys.get(path);
  if (cached) {
    return cached;
  }

  const existing = readFingerprintKey(path);
  if (existing) {
    fingerprintKeys.set(path, existing);
    return existing;
  }

  try {
    mkdirSync(getErrorTrackingConfigDir(), {
      mode: PRIVATE_DIR_MODE,
      recursive: true,
    });
    chmodSync(getErrorTrackingConfigDir(), PRIVATE_DIR_MODE);
    const generated = randomBytes(FINGERPRINT_KEY_BYTES);
    try {
      writeFileSync(path, `${generated.toString("hex")}\n`, {
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
    } catch (error) {
      const raced = readFingerprintKey(path);
      if (raced) {
        fingerprintKeys.set(path, raced);
        return raced;
      }
      throw error;
    }
    chmodSync(path, PRIVATE_FILE_MODE);
    fingerprintKeys.set(path, generated);
    return generated;
  } catch {
    return PROCESS_FINGERPRINT_KEY;
  }
}

export function fingerprintError(
  name: string,
  message = "",
  stack?: string
): string {
  const safeName = SAFE_ERROR_NAMES.has(name) ? name : "Error";
  const signature = [
    safeName,
    normalizeFingerprintMessage(message),
    topApplicationFrame(stack),
  ].join("|");

  return createHmac("sha256", fingerprintKey())
    .update(signature)
    .digest("hex")
    .slice(0, 32);
}

function safelyStringify(error: unknown): string {
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    try {
      return String(error);
    } catch {
      return "Unprintable non-Error rejection";
    }
  }
}

function readStringPropertySafely(
  value: object,
  property: "message" | "name" | "stack"
): string | undefined {
  try {
    const candidate = Reflect.get(value, property);
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    // Hostile proxies must degrade to an absent diagnostic field.
  }
}

function isErrorSafely(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function errorToParts(error: unknown): {
  message: string;
  name: string;
  stack?: string;
} {
  if (isErrorSafely(error)) {
    const fallback = safelyStringify(error);
    const message = readStringPropertySafely(error, "message");
    const name = readStringPropertySafely(error, "name");
    const stack = readStringPropertySafely(error, "stack");

    return {
      message: message || fallback,
      name: name || "Error",
      ...(stack ? { stack } : {}),
    };
  }

  if (typeof error === "string") {
    return { message: error, name: "NonError" };
  }

  return { message: safelyStringify(error), name: "NonError" };
}

export interface ReportErrorOptions {
  kind?: ErrorReportKind;
  source?: string;
}

export function buildErrorReport(
  error: unknown,
  options: ReportErrorOptions = {}
): ErrorReport {
  const parts = errorToParts(error);
  const stack = parts.stack ? scrubText(parts.stack) : undefined;

  return {
    at: new Date().toISOString(),
    fingerprint: fingerprintError(parts.name, parts.message, parts.stack),
    id: randomUUID(),
    kind: options.kind ?? "crash",
    message: scrubText(parts.message),
    name: scrubText(parts.name) || "Error",
    runtime: {
      apiVersion: ATLAS_API_VERSION,
      arch: process.arch,
      bun: Bun.version,
      platform: process.platform,
    },
    source: scrubText(options.source ?? "unknown"),
    ...(stack ? { stack } : {}),
  };
}

export function setErrorSink(next: ErrorSink | null): void {
  sink = next;
}

/** Never throws; failed sends remain queued for the next server startup. */
export async function reportError(
  error: unknown,
  options: ReportErrorOptions = {}
): Promise<ErrorReport> {
  const report = buildErrorReport(error, options);

  try {
    console.error(
      `[atlas:${report.kind}] ${report.source} ${report.fingerprint}`,
      error
    );
  } catch {
    // A closed stderr must not turn one crash into two.
  }

  const currentSink = sink;

  if (!(enabled && currentSink)) {
    return report;
  }

  appendPendingErrorReport(report);

  try {
    if (await currentSink(report)) {
      removePendingErrorReport(report.id);
    }
  } catch {
    // The report stays queued for a later startup.
  }

  return report;
}

export async function flushPendingErrorReports(): Promise<number> {
  const currentSink = sink;

  if (!currentSink) {
    return 0;
  }

  let delivered = 0;

  for (const report of readPendingErrorReports()) {
    try {
      if (await currentSink(report)) {
        removePendingErrorReport(report.id);
        delivered += 1;
      }
    } catch {
      // The report stays queued until delivery succeeds.
    }
  }

  return delivered;
}

/**
 * uncaughtExceptionMonitor preserves Bun's crash behavior. Bun suppresses its
 * default unhandled-rejection exit when a listener exists, so that exit is
 * restored after the bounded delivery attempt.
 */
export function installErrorHandlers(source: string): () => void {
  const onUncaught = (error: unknown) => {
    void reportError(error, { source });
  };
  const onRejection = (reason: unknown) => {
    let exitRequested = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const exitWithFailure = () => {
      if (exitRequested) {
        return;
      }

      exitRequested = true;
      if (exitTimer !== undefined) {
        clearTimeout(exitTimer);
      }
      process.exit(1);
    };

    exitTimer = setTimeout(exitWithFailure, FATAL_REPORT_GRACE_MS);
    void reportError(reason, { source }).then(exitWithFailure, exitWithFailure);
  };

  process.on("uncaughtExceptionMonitor", onUncaught);
  process.on("unhandledRejection", onRejection);

  return () => {
    process.off("uncaughtExceptionMonitor", onUncaught);
    process.off("unhandledRejection", onRejection);
  };
}
