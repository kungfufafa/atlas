import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildErrorReport,
  type ErrorReport,
  fingerprintError,
  flushPendingErrorReports,
  installErrorHandlers,
  refreshErrorTrackingEnabled,
  reportError,
  setErrorSink,
} from "./error-tracking";
import {
  getErrorTrackingConfigDir,
  getErrorTrackingFingerprintKeyPath,
  saveErrorTrackingDsn,
} from "./error-tracking-config";
import {
  getPendingErrorReportsPath,
  MAX_PENDING_ERROR_REPORTS,
  readPendingErrorReports,
} from "./error-tracking-queue";
import { SYNTHETIC_SECRET_FIXTURES } from "./testing/synthetic-secret-fixtures";

const DSN = "https://public-key@errors.example.com/7";

let configDir = "";
let previousConfigDir: string | undefined;
let previousDsn: string | undefined;
let previousDoNotTrack: string | undefined;
let consoleErrorCalls: unknown[][] = [];
const realConsoleError = console.error;

beforeEach(async () => {
  previousConfigDir = process.env.ATLAS_CONFIG_DIR;
  previousDsn = process.env.ATLAS_ERROR_TRACKING_DSN;
  previousDoNotTrack = process.env.DO_NOT_TRACK;
  configDir = await mkdtemp(join(tmpdir(), "atlas-error-report-"));
  process.env.ATLAS_CONFIG_DIR = configDir;
  delete process.env.ATLAS_ERROR_TRACKING_DSN;
  delete process.env.DO_NOT_TRACK;
  await saveErrorTrackingDsn(DSN);
  await refreshErrorTrackingEnabled();
  consoleErrorCalls = [];
  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };
});

afterEach(async () => {
  console.error = realConsoleError;
  setErrorSink(null);
  await saveErrorTrackingDsn(null);
  await refreshErrorTrackingEnabled();
  restoreEnv("ATLAS_CONFIG_DIR", previousConfigDir);
  restoreEnv("ATLAS_ERROR_TRACKING_DSN", previousDsn);
  restoreEnv("DO_NOT_TRACK", previousDoNotTrack);
  await rm(configDir, { force: true, recursive: true });
});

test("the same bug fingerprints identically across IDs and line numbers", () => {
  const first = fingerprintError(
    "TypeError",
    "profile prof_01JABCDEF23 not found after 30000ms",
    "TypeError\n    at resolveProfile (~/src/profiles.ts:12:3)"
  );
  const second = fingerprintError(
    "TypeError",
    "profile prof_01JXYZGHI45 not found after 45000ms",
    "TypeError\n    at resolveProfile (~/src/profiles.ts:48:9)"
  );

  expect(first).toBe(second);
});

test("unrelated failures keep distinct private fingerprints", () => {
  const database = fingerprintError(
    "Error",
    "database page is corrupt",
    "Error\n    at loadDatabase (~/src/database.ts:12:3)"
  );
  const provider = fingerprintError(
    "Error",
    "provider request timed out",
    "Error\n    at requestProvider (~/src/provider.ts:12:3)"
  );

  expect(database).not.toBe(provider);
});

test("the installation fingerprint key is private and never enters reports", async () => {
  const fingerprint = fingerprintError(
    "Error",
    "database page is corrupt",
    "Error\n    at loadDatabase (~/src/database.ts:12:3)"
  );
  const keyPath = getErrorTrackingFingerprintKeyPath();
  const encodedKey = (await readFile(keyPath, "utf8")).trim();
  const report = buildErrorReport(new Error("database page is corrupt"), {
    source: "server",
  });

  expect(fingerprint).toHaveLength(32);
  expect(encodedKey).toMatch(/^[0-9a-f]{64}$/);
  expect(
    (await stat(getErrorTrackingConfigDir())).mode.toString(8).slice(-3)
  ).toBe("700");
  expect((await stat(keyPath)).mode.toString(8).slice(-3)).toBe("600");
  expect(JSON.stringify(report)).not.toContain(encodedKey);
});

test("fingerprints cannot verify tenant data embedded in error names", () => {
  const first = fingerprintError("Tenant alice@example.com");
  const second = fingerprintError("Tenant bob@example.com");

  expect(first).toBe(second);
});

test("the report scrubs message, custom error name, stack, and source", () => {
  const error = new Error(
    `auth failed with ${SYNTHETIC_SECRET_FIXTURES.anthropicApiKey}`
  );
  error.name = "Failure for alice@example.com";
  const report = buildErrorReport(error, {
    source: "worker for owner@example.com",
  });
  const serialized = JSON.stringify(report);

  expect(serialized).not.toContain("sk-ant-api03");
  expect(serialized).not.toContain("alice@example.com");
  expect(serialized).not.toContain("owner@example.com");
  expect(report.runtime.bun).toBe(Bun.version);
});

test("a successful sink receives the event and removes its queue file", async () => {
  const delivered: ErrorReport[] = [];
  setErrorSink((report) => {
    delivered.push(report);
    return true;
  });

  await reportError(new Error("boom"), { source: "server" });

  expect(delivered).toHaveLength(1);
  expect(readPendingErrorReports()).toHaveLength(0);
  expect(consoleErrorCalls).toHaveLength(1);
});

