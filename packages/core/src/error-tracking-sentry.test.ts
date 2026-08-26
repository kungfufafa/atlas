import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { buildErrorReport, type ErrorReport } from "./error-tracking";
import {
  createErrorTrackingSink,
  parseSentryDsn,
  sendSentryEvent,
  toSentryEvent,
} from "./error-tracking-sentry";
import { SYNTHETIC_SECRET_FIXTURES } from "./testing/synthetic-secret-fixtures";

let configDir = "";
let previousConfigDir: string | undefined;
let previousDsn: string | undefined;
let previousDoNotTrack: string | undefined;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  previousConfigDir = process.env.ATLAS_CONFIG_DIR;
  previousDsn = process.env.ATLAS_ERROR_TRACKING_DSN;
  previousDoNotTrack = process.env.DO_NOT_TRACK;
  configDir = await mkdtemp(join(tmpdir(), "atlas-sentry-test-"));
  process.env.ATLAS_CONFIG_DIR = configDir;
  delete process.env.ATLAS_ERROR_TRACKING_DSN;
  delete process.env.DO_NOT_TRACK;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  restoreEnv("ATLAS_CONFIG_DIR", previousConfigDir);
  restoreEnv("ATLAS_ERROR_TRACKING_DSN", previousDsn);
  restoreEnv("DO_NOT_TRACK", previousDoNotTrack);
  await rm(configDir, { force: true, recursive: true });
});

function sampleReport(): ErrorReport {
  return buildErrorReport(new Error("tool loop exceeded"), {
    source: "server",
  });
}

test("parseSentryDsn builds a credential-free store endpoint", () => {
  const parsed = parseSentryDsn(
    "https://public-key:legacy-secret@errors.example.com/sentry/7"
  );

  expect(parsed).toEqual({
    endpoint: "https://errors.example.com/sentry/api/7/store/",
    publicKey: "public-key",
  });
  expect(JSON.stringify(parsed)).not.toContain("legacy-secret");
});

test("parseSentryDsn rejects malformed and non-HTTP DSNs", () => {
  expect(parseSentryDsn("")).toBeNull();
  expect(parseSentryDsn("not a url")).toBeNull();
  expect(parseSentryDsn("ftp://key@example.com/7")).toBeNull();
  expect(parseSentryDsn("https://example.com/7")).toBeNull();
});

test("the event is anonymous, host-free, branded, and stable across retries", () => {
  const report = sampleReport();
  const event = toSentryEvent(report);

  expect(event.event_id).toBe(report.id.replace(/-/g, ""));
  expect(event.fingerprint).toEqual([report.fingerprint]);
  expect(event.logger).toBe("atlas");
  expect(event).not.toHaveProperty("server_name");
  expect(event).not.toHaveProperty("user");
  expect(JSON.stringify(event)).not.toContain(hostname());
});

test("the wire event never includes raw messages, stacks, tenant names, or URLs", () => {
  const error = new Error(
    "Customer Budi failed at http://tenant.internal/path with cookie=session-secret"
  );
  error.name = "BudiTenantError";
  const report = buildErrorReport(error, { source: "worker for Budi" });
  const serialized = JSON.stringify(toSentryEvent(report));

  expect(serialized).not.toContain("Budi");
  expect(serialized).not.toContain("tenant.internal");
  expect(serialized).not.toContain("session-secret");
  expect(serialized).not.toContain("stack");
  expect(serialized).toContain(report.fingerprint);
});

test("the wire event fails closed when queued metadata is attacker-modified", () => {
  const secret = SYNTHETIC_SECRET_FIXTURES.openAiProjectApiKey;
  const report: ErrorReport = {
    ...sampleReport(),
    at: secret,
    fingerprint: secret,
    id: secret,
    name: secret,
    runtime: {
      apiVersion: Number.MAX_SAFE_INTEGER,
      arch: secret,
      bun: secret,
      platform: secret,
    },
    source: secret,
  };
  const event = toSentryEvent(report);
  const serialized = JSON.stringify(event);

  expect(serialized).not.toContain(secret);
  expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
  expect(event.fingerprint).toEqual(["unknown"]);
  expect(event.tags).toMatchObject({
    api_version: "unknown",
    arch: "unknown",
    bun: "unknown",
    os: "unknown",
    source: "unknown",
  });
  expect(event.timestamp).toBe("1970-01-01T00:00:00.000Z");
});

test("wire fingerprints do not reveal secret or tenant-specific error text", () => {
  const firstError = new Error(
    "sk-secret-one failed at https://tenant-a.example/private"
  );
  firstError.name = "TenantAError";
  firstError.stack =
    "TenantAError\n    at resolveProvider (/srv/provider.ts:12:3)";
  const secondError = new Error(
    "sk-secret-two failed at https://tenant-b.example/private"
  );
  secondError.name = "TenantBError";
  secondError.stack =
    "TenantBError\n    at resolveProvider (/srv/provider.ts:92:7)";

  const first = toSentryEvent(buildErrorReport(firstError));
  const second = toSentryEvent(buildErrorReport(secondError));

  expect(first.fingerprint).toEqual(second.fingerprint);
});

test("sendSentryEvent posts the expected event and public auth key", async () => {
  let received: { init?: RequestInit; input?: RequestInfo | URL } = {};
  globalThis.fetch = async (input, init) => {
    received = { init, input };
    return new Response("{}", { status: 200 });
  };
  const dsn = parseSentryDsn("https://public-key@errors.example.com/42");
  const event = toSentryEvent(sampleReport());

  expect(dsn).not.toBeNull();
  expect(await sendSentryEvent(dsn!, event)).toBe(true);
  expect(received.input).toBe("https://errors.example.com/api/42/store/");
  expect(received.init?.method).toBe("POST");
  const headers = new Headers(received.init?.headers);
  expect(headers.get("x-sentry-auth")).toContain("sentry_client=atlas/1");
  expect(headers.get("x-sentry-auth")).toContain("sentry_key=public-key");
  expect(JSON.parse(String(received.init?.body))).toEqual(event);
});

test("sendSentryEvent keeps its deadline when fetch ignores abort", async () => {
  let receivedSignal: AbortSignal | null = null;
  globalThis.fetch = async (_input, init) => {
    receivedSignal = init?.signal ?? null;
    return await new Promise<Response>(() => {
      // A non-compliant transport may never settle even after abort.
    });
  };
  const dsn = parseSentryDsn("https://public-key@errors.example.com/42");
  const event = toSentryEvent(sampleReport());
  let guardTimeout: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<"hung">((resolve) => {
    guardTimeout = setTimeout(() => resolve("hung"), 500);
  });

  expect(dsn).not.toBeNull();
  const result = await Promise.race([sendSentryEvent(dsn!, event, 20), guard]);
  if (guardTimeout !== undefined) {
    clearTimeout(guardTimeout);
  }

  expect(result).toBe(false);
  expect(receivedSignal?.aborted).toBe(true);
});

test("the sink performs no request when DO_NOT_TRACK is enabled", async () => {
  let hits = 0;
  globalThis.fetch = async () => {
    hits += 1;
    return new Response("{}", { status: 200 });
  };
  process.env.ATLAS_ERROR_TRACKING_DSN =
    "https://public-key@errors.example.com/1";
  process.env.DO_NOT_TRACK = "1";

  expect(await createErrorTrackingSink()(sampleReport())).toBe(false);
  expect(hits).toBe(0);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
