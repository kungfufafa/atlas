import {
  type ErrorReport,
  type ErrorReportKind,
  type ErrorSink,
  refreshErrorTrackingEnabled,
  setErrorSink,
} from "./error-tracking";
import {
  loadErrorTrackingConfig,
  resolveErrorTrackingDsn,
} from "./error-tracking-config";

const SEND_TIMEOUT_MS = 3000;
const SENTRY_CLIENT = "atlas/1";
const FALLBACK_EVENT_ID = "00000000000000000000000000000001";
const FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/i;
const BUN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
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
const SAFE_ARCHITECTURES = new Set([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
]);
const SAFE_PLATFORMS = new Set([
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
]);
const SAFE_SOURCES = new Set([
  "server",
  "server.profile-portability.export",
  "server.profile-portability.import",
  "server.profile-portability.preview",
  "test",
  "unknown",
  "worker:automation",
  "worker:discord",
  "worker:telegram",
  "worker:whatsapp",
]);

export interface SentryDsn {
  endpoint: string;
  publicKey: string;
}

export interface SentryEvent {
  contexts: {
    os: { name: string };
    runtime: { name: string; version: string };
  };
  event_id: string;
  exception: { values: Array<{ type: string; value: string }> };
  extra?: { stack: string };
  fingerprint: string[];
  level: "error" | "info";
  logger: string;
  platform: string;
  tags: {
    api_version: string;
    arch: string;
    bun: string;
    kind: ErrorReportKind;
    os: string;
    source: string;
  };
  timestamp: string;
}

export function parseSentryDsn(dsn: string): SentryDsn | null {
  const trimmed = dsn.trim();

  if (!trimmed) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (!(url.protocol === "http:" || url.protocol === "https:")) {
    return null;
  }

  const publicKey = url.username;
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();

  if (!(publicKey && projectId)) {
    return null;
  }

  const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";

  return {
    endpoint: `${url.protocol}//${url.host}${prefix}/api/${projectId}/store/`,
    publicKey,
  };
}

export function toSentryEvent(report: ErrorReport): SentryEvent {
  const safeSource = SAFE_SOURCES.has(report.source)
    ? report.source
    : "unknown";
  const safeErrorName = SAFE_ERROR_NAMES.has(report.name)
    ? report.name
    : "Error";
  const safeFingerprint = FINGERPRINT_PATTERN.test(report.fingerprint)
    ? report.fingerprint.toLowerCase()
    : "unknown";
  let safeEventId = FALLBACK_EVENT_ID;
  if (EVENT_ID_PATTERN.test(report.id)) {
    safeEventId = report.id.replace(/-/g, "").toLowerCase();
  } else if (FINGERPRINT_PATTERN.test(safeFingerprint)) {
    safeEventId = safeFingerprint;
  }
  const safePlatform = SAFE_PLATFORMS.has(report.runtime.platform)
    ? report.runtime.platform
    : "unknown";
  const safeArchitecture = SAFE_ARCHITECTURES.has(report.runtime.arch)
    ? report.runtime.arch
    : "unknown";
  const safeBunVersion = BUN_VERSION_PATTERN.test(report.runtime.bun)
    ? report.runtime.bun
    : "unknown";
  const safeApiVersion =
    Number.isSafeInteger(report.runtime.apiVersion) &&
    report.runtime.apiVersion >= 0 &&
    report.runtime.apiVersion <= 9999
      ? String(report.runtime.apiVersion)
      : "unknown";
  let safeTimestamp = FALLBACK_TIMESTAMP;
  try {
    if (new Date(report.at).toISOString() === report.at) {
      safeTimestamp = report.at;
    }
  } catch {
    // Invalid or attacker-modified queue metadata must fail closed.
  }

  return {
    contexts: {
      os: { name: safePlatform },
      runtime: { name: "bun", version: safeBunVersion },
    },
    event_id: safeEventId,
    exception: {
      values: [
        {
          type: safeErrorName,
          value: `Atlas ${report.kind} error (${safeFingerprint})`,
        },
      ],
    },
    fingerprint: [safeFingerprint],
    level: report.kind === "test" ? "info" : "error",
    logger: "atlas",
    platform: "node",
    tags: {
      api_version: safeApiVersion,
      arch: safeArchitecture,
      bun: safeBunVersion,
      kind: report.kind,
      os: safePlatform,
      source: safeSource,
    },
    timestamp: safeTimestamp,
  };
}

export async function sendSentryEvent(
  dsn: SentryDsn,
  event: SentryEvent,
  timeoutMs = SEND_TIMEOUT_MS
): Promise<boolean> {
  const deadlineMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
  const abortController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = (async (): Promise<boolean> => {
    try {
      const response = await fetch(dsn.endpoint, {
        body: JSON.stringify(event),
        headers: {
          "Content-Type": "application/json",
          "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=${SENTRY_CLIENT}, sentry_key=${dsn.publicKey}`,
        },
        method: "POST",
        signal: abortController.signal,
      });
      return response.ok;
    } catch {
      return false;
    }
  })();
  const deadline = new Promise<boolean>((resolve) => {
    timeout = setTimeout(() => {
      abortController.abort();
      resolve(false);
    }, deadlineMs);
  });

  try {
    return await Promise.race([request, deadline]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export function createErrorTrackingSink(): ErrorSink {
  return async (report) => {
    const config = await loadErrorTrackingConfig();
    const dsn = parseSentryDsn(resolveErrorTrackingDsn(config) ?? "");

    if (!dsn) {
      return false;
    }

    return await sendSentryEvent(dsn, toSentryEvent(report));
  };
}

export async function installErrorTrackingSink(): Promise<void> {
  setErrorSink(createErrorTrackingSink());
  await refreshErrorTrackingEnabled();
}
