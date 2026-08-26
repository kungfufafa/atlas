import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildErrorReport, type ErrorReport } from "./error-tracking";
import { getErrorTrackingConfigDir } from "./error-tracking-config";
import {
  appendPendingErrorReport,
  getPendingErrorReportsPath,
  readPendingErrorReports,
} from "./error-tracking-queue";

let configDir = "";
let previousConfigDir: string | undefined;

beforeEach(async () => {
  previousConfigDir = process.env.ATLAS_CONFIG_DIR;
  configDir = await mkdtemp(join(tmpdir(), "atlas-error-queue-"));
  process.env.ATLAS_CONFIG_DIR = configDir;
});

afterEach(async () => {
  restoreEnv("ATLAS_CONFIG_DIR", previousConfigDir);
  await rm(configDir, { force: true, recursive: true });
});

test("queue writes are private, bounded records with redaction reapplied", async () => {
  const secret = "correct horse battery staple";
  const report = {
    ...buildErrorReport(new Error("safe"), { source: "server" }),
    message: `password='${secret}'`,
    unexpected: secret,
  } as ErrorReport;

  appendPendingErrorReport(report);

  const files = await readdir(getPendingErrorReportsPath());
  const serialized = await readFile(
    join(getPendingErrorReportsPath(), files[0]!),
    "utf8"
  );
  const queued = readPendingErrorReports();

  expect(files).toHaveLength(1);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("unexpected");
  expect(queued).toHaveLength(1);
  expect(queued[0]).not.toHaveProperty("unexpected");
  expect(
    (await stat(getPendingErrorReportsPath())).mode.toString(8).slice(-3)
  ).toBe("700");
  expect(
    (await stat(join(getPendingErrorReportsPath(), files[0]!))).mode
      .toString(8)
      .slice(-3)
  ).toBe("600");
});

test("queue refuses a symlinked pending directory", async () => {
  const outsideDirectory = await mkdtemp(join(tmpdir(), "atlas-queue-target-"));
  await mkdir(getErrorTrackingConfigDir(), { recursive: true });
  await symlink(outsideDirectory, getPendingErrorReportsPath(), "dir");
  const originalConsoleError = console.error;
  console.error = () => {
    // The queue is deliberately best-effort during a crash.
  };

  try {
    appendPendingErrorReport(
      buildErrorReport(new Error("must stay local"), { source: "server" })
    );
  } finally {
    console.error = originalConsoleError;
  }

  expect(await readdir(outsideDirectory)).toHaveLength(0);
  expect(readPendingErrorReports()).toHaveLength(0);
  await rm(outsideDirectory, { force: true, recursive: true });
});

test("invalid and oversized entries are discarded without blocking valid reports", async () => {
  const valid = buildErrorReport(new Error("valid"), { source: "server" });
  appendPendingErrorReport(valid);
  await writeFile(
    join(getPendingErrorReportsPath(), "corrupt.json"),
    "{not json",
    { mode: 0o644 }
  );
  await writeFile(
    join(getPendingErrorReportsPath(), "oversized.json"),
    "x".repeat(33 * 1024),
    { mode: 0o644 }
  );

  expect(readPendingErrorReports().map((report) => report.id)).toEqual([
    valid.id,
  ]);
  expect(await readdir(getPendingErrorReportsPath())).toHaveLength(1);
});

test("existing valid entries have private permissions restored before use", async () => {
  const report = buildErrorReport(new Error("valid"), { source: "server" });
  const pendingPath = getPendingErrorReportsPath();
  const reportPath = join(pendingPath, "manual.json");
  await mkdir(pendingPath, { mode: 0o755, recursive: true });
  await writeFile(reportPath, JSON.stringify(report), { mode: 0o644 });
  await chmod(pendingPath, 0o755);
  await chmod(reportPath, 0o644);

  expect(readPendingErrorReports()).toHaveLength(1);
  expect((await stat(pendingPath)).mode.toString(8).slice(-3)).toBe("700");
  expect((await stat(reportPath)).mode.toString(8).slice(-3)).toBe("600");
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