test("hostile Error proxies cannot break crash reporting", async () => {
  const hostileError = new Proxy(new Error("hidden"), {
    get() {
      throw new Error("getter exploded");
    },
  });
  const hostileValue = new Proxy(
    {},
    {
      get() {
        throw new Error("value getter exploded");
      },
      getOwnPropertyDescriptor() {
        throw new Error("descriptor exploded");
      },
      getPrototypeOf() {
        throw new Error("prototype exploded");
      },
      ownKeys() {
        throw new Error("keys exploded");
      },
    }
  );

  await expect(
    reportError(hostileError, { source: "server" })
  ).resolves.toMatchObject({
    name: "Error",
  });
  await expect(
    reportError(hostileValue, { source: "server" })
  ).resolves.toMatchObject({
    message: "Unprintable non-Error rejection",
    name: "NonError",
  });
});

test("failed delivery stays queued and a later flush removes it", async () => {
  setErrorSink(() => false);
  const report = await reportError(new Error("ingest down"), {
    source: "worker:automation",
  });

  expect(readPendingErrorReports().map((entry) => entry.id)).toEqual([
    report.id,
  ]);

  setErrorSink(() => true);
  expect(await flushPendingErrorReports()).toBe(1);
  expect(readPendingErrorReports()).toHaveLength(0);
});

test("the per-event queue is private and retains only the newest reports", async () => {
  setErrorSink(() => false);
  await mkdir(getPendingErrorReportsPath(), { mode: 0o755, recursive: true });
  await chmod(getPendingErrorReportsPath(), 0o755);

  for (let index = 0; index < MAX_PENDING_ERROR_REPORTS + 3; index += 1) {
    await reportError(new Error(`boom ${index}`), { source: "server" });
  }

  const reports = readPendingErrorReports();
  const files = await readdir(getPendingErrorReportsPath());

  expect(reports).toHaveLength(MAX_PENDING_ERROR_REPORTS);
  expect(reports.at(-1)?.message).toContain(
    `boom ${MAX_PENDING_ERROR_REPORTS + 2}`
  );
  expect(files).toHaveLength(MAX_PENDING_ERROR_REPORTS);
  expect(
    (await stat(getPendingErrorReportsPath())).mode.toString(8).slice(-3)
  ).toBe("700");
  expect(
    (await stat(join(getPendingErrorReportsPath(), files[0]!))).mode
      .toString(8)
      .slice(-3)
  ).toBe("600");
});

test("a corrupt queue entry does not block valid reports", async () => {
  setErrorSink(() => false);
  await reportError(new Error("valid"), { source: "server" });
  await mkdir(getPendingErrorReportsPath(), { recursive: true });
  await writeFile(
    join(getPendingErrorReportsPath(), "corrupt.json"),
    "{not json",
    "utf8"
  );

  expect(readPendingErrorReports()).toHaveLength(1);
});

test("with no DSN configured nothing is written or delivered", async () => {
  await saveErrorTrackingDsn(null);
  await refreshErrorTrackingEnabled();
  let deliveries = 0;
  setErrorSink(() => {
    deliveries += 1;
    return true;
  });

  await reportError(new Error("local only"), { source: "server" });

  expect(deliveries).toBe(0);
  expect(existsSync(getPendingErrorReportsPath())).toBe(false);
});

test("process handlers can be cleanly uninstalled", () => {
  const fatalBefore = process.listenerCount("uncaughtException");
  const uncaughtBefore = process.listenerCount("uncaughtExceptionMonitor");
  const rejectionBefore = process.listenerCount("unhandledRejection");
  const uninstall = installErrorHandlers("test");

  expect(process.listenerCount("uncaughtException")).toBe(fatalBefore);
  expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(
    uncaughtBefore + 1
  );
  expect(process.listenerCount("unhandledRejection")).toBe(rejectionBefore + 1);

  uninstall();

  expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(
    uncaughtBefore
  );
  expect(process.listenerCount("uncaughtException")).toBe(fatalBefore);
  expect(process.listenerCount("unhandledRejection")).toBe(rejectionBefore);
});

test("an unhandled rejection exits with failure after reporting", async () => {
  const rejectionBefore = new Set(process.listeners("unhandledRejection"));
  const exitSpy = spyOn(process, "exit").mockImplementation(
    (() => undefined as never) as typeof process.exit
  );
  const uninstall = installErrorHandlers("worker:test");

  try {
    const onRejection = process
      .listeners("unhandledRejection")
      .find((listener) => !rejectionBefore.has(listener));

    expect(onRejection).toBeDefined();
    onRejection?.(new Error("worker failed"), Promise.resolve());
    await Promise.resolve();

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  } finally {
    uninstall();
    exitSpy.mockRestore();
  }
});

test("a stuck error sink cannot prevent an unhandled rejection exit", async () => {
  setErrorSink(() => new Promise<boolean>(() => {}));
  const rejectionBefore = new Set(process.listeners("unhandledRejection"));
  const exitSpy = spyOn(process, "exit").mockImplementation(
    (() => undefined as never) as typeof process.exit
  );
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: TimerHandler
  ) => {
    queueMicrotask(() => {
      if (typeof callback === "function") {
        callback();
      }
    });
    return undefined as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const uninstall = installErrorHandlers("worker:test");

  try {
    const onRejection = process
      .listeners("unhandledRejection")
      .find((listener) => !rejectionBefore.has(listener));

    expect(onRejection).toBeDefined();
    onRejection?.(new Error("worker failed"), Promise.resolve());
    await Promise.resolve();

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 3500);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  } finally {
    uninstall();
    timeoutSpy.mockRestore();
    exitSpy.mockRestore();
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
